import {
  canonicalJson,
  parsePackageCoordinate,
  sha256,
  type ObjectDescriptor,
  type RegestaConfig,
  type RegistryEvent,
  type ReleaseManifest,
  type ReleaseMetadata,
  type ReleaseProvenance,
} from '@regesta/protocol'
import { bytesToBase64 } from './base64.ts'
import {
  configDigest,
  normalizeRegestaConfig,
  readRegestaConfig,
} from './config.ts'
import { createNpmTarball, createSourceArchive } from './files.ts'
import type { RegistryAdapters, StoredRelease } from '@regesta/adapters'

export interface PreparedPublish {
  config: RegestaConfig
  npmTarballBase64: string
  sourceArchiveBase64: string
}

export interface PublishInput {
  config: RegestaConfig
  createdAt?: string
  npmTarball: Uint8Array
  sourceArchive: Uint8Array
}

export interface PublishResult {
  event: RegistryEvent
  manifest: ReleaseManifest
  manifestDescriptor: ObjectDescriptor
}

export async function preparePublish(
  projectDir: string,
): Promise<PreparedPublish> {
  const config = await readRegestaConfig(projectDir)
  const sourceArchive = await createSourceArchive(projectDir, config)
  const npmTarball = await createNpmTarball(projectDir, config)

  return {
    config,
    npmTarballBase64: bytesToBase64(npmTarball.bytes),
    sourceArchiveBase64: bytesToBase64(sourceArchive.bytes),
  }
}

export async function publishRelease(
  input: PublishInput,
  adapters: RegistryAdapters,
): Promise<PublishResult> {
  const config = normalizeRegestaConfig(input.config)
  parsePackageCoordinate(config.package)

  if (await adapters.database.getRelease(config.package, config.version)) {
    throw new Error(
      `Release already exists: ${config.package}@${config.version}`,
    )
  }

  const source = await adapters.objects.put(
    input.sourceArchive,
    'application/vnd.regesta.source-archive+tgz',
  )
  const npmTarball = await adapters.objects.put(
    input.npmTarball,
    'application/vnd.npm.package+tgz',
  )
  const manifest = createReleaseManifest({
    config,
    createdAt: input.createdAt ?? new Date().toISOString(),
    npmTarball,
    source,
  })
  const manifestBytes = new TextEncoder().encode(
    `${canonicalJson(manifest as never)}\n`,
  )
  const manifestDescriptor = await adapters.objects.put(
    manifestBytes,
    'application/vnd.regesta.release-manifest+json',
  )
  const event = createPublishEvent(manifest, manifestDescriptor)
  const release: StoredRelease = {
    event,
    manifest,
    manifestDescriptor,
  }

  await adapters.database.putRelease(release)
  await adapters.database.appendEvent(event)
  await adapters.queue.enqueue('release.published', {
    manifestDigest: manifestDescriptor.digest,
    package: config.package,
    version: config.version,
  })

  return {
    event,
    manifest,
    manifestDescriptor,
  }
}

function createPublishEvent(
  manifest: ReleaseManifest,
  manifestDescriptor: ObjectDescriptor,
): RegistryEvent {
  const eventWithoutId = {
    manifestDigest: manifestDescriptor.digest,
    package: manifest.package,
    schema: 'regesta.event.v0',
    sourceDigest: manifest.source.digest,
    timestamp: manifest.createdAt,
    type: 'PUBLISH_RELEASE',
    version: manifest.version,
  } satisfies Omit<RegistryEvent, 'id'>

  return {
    ...eventWithoutId,
    id: sha256(canonicalJson(eventWithoutId as never)),
  }
}

function createReleaseManifest(input: {
  config: RegestaConfig
  createdAt: string
  npmTarball: ObjectDescriptor
  source: ObjectDescriptor
}): ReleaseManifest {
  const manifest: ReleaseManifest = {
    artifacts: {
      npmTarball: input.npmTarball,
    },
    ...(input.config.compatibility
      ? { compatibility: input.config.compatibility }
      : {}),
    configDigest: configDigest(input.config),
    createdAt: input.createdAt,
    ...(releaseMetadata(input.config)
      ? { metadata: releaseMetadata(input.config) }
      : {}),
    package: input.config.package,
    provenance: releaseProvenance(input.config),
    schema: 'regesta.release-manifest.v0',
    source: input.source,
    version: input.config.version,
  }

  return manifest
}

function releaseMetadata(config: RegestaConfig): ReleaseMetadata | undefined {
  const metadata: ReleaseMetadata = {
    ...(config.description ? { description: config.description } : {}),
    ...(config.exports ? { exports: config.exports } : {}),
    ...(config.repository ? { repository: config.repository } : {}),
  }

  return Object.keys(metadata).length === 0 ? undefined : metadata
}

function releaseProvenance(config: RegestaConfig): ReleaseProvenance {
  return {
    ...(config.provenance.command
      ? { command: config.provenance.command }
      : {}),
    level: config.provenance.level,
    ...(config.provenance.toolchain
      ? { toolchain: config.provenance.toolchain }
      : {}),
    verified: false,
  }
}
