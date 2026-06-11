import { canonicalJson } from './canonical-json.ts'
import {
  assertCompatibilityString,
  type AbiCompatibility,
  type PlatformCompatibility,
  type RegestaCompatibility,
  type RuntimeCompatibility,
} from './compatibility.ts'
import {
  assertObjectMediaType,
  assertSha256Digest,
  type ObjectDescriptor,
  type Sha256Digest,
} from './digest.ts'
import { parsePackageId } from './package-id.ts'
import {
  assertPackageVersion,
  type PackageEcosystem,
  type PackageId,
} from './package.ts'
import { assertCanonicalTimestamp } from './timestamp.ts'
import type { RegestaPackageExport } from './config.ts'

export interface ReleaseMetadata {
  description?: string
  exports?: RegestaPackageExport
  repository?: string
}

export type ArtifactEcosystemMetadata = Record<string, unknown>

export type ArtifactRole =
  | 'ai-context'
  | 'attestation'
  | 'docs'
  | 'install'
  | 'signature'
  | 'types'
  | (string & {})

export function assertArtifactDescriptorString(
  value: unknown,
  label = 'Artifact descriptor string',
): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`)
  }

  if (hasControlCharacter(value)) {
    throw new TypeError(`${label} must not include control characters`)
  }

  return value
}

export interface ReleaseArtifact extends ObjectDescriptor {
  compatibility?: RegestaCompatibility
  ecosystemMetadata?: ArtifactEcosystemMetadata
  filename?: string
  format?: string
  role: ArtifactRole
}

export interface ReleaseManifest {
  object: 'regesta.release-manifest'
  id: PackageId
  ecosystem: PackageEcosystem
  name: string
  version: string
  artifacts: ReleaseArtifact[]
  configDigest: Sha256Digest
  createdAt: string
  family?: string
  languages?: string[]
  metadata?: ReleaseMetadata
  provenance: ReleaseProvenance
  source: ObjectDescriptor
}

export interface ReleaseProvenance {
  level: 'source-attached'
  verified: false
}

export interface ObjectInventoryPage {
  object: 'regesta.object-inventory'
  objects: ObjectDescriptor[]
  nextAfter?: Sha256Digest
}

export function parseObjectDescriptor(
  value: unknown,
  label = 'Object descriptor',
): ObjectDescriptor {
  const record = readRecord(value, label)

  return {
    digest: assertSha256Digest(readString(record.digest, `${label} digest`)),
    mediaType: assertObjectMediaType(record.mediaType, `${label} mediaType`),
    size: readNonNegativeInteger(record.size, `${label} size`),
  }
}

export function parseObjectInventoryPage(
  value: unknown,
  label = 'Object inventory page',
): ObjectInventoryPage {
  const record = readRecord(value, label)
  assertKnownFields(record, ['nextAfter', 'object', 'objects'], label)

  const nextAfter =
    record.nextAfter === undefined
      ? undefined
      : assertSha256Digest(readString(record.nextAfter, `${label} nextAfter`))

  return {
    ...(nextAfter ? { nextAfter } : {}),
    object: readLiteral(
      record.object,
      'regesta.object-inventory',
      `${label} object`,
    ),
    objects: readArray(record.objects, `${label} objects`).map(
      (item, index) => {
        return parseObjectDescriptor(item, `${label} objects[${index}]`)
      },
    ),
  }
}

export function parseReleaseManifest(
  value: unknown,
  label = 'Release manifest',
): ReleaseManifest {
  const record = readRecord(value, label)
  assertKnownFields(
    record,
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
    label,
  )

  const parsedId = parsePackageId(readString(record.id, `${label} id`))
  const ecosystem = assertCompatibilityString(
    record.ecosystem,
    `${label} ecosystem`,
  )
  const name = readString(record.name, `${label} name`)

  if (ecosystem !== parsedId.ecosystem) {
    throw new TypeError(`${label} ecosystem must match package id`)
  }

  if (name !== parsedId.name) {
    throw new TypeError(`${label} name must match package id`)
  }

  return {
    artifacts: readArray(record.artifacts, `${label} artifacts`).map(
      (item, index) => {
        return parseReleaseArtifact(item, `${label} artifacts[${index}]`)
      },
    ),
    configDigest: assertSha256Digest(
      readString(record.configDigest, `${label} configDigest`),
    ),
    createdAt: assertCanonicalTimestamp(
      readString(record.createdAt, `${label} createdAt`),
      `${label} createdAt`,
    ),
    ecosystem,
    id: parsedId.id,
    ...(record.family === undefined
      ? {}
      : {
          family: assertArtifactDescriptorString(
            record.family,
            `${label} family`,
          ),
        }),
    ...(record.languages === undefined
      ? {}
      : {
          languages: readStringArray(record.languages, `${label} languages`),
        }),
    ...(record.metadata === undefined
      ? {}
      : {
          metadata: parseReleaseMetadata(record.metadata, `${label} metadata`),
        }),
    name,
    object: readLiteral(
      record.object,
      'regesta.release-manifest',
      `${label} object`,
    ),
    provenance: parseReleaseProvenance(
      record.provenance,
      `${label} provenance`,
    ),
    source: parseObjectDescriptor(record.source, `${label} source`),
    version: assertPackageVersion(record.version, `${label} version`),
  }
}

function parseReleaseArtifact(value: unknown, label: string): ReleaseArtifact {
  const record = readRecord(value, label)
  assertKnownFields(
    record,
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
    label,
  )

  return {
    digest: assertSha256Digest(readString(record.digest, `${label} digest`)),
    mediaType: assertObjectMediaType(record.mediaType, `${label} mediaType`),
    size: readNonNegativeInteger(record.size, `${label} size`),
    ...(record.compatibility === undefined
      ? {}
      : {
          compatibility: parseRegestaCompatibility(
            record.compatibility,
            `${label} compatibility`,
          ),
        }),
    ...(record.ecosystemMetadata === undefined
      ? {}
      : {
          ecosystemMetadata: parseArtifactEcosystemMetadata(
            record.ecosystemMetadata,
            `${label} ecosystemMetadata`,
          ),
        }),
    ...(record.filename === undefined
      ? {}
      : {
          filename: assertArtifactDescriptorString(
            record.filename,
            `${label} filename`,
          ),
        }),
    ...(record.format === undefined
      ? {}
      : {
          format: assertArtifactDescriptorString(
            record.format,
            `${label} format`,
          ),
        }),
    role: assertArtifactDescriptorString(record.role, `${label} role`),
  }
}

function parseArtifactEcosystemMetadata(
  value: unknown,
  label: string,
): ArtifactEcosystemMetadata {
  const metadata = readRecord(value, label)

  try {
    canonicalJson(metadata)
  } catch (error) {
    throw new TypeError(
      `${label} must contain only canonical JSON values: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    )
  }

  return metadata
}

