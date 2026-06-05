import {
  canonicalJson,
  defaultPackageChannel,
  parsePackageId,
  sha256,
  type ObjectDescriptor,
  type PublishReleaseEvent,
  type RegestaConfig,
  type RegistryEvent,
  type ReleaseArtifact,
  type ReleaseEcosystemMetadata,
  type ReleaseManifest,
  type ReleaseMetadata,
  type ReleaseProvenance,
  type WriteAuthorizationProof,
} from '@regesta/protocol'
import { configDigest, normalizeRegestaConfig } from './config.ts'
import type { RegistryAdapters, StoredRelease } from '@regesta/adapters'

export interface PublishArtifactInput {
  bytes: Uint8Array
  ecosystem?: ReleaseArtifact['ecosystem']
  filename?: string
  format?: string
  mediaType: string
  role: string
}

export interface PublishInput {
  authorization?: WriteAuthorizationProof
  artifacts: PublishArtifactInput[]
  config: unknown
  createdAt?: string
  ecosystemMetadata?: ReleaseEcosystemMetadata
  source: Uint8Array
}

export interface PublishResult {
  channel: string
  event: RegistryEvent
  manifest: ReleaseManifest
  manifestDescriptor: ObjectDescriptor
}

export async function publishRelease(
  input: PublishInput,
  adapters: RegistryAdapters,
): Promise<PublishResult> {
  const config = normalizeRegestaConfig(input.config)
  const channel = defaultPackageChannel
  parsePackageId(config.id)
  validatePublishArtifacts(input.artifacts)

  if (await adapters.database.getRelease(config.id, config.version)) {
    throw new Error(`Release already exists: ${config.id}@${config.version}`)
  }

  const source = await adapters.objects.put(
    input.source,
    'application/vnd.regesta.source-archive+tgz',
  )
  const artifacts = await Promise.all(
    input.artifacts.map(async (artifact) => {
      const descriptor = await adapters.objects.put(
        artifact.bytes,
        artifact.mediaType,
      )

      return {
        ...descriptor,
        ...(artifact.ecosystem ? { ecosystem: artifact.ecosystem } : {}),
        ...(artifact.filename ? { filename: artifact.filename } : {}),
        ...(artifact.format ? { format: artifact.format } : {}),
        role: artifact.role,
      } satisfies ReleaseArtifact
    }),
  )
  const manifest = createReleaseManifest({
    artifacts,
    config,
    createdAt: input.createdAt ?? new Date().toISOString(),
    ecosystemMetadata: input.ecosystemMetadata,
    source,
  })
  const manifestBytes = new TextEncoder().encode(
    `${canonicalJson(manifest as never)}\n`,
  )
  const manifestDescriptor = await adapters.objects.put(
    manifestBytes,
    'application/vnd.regesta.release-manifest.v0+json',
  )
  const event = createPublishEvent(
    manifest,
    manifestDescriptor,
    input.authorization,
    channel,
  )
  const release: StoredRelease = {
    event,
    manifest,
    manifestDescriptor,
  }

  await adapters.database.putRelease(release)
  await adapters.database.setPackageChannel(config.id, channel, config.version)
  await adapters.database.appendEvent(event)
  await adapters.queue.enqueue('release.published', {
    channel,
    manifestDigest: manifestDescriptor.digest,
    package: config.id,
    version: config.version,
  })

  return {
    channel,
    event,
    manifest,
    manifestDescriptor,
  }
}

function createPublishEvent(
  manifest: ReleaseManifest,
  manifestDescriptor: ObjectDescriptor,
  authorization: WriteAuthorizationProof | undefined,
  channel: string,
): RegistryEvent {
  const eventWithoutId = {
    ...(authorization ? { authorization } : {}),
    artifactDigests: manifest.artifacts.map((artifact) => artifact.digest),
    channel,
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

  return {
    ...eventWithoutId,
    id: sha256(canonicalJson(eventWithoutId as never)),
  }
}

function createReleaseManifest(input: {
  artifacts: ReleaseArtifact[]
  config: RegestaConfig
  createdAt: string
  ecosystemMetadata?: ReleaseEcosystemMetadata
  source: ObjectDescriptor
}): ReleaseManifest {
  const packageId = parsePackageId(input.config.id)
  const manifest: ReleaseManifest = {
    object: 'regesta.release-manifest',
    specVersion: 0,
    id: input.config.id,
    ecosystem: packageId.ecosystem,
    name: packageId.name,
    version: input.config.version,
    artifacts: input.artifacts,
    ...(input.config.compatibility
      ? { compatibility: input.config.compatibility }
      : {}),
    configDigest: configDigest(input.config),
    createdAt: input.createdAt,
    ...(input.ecosystemMetadata
      ? { ecosystemMetadata: input.ecosystemMetadata }
      : {}),
    ...(input.config.family ? { family: input.config.family } : {}),
    ...(input.config.languages ? { languages: input.config.languages } : {}),
    ...(releaseMetadata(input.config)
      ? { metadata: releaseMetadata(input.config) }
      : {}),
    provenance: releaseProvenance(),
    source: input.source,
  }

  return manifest
}

function validatePublishArtifacts(artifacts: PublishArtifactInput[]): void {
  const installArtifacts = artifacts.filter((artifact) => {
    return artifact.role === 'install'
  })

  if (installArtifacts.length !== 1) {
    throw new TypeError(
      'Publish request must include exactly one install artifact',
    )
  }

  for (const artifact of artifacts) {
    if (!(artifact.bytes instanceof Uint8Array)) {
      throw new TypeError('Publish artifact bytes must be a Uint8Array')
    }

    if (artifact.bytes.byteLength === 0) {
      throw new TypeError('Publish artifacts must not be empty')
    }

    if (artifact.mediaType.length === 0) {
      throw new TypeError('Publish artifacts must include mediaType')
    }

    if (artifact.role.length === 0) {
      throw new TypeError('Publish artifacts must include role')
    }
  }
}

function releaseMetadata(config: RegestaConfig): ReleaseMetadata | undefined {
  const metadata: ReleaseMetadata = {
    ...(config.description ? { description: config.description } : {}),
    ...(config.exports ? { exports: config.exports } : {}),
    ...(config.repository ? { repository: config.repository } : {}),
  }

  return Object.keys(metadata).length === 0 ? undefined : metadata
}

function releaseProvenance(): ReleaseProvenance {
  return {
    level: 'source-attached',
    verified: false,
  }
}
