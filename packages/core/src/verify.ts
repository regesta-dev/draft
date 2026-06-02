import {
  canonicalJson,
  sha256,
  type ObjectDescriptor,
  type RegistryEvent,
  type ReleaseManifest,
} from '@regesta/protocol'
import {
  createNpmPackument,
  integrityFromDigest,
  tarballUrl,
} from './packument.ts'
import type { RegistryAdapters } from '@regesta/adapters'

export interface ReleaseVerifier {
  verify: (
    adapters: RegistryAdapters,
    coordinate: `@${string}/${string}`,
    version: string,
    options?: VerifyReleaseOptions,
  ) => Promise<VerificationResult>
}

export interface VerificationResult {
  manifest: ReleaseManifest
  ok: boolean
  problems: string[]
}

export interface VerifyReleaseOptions {
  registryBaseUrl?: string
}

export const defaultReleaseVerifier: ReleaseVerifier = {
  verify: verifyRelease,
}

export async function verifyRelease(
  adapters: RegistryAdapters,
  coordinate: `@${string}/${string}`,
  version: string,
  options: VerifyReleaseOptions = {},
): Promise<VerificationResult> {
  const problems: string[] = []
  const release = await adapters.database.getRelease(coordinate, version)

  if (!release) {
    return {
      manifest: undefined as never,
      ok: false,
      problems: [`Release not found: ${coordinate}@${version}`],
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

  const npmTarballDescriptor = release.manifest.artifacts.npmTarball
  const npmTarball = await adapters.objects.get(npmTarballDescriptor.digest)
  if (npmTarball) {
    problems.push(
      ...verifyStoredObject('npm tarball', npmTarballDescriptor, npmTarball),
    )
  } else {
    problems.push(`npm tarball object missing: ${npmTarballDescriptor.digest}`)
  }

  problems.push(
    ...verifyProvenance(release.manifest),
    ...verifyNpmProjection(
      await adapters.database.listPackageReleases(coordinate),
      release.manifest,
      options.registryBaseUrl ?? 'https://registry.regesta.local',
    ),
  )

  return {
    manifest: release.manifest,
    ok: problems.length === 0,
    problems,
  }
}

function verifyNpmProjection(
  releases: Array<{ manifest: ReleaseManifest }>,
  manifest: ReleaseManifest,
  registryBaseUrl: string,
): string[] {
  const packument = createNpmPackument(
    manifest.package,
    releases,
    registryBaseUrl,
  )
  const version = packument.versions[manifest.version]

  if (!version) {
    return [`npm packument projection is missing ${manifest.version}`]
  }

  const problems: string[] = []
  const expectedIntegrity = integrityFromDigest(
    manifest.artifacts.npmTarball.digest,
  )
  const expectedTarball = tarballUrl(
    manifest.package,
    manifest.version,
    registryBaseUrl,
  )

  if (version.dist.integrity !== expectedIntegrity) {
    problems.push('npm packument integrity does not match manifest artifact')
  }

  if (version.dist.tarball !== expectedTarball) {
    problems.push(
      'npm packument tarball URL does not match manifest artifact path',
    )
  }

  return problems
}

function verifyProvenance(manifest: ReleaseManifest): string[] {
  const { provenance } = manifest
  const problems: string[] = []

  if (
    provenance.level !== 'source-attached' &&
    provenance.level !== 'declared-build'
  ) {
    problems.push(
      'Release provenance must be source-attached or declared-build',
    )
  }

  if (provenance.verified !== false) {
    problems.push('V0 release provenance must not claim verified build status')
  }

  if (provenance.level === 'declared-build' && !provenance.command) {
    problems.push('Declared-build provenance must include a build command')
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
    manifestDigest: manifestDescriptor.digest,
    package: manifest.package,
    schema: 'regesta.event.v0',
    sourceDigest: manifest.source.digest,
    timestamp: manifest.createdAt,
    type: 'PUBLISH_RELEASE',
    version: manifest.version,
  } satisfies Omit<RegistryEvent, 'id'>

  if (event.id !== sha256(canonicalJson(expectedEvent as never))) {
    problems.push('Publish event id does not match canonical event payload')
  }

  if (event.manifestDigest !== manifestDescriptor.digest) {
    problems.push(
      'Publish event manifest digest does not match stored descriptor',
    )
  }

  if (event.package !== manifest.package) {
    problems.push('Publish event package does not match release manifest')
  }

  if (event.version !== manifest.version) {
    problems.push('Publish event version does not match release manifest')
  }

  if (event.sourceDigest !== manifest.source.digest) {
    problems.push('Publish event source digest does not match release manifest')
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