function parseRegestaCompatibility(
  value: unknown,
  label: string,
): RegestaCompatibility {
  const record = readRecord(value, label)
  assertKnownFields(record, ['abi', 'modules', 'platforms', 'runtimes'], label)

  return {
    ...(record.abi === undefined
      ? {}
      : {
          abi: readArray(record.abi, `${label} abi`).map((item, index) => {
            return parseAbiCompatibility(item, `${label} abi[${index}]`)
          }),
        }),
    ...(record.modules === undefined
      ? {}
      : { modules: readStringArray(record.modules, `${label} modules`) }),
    ...(record.platforms === undefined
      ? {}
      : {
          platforms: readArray(record.platforms, `${label} platforms`).map(
            (item, index) => {
              return parsePlatformCompatibility(
                item,
                `${label} platforms[${index}]`,
              )
            },
          ),
        }),
    ...(record.runtimes === undefined
      ? {}
      : {
          runtimes: readArray(record.runtimes, `${label} runtimes`).map(
            (item, index) => {
              return parseRuntimeCompatibility(
                item,
                `${label} runtimes[${index}]`,
              )
            },
          ),
        }),
  }
}

function parseAbiCompatibility(
  value: unknown,
  label: string,
): AbiCompatibility {
  const record = readRecord(value, label)
  assertKnownFields(record, ['name', 'versions'], label)

  return {
    name: assertCompatibilityString(record.name, `${label} name`),
    ...(record.versions === undefined
      ? {}
      : { versions: readStringArray(record.versions, `${label} versions`) }),
  }
}

