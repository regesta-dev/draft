import { assertSha256Digest, type Sha256Digest } from './digest.ts'
import { parsePackageId } from './package-id.ts'
import { assertCanonicalTimestamp } from './timestamp.ts'

export type PackageId = `${string}:${string}`

export const defaultPackageChannel = 'latest'

export function assertPackageChannel(
  value: unknown,
  label = 'Package channel',
): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`)
  }

  if (hasControlCharacter(value)) {
    throw new TypeError(`${label} must not include control characters`)
  }

  return value
}

export function assertPackageVersion(
  value: unknown,
  label = 'Package version',
): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`)
  }

  if (hasControlCharacter(value)) {
    throw new TypeError(`${label} must not include control characters`)
  }

  return value
}

export type PackageEcosystem =
  | 'cargo'
  | 'go'
  | 'npm'
  | 'oci'
  | 'pypi'
  | (string & {})

export interface PackageState {
  channels?: Record<string, string>
  ecosystem: PackageEcosystem
  id: PackageId
  name: string
  object: 'regesta.package-state'
  releases: PackageStateRelease[]
}

export interface PackageStateRelease {
  createdAt: string
  manifestDigest: Sha256Digest
  version: string
}

export function parsePackageState(
  value: unknown,
  label = 'Package state',
): PackageState {
  const record = readRecord(value, label)
  assertKnownFields(
    record,
    ['channels', 'ecosystem', 'id', 'name', 'object', 'releases'],
    label,
  )

  const parsedId = parsePackageId(readString(record.id, `${label} id`))
  const ecosystem = readString(record.ecosystem, `${label} ecosystem`)
  const name = readString(record.name, `${label} name`)

  if (ecosystem !== parsedId.ecosystem) {
    throw new TypeError(`${label} ecosystem must match package id`)
  }

  if (name !== parsedId.name) {
    throw new TypeError(`${label} name must match package id`)
  }

  return {
    ...(record.channels === undefined
      ? {}
      : {
          channels: parsePackageChannels(record.channels, `${label} channels`),
        }),
    ecosystem,
    id: parsedId.id,
    name,
    object: readLiteral(
      record.object,
      'regesta.package-state',
      `${label} object`,
    ),
    releases: readArray(record.releases, `${label} releases`).map(
      (release, index) => {
        return parsePackageStateRelease(release, `${label} releases[${index}]`)
      },
    ),
  }
}

function parsePackageChannels(
  value: unknown,
  label: string,
): Record<string, string> {
  const record = readRecord(value, label)
  const channels: Record<string, string> = {}

  for (const [channel, version] of Object.entries(record)) {
    channels[assertPackageChannel(channel, `${label} channel`)] =
      assertPackageVersion(version, `${label} ${channel}`)
  }

  return channels
}

function parsePackageStateRelease(
  value: unknown,
  label: string,
): PackageStateRelease {
  const record = readRecord(value, label)
  assertKnownFields(record, ['createdAt', 'manifestDigest', 'version'], label)

  return {
    createdAt: assertCanonicalTimestamp(
      readString(record.createdAt, `${label} createdAt`),
      `${label} createdAt`,
    ),
    manifestDigest: assertSha256Digest(
      readString(record.manifestDigest, `${label} manifestDigest`),
    ),
    version: assertPackageVersion(record.version, `${label} version`),
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

function readString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`)
  }

  if (hasControlCharacter(value)) {
    throw new TypeError(`${label} must not include control characters`)
  }

  return value
}

function readLiteral<const T extends string>(
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
