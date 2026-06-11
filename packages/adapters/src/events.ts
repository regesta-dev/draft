import {
  assertRegistryEventIntegrity,
  RegistryEventIntegrityError,
} from '@regesta/core'
import {
  assertArtifactDescriptorString,
  assertCanonicalTimestamp,
  assertCompatibilityString,
  assertObjectMediaType,
  assertPackageVersion,
  assertSha256Digest,
  canonicalJson,
  parsePackageId,
  sha256,
  type ObjectDescriptor,
  type RegistryEvent,
  type ReleaseArtifact,
} from '@regesta/protocol'
import type { StoredRelease } from './interfaces.ts'

export function assertPersistableRegistryEvent(event: RegistryEvent): void {
  assertRegistryEventIntegrity(event)
}

function assertKnownFields(
  value: object,
  knownFields: readonly string[],
  options: { label: string },
): void {
  const known = new Set(knownFields)
  const unknown = Object.keys(value).find((key) => {
    return !known.has(key)
  })

  if (unknown) {
    throw new TypeError(
      `${options.label} must not include unknown field: ${unknown}`,
    )
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function assertNonEmptyString(value: unknown, label: string): void {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${label} must not be empty`)
  }
}

function assertOptionalArtifactDescriptorString(
  value: unknown,
  label: string,
): void {
  if (value !== undefined) {
    assertArtifactDescriptorString(value, label)
  }
}

export function assertPersistableStoredRelease(
  release: StoredRelease,
  channel: string,
): void {
  assertPersistableRegistryEvent(release.event)
  try {
    assertStoredReleaseManifestSemantics(release)
  } catch (error) {
    if (error instanceof RegistryEventIntegrityError) {
      throw error
    }

    throw new RegistryEventIntegrityError(
      error instanceof Error ? error.message : String(error),
    )
  }

  if (release.event.eventType !== 'release.published') {
    throw new RegistryEventIntegrityError(
      'Stored release event must have eventType release.published',
    )
  }

  if (release.event.channel !== channel) {
    throw new RegistryEventIntegrityError(
      'Stored release event channel does not match committed channel',
    )
  }

  if (release.event.release.id !== release.manifest.id) {
    throw new RegistryEventIntegrityError(
      'Stored release event package id does not match release manifest',
    )
  }

  if (release.event.release.version !== release.manifest.version) {
    throw new RegistryEventIntegrityError(
      'Stored release event version does not match release manifest',
    )
  }

  if (
    release.event.release.manifestDigest !== release.manifestDescriptor.digest
  ) {
    throw new RegistryEventIntegrityError(
      'Stored release event manifest digest does not match manifest descriptor',
    )
  }

  if (release.event.sourceDigest !== release.manifest.source.digest) {
    throw new RegistryEventIntegrityError(
      'Stored release event source digest does not match release manifest',
    )
  }

  if (
    canonicalJson(release.event.artifactDigests) !==
    canonicalJson(release.manifest.artifacts.map((artifact) => artifact.digest))
  ) {
    throw new RegistryEventIntegrityError(
      'Stored release event artifact digests do not match release manifest',
    )
  }

  if (release.event.timestamp !== release.manifest.createdAt) {
    throw new RegistryEventIntegrityError(
      'Stored release event timestamp does not match release manifest',
    )
  }
}

function assertStoredReleaseManifestSemantics(release: StoredRelease): void {
  const { manifest } = release
  const parsedPackageId = parsePackageId(manifest.id)
  assertKnownFields(
    manifest,
    [
      'artifacts',
      'configDigest',
      'createdAt',
      'ecosystem',
      'family',
      'id',
      'languages',
      'metadata',
      'name',
      'object',
      'provenance',
      'source',
      'version',
    ],
    { label: 'Stored release manifest' },
  )

  if (manifest.object !== 'regesta.release-manifest') {
    throw new RegistryEventIntegrityError(
      'Stored release manifest object must be regesta.release-manifest',
    )
  }

  if (manifest.ecosystem !== parsedPackageId.ecosystem) {
    throw new RegistryEventIntegrityError(
      'Stored release manifest ecosystem does not match package id',
    )
  }

  if (manifest.name !== parsedPackageId.name) {
    throw new RegistryEventIntegrityError(
      'Stored release manifest name does not match package id',
    )
  }

  assertPackageVersion(manifest.version, 'Stored release manifest version')
  assertCanonicalTimestamp(
    manifest.createdAt,
    'Stored release manifest createdAt',
  )
  assertSha256Digest(manifest.configDigest)
  assertOptionalString(manifest.family, 'Stored release manifest family')
  assertOptionalStringArray(
    manifest.languages,
    'Stored release manifest languages',
  )
  if (manifest.metadata !== undefined) {
    assertReleaseMetadata(manifest.metadata)
  }
  assertReleaseProvenance(manifest.provenance)
  assertObjectDescriptor(
    release.manifestDescriptor,
    'Stored release manifest descriptor',
  )
  assertObjectDescriptor(manifest.source, 'Stored release source descriptor')

  const installArtifacts = manifest.artifacts.filter((artifact) => {
    return artifact.role === 'install'
  })

  for (const artifact of manifest.artifacts) {
    assertReleaseArtifact(artifact)
    assertArtifactDescriptorString(
      artifact.role,
      'Stored release artifact role',
    )
    assertOptionalArtifactDescriptorString(
      artifact.filename,
      'Stored release artifact filename',
    )
    assertOptionalArtifactDescriptorString(
      artifact.format,
      'Stored release artifact format',
    )
  }
  assertReleaseManifestDescriptor(release)

  if (installArtifacts.length !== 1) {
    throw new RegistryEventIntegrityError(
      'Stored release manifest must include exactly one install artifact',
    )
  }
}

function assertReleaseMetadata(metadata: unknown): void {
  if (!isRecord(metadata)) {
    throw new TypeError('Stored release metadata must be an object')
  }

  assertKnownFields(metadata, ['description', 'exports', 'repository'], {
    label: 'Stored release metadata',
  })
  assertOptionalString(
    metadata.description,
    'Stored release metadata description',
  )
  assertOptionalString(
    metadata.repository,
    'Stored release metadata repository',
  )
  if (metadata.exports !== undefined) {
    assertPackageExport(metadata.exports, 'Stored release metadata exports')
  }
}

function assertReleaseProvenance(provenance: unknown): void {
  if (!isRecord(provenance)) {
    throw new TypeError('Stored release provenance must be an object')
  }

  assertKnownFields(provenance, ['level', 'verified'], {
    label: 'Stored release provenance',
  })

  if (provenance.level !== 'source-attached') {
    throw new RegistryEventIntegrityError(
      'Stored release provenance level must be source-attached',
    )
  }

  if (provenance.verified !== false) {
    throw new RegistryEventIntegrityError(
      'Stored release provenance verified must be false',
    )
  }
}

function assertReleaseArtifact(artifact: ReleaseArtifact): void {
  assertKnownFields(
    artifact,
    [
      'compatibility',
      'digest',
      'ecosystemMetadata',
      'filename',
      'format',
      'mediaType',
      'role',
      'size',
    ],
    { label: 'Stored release artifact descriptor' },
  )
  assertObjectDescriptor(artifact, 'Stored release artifact descriptor', [
    'compatibility',
    'ecosystemMetadata',
    'filename',
    'format',
    'role',
  ])

  if (artifact.compatibility !== undefined) {
    assertReleaseCompatibility(artifact.compatibility)
  }

  if (
    artifact.ecosystemMetadata !== undefined &&
    !isRecord(artifact.ecosystemMetadata)
  ) {
    throw new TypeError(
      'Stored release artifact ecosystemMetadata must be an object',
    )
  }
}

function assertReleaseCompatibility(compatibility: unknown): void {
  if (!isRecord(compatibility)) {
    throw new TypeError(
      'Stored release artifact compatibility must be an object',
    )
  }

  assertKnownFields(
    compatibility,
    ['abi', 'modules', 'platforms', 'runtimes'],
    {
      label: 'Stored release artifact compatibility',
    },
  )

  assertOptionalStringArray(
    compatibility.modules,
    'Stored release artifact compatibility modules',
  )

  for (const abi of optionalArray(
    compatibility.abi,
    'Stored release artifact compatibility abi',
  )) {
    if (!isRecord(abi)) {
      throw new TypeError(
        'Stored release artifact ABI compatibility must be an object',
      )
    }

    assertKnownFields(abi, ['name', 'versions'], {
      label: 'Stored release artifact ABI compatibility',
    })
    assertCompatibilityString(
      abi.name,
      'Stored release artifact ABI compatibility name',
    )
    assertOptionalStringArray(
      abi.versions,
      'Stored release artifact ABI compatibility versions',
    )
  }

  for (const platform of optionalArray(
    compatibility.platforms,
    'Stored release artifact compatibility platforms',
  )) {
    if (!isRecord(platform)) {
      throw new TypeError(
        'Stored release artifact platform compatibility must be an object',
      )
    }

    assertKnownFields(platform, ['arch', 'libc', 'os'], {
      label: 'Stored release artifact platform compatibility',
    })
    assertOptionalStringArray(
      platform.arch,
      'Stored release artifact platform compatibility arch',
    )
    assertOptionalStringArray(
      platform.libc,
      'Stored release artifact platform compatibility libc',
    )
    assertOptionalStringArray(
      platform.os,
      'Stored release artifact platform compatibility os',
    )
  }

  for (const runtime of optionalArray(
    compatibility.runtimes,
    'Stored release artifact compatibility runtimes',
  )) {
    if (typeof runtime === 'string') {
      assertCompatibilityString(
        runtime,
        'Stored release artifact runtime compatibility',
      )
      continue
    }

    if (!isRecord(runtime)) {
      throw new TypeError(
        'Stored release artifact runtime compatibility must be a string or object',
      )
    }

    assertKnownFields(runtime, ['conditions', 'name', 'versions'], {
      label: 'Stored release artifact runtime compatibility',
    })
    assertOptionalStringArray(
      runtime.conditions,
      'Stored release artifact runtime compatibility conditions',
    )
    assertCompatibilityString(
      runtime.name,
      'Stored release artifact runtime compatibility name',
    )
    if (runtime.versions !== undefined) {
      assertCompatibilityString(
        runtime.versions,
        'Stored release artifact runtime compatibility versions',
      )
    }
  }
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

function assertOptionalStringArray(value: unknown, label: string): void {
  if (value === undefined) {
    return
  }

  if (!Array.isArray(value)) {
    throw new TypeError(`${label} must be an array`)
  }

  for (const item of value) {
    assertCompatibilityString(item, label)
  }
}

function assertOptionalString(value: unknown, label: string): void {
  if (value !== undefined && typeof value !== 'string') {
    throw new TypeError(`${label} must be a string`)
  }
}

function assertPackageExport(value: unknown, label: string): void {
  if (value === null || typeof value === 'string') {
    return
  }

  if (Array.isArray(value)) {
    value.forEach((item) => {
      assertPackageExport(item, label)
    })
    return
  }

  if (isRecord(value)) {
    Object.values(value).forEach((item) => {
      assertPackageExport(item, label)
    })
    return
  }

  throw new TypeError(
    `${label} must be JSON string, null, array, or object values`,
  )
}

function assertObjectDescriptor(
  descriptor: ObjectDescriptor,
  label: string,
  additionalFields: readonly string[] = [],
): void {
  assertKnownFields(
    descriptor,
    ['digest', 'mediaType', 'size', ...additionalFields],
    { label },
  )
  assertSha256Digest(descriptor.digest)

  if (!Number.isSafeInteger(descriptor.size) || descriptor.size < 0) {
    throw new RegistryEventIntegrityError(`${label} size must be non-negative`)
  }

  assertNonEmptyString(descriptor.mediaType, `${label} mediaType`)
  assertObjectMediaType(descriptor.mediaType, `${label} mediaType`)
}

function assertReleaseManifestDescriptor(release: StoredRelease): void {
  const manifestBytes = new TextEncoder().encode(
    `${canonicalJson(release.manifest)}\n`,
  )
  assertSha256Digest(release.manifestDescriptor.digest)

  if (release.manifestDescriptor.digest !== sha256(manifestBytes)) {
    throw new RegistryEventIntegrityError(
      'Stored release manifest descriptor digest does not match canonical manifest',
    )
  }

  if (release.manifestDescriptor.size !== manifestBytes.byteLength) {
    throw new RegistryEventIntegrityError(
      'Stored release manifest descriptor size does not match canonical manifest',
    )
  }
}