function parsePlatformCompatibility(
  value: unknown,
  label: string,
): PlatformCompatibility {
  const record = readRecord(value, label)
  assertKnownFields(record, ['arch', 'libc', 'os'], label)

  return {
    ...(record.arch === undefined
      ? {}
      : { arch: readStringArray(record.arch, `${label} arch`) }),
    ...(record.libc === undefined
      ? {}
      : { libc: readStringArray(record.libc, `${label} libc`) }),
    ...(record.os === undefined
      ? {}
      : { os: readStringArray(record.os, `${label} os`) }),
  }
}

function parseRuntimeCompatibility(
  value: unknown,
  label: string,
): RuntimeCompatibility {
  if (typeof value === 'string') {
    return assertCompatibilityString(value, label)
  }

  const record = readRecord(value, label)
  assertKnownFields(record, ['conditions', 'name', 'versions'], label)

  return {
    ...(record.conditions === undefined
      ? {}
      : {
          conditions: readStringArray(record.conditions, `${label} conditions`),
        }),
    name: assertCompatibilityString(record.name, `${label} name`),
    ...(record.versions === undefined
      ? {}
      : {
          versions: assertCompatibilityString(
            record.versions,
            `${label} versions`,
          ),
        }),
  }
}

function parseReleaseMetadata(value: unknown, label: string): ReleaseMetadata {
  const record = readRecord(value, label)
  assertKnownFields(record, ['description', 'exports', 'repository'], label)

  return {
    ...(record.description === undefined
      ? {}
      : {
          description: readString(record.description, `${label} description`),
        }),
    ...(record.exports === undefined
      ? {}
      : { exports: parsePackageExport(record.exports, `${label} exports`) }),
    ...(record.repository === undefined
      ? {}
      : { repository: readString(record.repository, `${label} repository`) }),
  }
}

function parsePackageExport(
  value: unknown,
  label: string,
): RegestaPackageExport {
  if (value === null) {
    return null
  }

  if (typeof value === 'string') {
    return readString(value, label)
  }

  if (Array.isArray(value)) {
    return value.map((item, index) => {
      return parsePackageExport(item, `${label}[${index}]`)
    })
  }

  const record = readRecord(value, label)
  const output: Record<string, RegestaPackageExport> = {}
  for (const [key, item] of Object.entries(record)) {
    output[readString(key, `${label} key`)] = parsePackageExport(
      item,
      `${label}.${key}`,
    )
  }

  return output
}

function parseReleaseProvenance(
  value: unknown,
  label: string,
): ReleaseProvenance {
  const record = readRecord(value, label)
  assertKnownFields(record, ['level', 'verified'], label)

  return {
    level: readLiteral(record.level, 'source-attached', `${label} level`),
    verified: readLiteral(record.verified, false, `${label} verified`),
  }
}

function assertKnownFields(
  record: Record<string, unknown>,
  knownFields: readonly string[],
  label: string,
): void {
  const known = new Set(knownFields)
  const unknown = Object.keys(record).find((key) => {
    return !known.has(key)
  })

  if (unknown) {
    throw new TypeError(`${label} must not include unknown field: ${unknown}`)
  }
}

function readRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`)
  }

  return Object.fromEntries(Object.entries(value))
}

function readArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`${label} must be an array`)
  }

  return value
}

function readStringArray(value: unknown, label: string): string[] {
  return readArray(value, label).map((item, index) => {
    return assertCompatibilityString(item, `${label}[${index}]`)
  })
}

function readString(value: unknown, label: string): string {
  return assertCompatibilityString(value, label)
}

function readNonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`)
  }

  return value
}

function readLiteral<const T extends string | boolean>(
  value: unknown,
  expected: T,
  label: string,
): T {
  if (value !== expected) {
    throw new TypeError(`${label} must be ${expected}`)
  }

  return expected
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0)

    if (code !== undefined && (code <= 0x1f || code === 0x7f)) {
      return true
    }
  }

  return false
}
