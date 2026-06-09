import {
  assertArtifactDescriptorString,
  assertCanonicalTimestamp,
  assertCompatibilityString,
  assertObjectMediaType,
  canonicalJson,
  defaultPackageChannel,
  parsePackageId,
  registryEventDigest,
  type ObjectDescriptor,
  type PublishReleaseEvent,
  type RegestaConfig,
  type RegistryEvent,
  type ReleaseArtifact,
  type ReleaseManifest,
  type ReleaseMetadata,
  type ReleaseProvenance,
  type WriteAuthorizationProof,
} from '@regesta/protocol'
import { configDigest, normalizeRegestaConfig } from './config.ts'
import { enqueueDerivedRegistryJob } from './queue.ts'
import {
  ReleaseAlreadyExistsError,
  type RegistryAdapters,
  type StoredRelease,
} from './storage.ts'
import { assertWriteAuthorizationIsFresh } from './write-authorization.ts'

export interface PublishArtifactInput {
  bytes: Uint8Array
  compatibility?: ReleaseArtifact['compatibility']
  ecosystemMetadata?: ReleaseArtifact['ecosystemMetadata']
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
  source: Uint8Array
}

export interface PublishResult {
  channel: string
  event: RegistryEvent
  manifest: ReleaseManifest
  manifestDescriptor: ObjectDescriptor
}

type PublishArtifactRecord = Record<string, unknown> & {
  bytes?: unknown
  compatibility?: unknown
  ecosystemMetadata?: unknown
  filename?: unknown
  format?: unknown
  mediaType?: unknown
  role?: unknown
}

