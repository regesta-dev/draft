import {
  canonicalJson,
  defaultPackageChannel,
  parsePackageId,
  sha256,
  type ObjectDescriptor,
  type PackageId,
  type PublishReleaseEvent,
  type RegistryEvent,
  type ReleaseManifest,
} from '@regesta/protocol'
import type { RegistryAdapters } from '@regesta/adapters'

export interface ReleaseVerifier {
  verify: (
    adapters: RegistryAdapters,
    packageId: PackageId,
    version: string,
  ) => Promise<VerificationResult>
}

export interface VerificationResult {
  manifest: ReleaseManifest
  ok: boolean
  problems: string[]
}

export const defaultReleaseVerifier: ReleaseVerifier = {
  verify: verifyRelease,
}

export async function verifyRelease(
  adapters: RegistryAdapters,
  packageId: PackageId,
  version: string,
): Promise<VerificationResult> {
  const problems: string[] = []
  const release = await adapters.database.getRelease(packageId, version)

  if (!release) {
    return {
      manifest: undefined as never,
      ok: false,
      problems: [`Release not found: ${packageId}@${version}`],
    }
  }

  const manifestBytes = new TextEncoder().encode(
    `${canonicalJson(release.manifest as never)}\n`,
  )

  if (sha256(manifestBytes) !== release.manifestDescriptor.digest) {
    problems.push('Release manifest digest does not match stored descriptor')
  }

  problems.push(
    ...verifyPublishEvent(
      release.event,
      release.manifest,
      release.manifestDescriptor,
    ),
  )

  const eventLog = await adapters.database.getEventLog()
  const hasPublishEvent = eventLog.some(
    (event) =>
      canonicalJson(event as never) === canonicalJson(release.event as never),
  )

  if (hasPublishEvent === false) {
    problems.push('Publish event is missing from the append-only event log')
  }

  const source = await adapters.objects.get(release.manifest.source.digest)
  if (source) {
    problems.push(
      ...verifyStoredObject('Source', release.manifest.source, source),
    )
  } else {
    problems.push(`Source object missing: ${release.manifest.source.digest}`)
  }

  for (const artifact of release.manifest.artifacts) {
    const object = await adapters.objects.get(artifact.digest)
    if (object) {
      problems.push(
        ...verifyStoredObject(`Artifact ${artifact.role}`, artifact, object),
      )
    } else {
      problems.push(`Artifact object missing: ${artifact.digest}`)
    }
  }

  problems.push(
    ...verifyManifestIdentity(release.manifest),
    ...verifyProvenance(release.manifest),
  )

  return {
    manifest: release.manifest,
    ok: problems.length === 0,
    problems,
  }
}

function verifyManifestIdentity(manifest: ReleaseManifest): string[] {
  const parsed = parsePackageId(manifest.id)
  const problems: string[] = []
  const installArtifacts = manifest.artifacts.filter((artifact) => {
    return artifact.role === 'install'
  })

  if (manifest.object !== 'regesta.release-manifest') {
    problems.push('Release manifest object must be regesta.release-manifest')
  }

  if (manifest.specVersion !== 0) {
    problems.push('Release manifest specVersion must be 0')
  }

  if (manifest.ecosystem !== parsed.ecosystem) {
    problems.push('Release manifest ecosystem does not match package id')
  }

  if (manifest.name !== parsed.name) {
    problems.push('Release manifest name does not match package id')
  }

  if (installArtifacts.length !== 1) {
    problems.push('Release manifest must include exactly one install artifact')
  }

  return problems
}

function verifyProvenance(manifest: ReleaseManifest): string[] {
  const { provenance } = manifest
  const problems: string[] = []

  if (provenance.level !== 'source-attached') {
    problems.push('Release provenance must be source-attached')
  }

  if (provenance.verified !== false) {
    problems.push('V0 release provenance must not claim verified build status')
  }

  return problems
}

function verifyPublishEvent(
  event: RegistryEvent,
  manifest: ReleaseManifest,
  manifestDescriptor: ObjectDescriptor,
): string[] {
  const problems: string[] = []
  const expectedEvent = {
    ...(event.authorization ? { authorization: event.authorization } : {}),
    artifactDigests: manifest.artifacts.map((artifact) => artifact.digest),
    channel: defaultPackageChannel,
    eventType: 'release.published',
    object: 'regesta.event',
    release: {
      id: manifest.id,
      manifestDigest: manifestDescriptor.digest,
      version: manifest.version,
    },
    sourceDigest: manifest.source.digest,
    specVersion: 0,
    timestamp: manifest.createdAt,
  } satisfies Omit<PublishReleaseEvent, 'id'>

  if (event.id !== sha256(canonicalJson(expectedEvent as never))) {
    problems.push('Publish event id does not match canonical event payload')
  }

  if (event.eventType !== 'release.published') {
    problems.push('Publish event must have eventType release.published')
    return problems
  }

  if (event.channel !== defaultPackageChannel) {
    problems.push(`Publish event channel must be ${defaultPackageChannel}`)
  }

  if (event.release.manifestDigest !== manifestDescriptor.digest) {
    problems.push(
      'Publish event manifest digest does not match stored descriptor',
    )
  }

  if (event.release.id !== manifest.id) {
    problems.push('Publish event package id does not match release manifest')
  }

  if (event.release.version !== manifest.version) {
    problems.push('Publish event version does not match release manifest')
  }

  if (event.sourceDigest !== manifest.source.digest) {
    problems.push('Publish event source digest does not match release manifest')
  }

  if (
    canonicalJson(event.artifactDigests as never) !==
    canonicalJson(expectedEvent.artifactDigests as never)
  ) {
    problems.push(
      'Publish event artifact digests do not match release manifest',
    )
  }

  if (event.timestamp !== manifest.createdAt) {
    problems.push('Publish event timestamp does not match release manifest')
  }

  return problems
}

function verifyStoredObject(
  label: string,
  expected: ObjectDescriptor,
  actual: { bytes: Uint8Array; descriptor: ObjectDescriptor },
): string[] {
  const problems: string[] = []

  if (actual.descriptor.digest !== expected.digest) {
    problems.push(
      `${label} object descriptor digest mismatch: ${expected.digest}`,
    )
  }

  if (actual.descriptor.size !== expected.size) {
    problems.push(`${label} object size mismatch: ${expected.digest}`)
  }

  if (actual.descriptor.mediaType !== expected.mediaType) {
    problems.push(`${label} object media type mismatch: ${expected.digest}`)
  }

  if (sha256(actual.bytes) !== expected.digest) {
    problems.push(`${label} object bytes digest mismatch: ${expected.digest}`)
  }

  return problems
}