export async function publishRelease(
  input: PublishInput,
  adapters: RegistryAdapters,
): Promise<PublishResult> {
  const config = normalizeRegestaConfig(input.config)
  const channel = defaultPackageChannel
  parsePackageId(config.id)
  validatePublishSource(input.source)
  validatePublishArtifacts(input.artifacts)
  const createdAt = publishCreatedAt(input)

  await assertWriteAuthorizationIsFresh(adapters, input.authorization)

  if (await adapters.database.getRelease(config.id, config.version)) {
    throw new ReleaseAlreadyExistsError(config.id, config.version)
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
        ...(artifact.compatibility
          ? { compatibility: artifact.compatibility }
          : {}),
        ...(artifact.ecosystemMetadata
          ? { ecosystemMetadata: artifact.ecosystemMetadata }
          : {}),
        ...(artifact.filename ? { filename: artifact.filename } : {}),
        ...(artifact.format ? { format: artifact.format } : {}),
        role: artifact.role,
      } satisfies ReleaseArtifact
    }),
  )
  const manifest = createReleaseManifest({
    artifacts,
    config,
    createdAt,
    source,
  })
  const manifestBytes = new TextEncoder().encode(`${canonicalJson(manifest)}\n`)
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

  await adapters.database.commitPublishedRelease(release, channel)
  enqueueDerivedRegistryJob(adapters, 'release.published', {
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

function publishCreatedAt(input: PublishInput): string {
  const createdAt = input.createdAt ?? input.authorization?.signedAt

  if (
    input.authorization &&
    createdAt !== undefined &&
    createdAt !== input.authorization.signedAt
  ) {
    throw new TypeError(
      'Publish createdAt must match write authorization signedAt',
    )
  }

  return createdAt === undefined
    ? new Date().toISOString()
    : assertCanonicalTimestamp(createdAt, 'Publish createdAt')
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
    id: registryEventDigest(eventWithoutId),
  }
}

function createReleaseManifest(input: {
  artifacts: ReleaseArtifact[]
  config: RegestaConfig
  createdAt: string
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
    configDigest: configDigest(input.config),
    createdAt: input.createdAt,
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

function validatePublishArtifacts(artifacts: unknown): void {
  if (!Array.isArray(artifacts)) {
    throw new TypeError('Publish artifacts must be an array')
  }

  assertPublishArtifactRecords(artifacts)

  for (const artifact of artifacts) {
    if (!(artifact.bytes instanceof Uint8Array)) {
      throw new TypeError('Publish artifact bytes must be a Uint8Array')
    }

    if (artifact.bytes.byteLength === 0) {
      throw new TypeError('Publish artifacts must not be empty')
    }

    if (
      typeof artifact.mediaType !== 'string' ||
      artifact.mediaType.length === 0
    ) {
      throw new TypeError('Publish artifacts must include mediaType')
    }
    assertObjectMediaType(artifact.mediaType, 'Publish artifact mediaType')

    if (typeof artifact.role !== 'string' || artifact.role.length === 0) {
      throw new TypeError('Publish artifacts must include role')
    }
    assertArtifactDescriptorString(artifact.role, 'Publish artifact role')

    if (
      artifact.filename !== undefined &&
      (typeof artifact.filename !== 'string' || artifact.filename.length === 0)
    ) {
      throw new TypeError('Publish artifact filename must be non-empty')
    }
    if (artifact.filename !== undefined) {
      assertArtifactDescriptorString(
        artifact.filename,
        'Publish artifact filename',
      )
    }

    if (
      artifact.format !== undefined &&
      (typeof artifact.format !== 'string' || artifact.format.length === 0)
    ) {
      throw new TypeError('Publish artifact format must be non-empty')
    }
    if (artifact.format !== undefined) {
      assertArtifactDescriptorString(artifact.format, 'Publish artifact format')
    }

    if (artifact.compatibility !== undefined) {
      validatePublishArtifactCompatibility(artifact.compatibility)
    }

    if (
      artifact.ecosystemMetadata !== undefined &&
      !isRecord(artifact.ecosystemMetadata)
    ) {
      throw new TypeError(
        'Publish artifact ecosystemMetadata must be an object',
      )
    }
  }

  const installArtifacts = artifacts.filter((artifact) => {
    return artifact.role === 'install'
  })

  if (installArtifacts.length !== 1) {
    throw new TypeError(
      'Publish request must include exactly one install artifact',
    )
  }
}

function assertPublishArtifactRecords(
  artifacts: unknown[],
): asserts artifacts is PublishArtifactRecord[] {
  for (const artifact of artifacts) {
    if (!isRecord(artifact)) {
      throw new TypeError('Publish artifact must be an object')
    }
  }
}

function validatePublishSource(source: Uint8Array): void {
  if (!(source instanceof Uint8Array)) {
    throw new TypeError('Publish source must be a Uint8Array')
  }

  if (source.byteLength === 0) {
    throw new TypeError('Publish source must not be empty')
  }
}

function validatePublishArtifactCompatibility(compatibility: unknown): void {
  if (!isRecord(compatibility)) {
    throw new TypeError('Publish artifact compatibility must be an object')
  }

  assertKnownFields(
    compatibility,
    ['abi', 'modules', 'platforms', 'runtimes'],
    'Publish artifact compatibility',
  )

  for (const abi of optionalArray(
    compatibility.abi,
    'Publish artifact compatibility abi',
  )) {
    if (!isRecord(abi)) {
      throw new TypeError(
        'Publish artifact ABI compatibility must be an object',
      )
    }

    assertKnownFields(
      abi,
      ['name', 'versions'],
      'Publish artifact ABI compatibility',
    )
    assertCompatibilityString(
      abi.name,
      'Publish artifact ABI compatibility name',
    )
    assertOptionalStringArray(
      abi.versions,
      'Publish artifact ABI compatibility versions',
    )
  }

  assertOptionalStringArray(
    compatibility.modules,
    'Publish artifact compatibility modules',
  )

  for (const platform of optionalArray(
    compatibility.platforms,
    'Publish artifact compatibility platforms',
  )) {
    if (!isRecord(platform)) {
      throw new TypeError(
        'Publish artifact platform compatibility must be an object',
      )
    }

    assertKnownFields(
      platform,
      ['arch', 'libc', 'os'],
      'Publish artifact platform compatibility',
    )
    assertOptionalStringArray(
      platform.arch,
      'Publish artifact platform compatibility arch',
    )
    assertOptionalStringArray(
      platform.libc,
      'Publish artifact platform compatibility libc',
    )
    assertOptionalStringArray(
      platform.os,
      'Publish artifact platform compatibility os',
    )
  }

  for (const runtime of optionalArray(
    compatibility.runtimes,
    'Publish artifact compatibility runtimes',
  )) {
    if (typeof runtime === 'string') {
      assertCompatibilityString(
        runtime,
        'Publish artifact runtime compatibility',
      )
      continue
    }

    if (!isRecord(runtime)) {
      throw new TypeError(
        'Publish artifact runtime compatibility must be a string or object',
      )
    }

    assertKnownFields(
      runtime,
      ['conditions', 'name', 'versions'],
      'Publish artifact runtime compatibility',
    )
    assertOptionalStringArray(
      runtime.conditions,
      'Publish artifact runtime compatibility conditions',
    )
    assertCompatibilityString(
      runtime.name,
      'Publish artifact runtime compatibility name',
    )
    if (runtime.versions !== undefined) {
      assertCompatibilityString(
        runtime.versions,
        'Publish artifact runtime compatibility versions',
      )
    }
  }
}

function releaseMetadata(config: RegestaConfig): ReleaseMetadata | undefined {
  const metadata: ReleaseMetadata = {
    ...(config.description === undefined
      ? {}
      : { description: config.description }),
    ...(config.exports === undefined ? {} : { exports: config.exports }),
    ...(config.repository === undefined
      ? {}
      : { repository: config.repository }),
  }

  return Object.keys(metadata).length === 0 ? undefined : metadata
}

function releaseProvenance(): ReleaseProvenance {
  return {
    level: 'source-attached',
    verified: false,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function assertKnownFields(
  value: Record<string, unknown>,
  knownFields: readonly string[],
  label: string,
): void {
  const known = new Set(knownFields)
  const unknown = Object.keys(value).find((key) => {
    return !known.has(key)
  })

  if (unknown) {
    throw new TypeError(`${label} must not include unknown field: ${unknown}`)
  }
}

function assertOptionalStringArray(value: unknown, label: string): void {
  if (value === undefined) {
    return
  }

  if (!Array.isArray(value)) {
    throw new TypeError(`${label} must be an array`)
  }

  value.forEach((item, index) => {
    assertCompatibilityString(item, `${label}[${index}]`)
  })
}

function optionalArray(value: unknown, label: string): unknown[] {
  if (value === undefined) {
    return []
  }

  if (!Array.isArray(value)) {
    throw new TypeError(`${label} must be an array`)
  }

  return value
}
