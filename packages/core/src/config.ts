import {
  assertPackageVersion,
  assertSourceArchivePath,
  canonicalJson,
  parsePackageId,
  sha256,
  type RegestaConfig,
  type RegestaPackageExport,
  type RegestaProvenance,
  type RegestaSourceConfig,
  type Sha256Digest,
} from '@regesta/protocol'

export const regestaConfigFile = 'regesta.json'

export interface RegestaConfigDefaults {
  description?: string
  exports?: RegestaPackageExport
  id?: string
  repository?: string
  version?: string
}

export function normalizeRegestaConfig(
  value: unknown,
  defaults: RegestaConfigDefaults = {},
): RegestaConfig {
  if (!isRecord(value)) {
    throw new TypeError('regesta.json must be an object')
  }

  const input = value

  if (input.$schema !== undefined || input.schema !== undefined) {
    throw new TypeError('regesta.json schema fields are not supported')
  }

  if (input.compatibility !== undefined) {
    throw new TypeError(
      'regesta.json compatibility is not supported; attach compatibility to publish artifacts',
    )
  }

  if (input.dependencies !== undefined) {
    throw new TypeError(
      'regesta.json dependencies are not supported; use ecosystem-native manifests',
    )
  }

  assertKnownFields(
    input,
    [
      'description',
      'exports',
      'family',
      'id',
      'languages',
      'provenance',
      'repository',
      'source',
      'version',
    ],
    'regesta.json',
  )

  const id = normalizeConfigId(input.id === undefined ? defaults.id : input.id)
  if (id === undefined) {
    throw new TypeError('regesta.json id must be a package id string')
  }

  const version = input.version === undefined ? defaults.version : input.version
  const normalizedVersion = assertPackageVersion(
    version,
    'regesta.json version',
  )

  const config: RegestaConfig = {
    id,
    provenance: normalizeProvenance(input.provenance),
    source: normalizeSource(input),
    version: normalizedVersion,
  }

  const description =
    input.description === undefined ? defaults.description : input.description
  if (description !== undefined) {
    assertOptionalString(description, 'regesta.json description')
    config.description = description
  }

  const repository =
    input.repository === undefined ? defaults.repository : input.repository
  if (repository !== undefined) {
    assertOptionalString(repository, 'regesta.json repository')
    config.repository = repository
  }

  const languages = normalizeStringArray(
    input.languages,
    'regesta.json languages',
  )
  if (languages) {
    config.languages = languages
  }

  const exportsValue =
    input.exports === undefined ? defaults.exports : input.exports
  if (exportsValue !== undefined) {
    config.exports = normalizePackageExports(exportsValue)
  }

  if (input.family !== undefined) {
    assertOptionalString(input.family, 'regesta.json family')
    config.family = input.family
  }

  return config
}

export function configDigest(config: RegestaConfig): Sha256Digest {
  return sha256(canonicalJson(config))
}

function normalizeConfigId(value: unknown): RegestaConfig['id'] | undefined {
  if (value === undefined) {
    return undefined
  }

  if (typeof value !== 'string') {
    throw new TypeError('regesta.json id must be a package id string')
  }

  return parsePackageId(value).id
}

function normalizePackageExports(value: unknown): RegestaPackageExport {
  if (!isPackageExport(value)) {
    throw new TypeError(
      'package exports must be JSON string, null, array, or object values',
    )
  }

  return value
}

function normalizeProvenance(value: unknown): RegestaProvenance {
  if (value === undefined) {
    return { level: 'source-attached' }
  }

  if (!isRecord(value)) {
    throw new TypeError('regesta.json provenance must be an object')
  }

  const input = value
  assertKnownFields(input, ['level'], 'regesta.json provenance')
  const level = input.level ?? 'source-attached'

  if (level !== 'source-attached') {
    throw new TypeError('regesta.json provenance.level must be source-attached')
  }

  return { level }
}

function normalizeSource(input: Record<string, unknown>): RegestaSourceConfig {
  if (input.source === undefined) {
    throw new TypeError('regesta.json source is required')
  }

  if (!isRecord(input.source)) {
    throw new TypeError('regesta.json source must be an object')
  }

  const source = input.source
  assertKnownFields(source, ['exclude', 'include'], 'regesta.json source')
  const config: RegestaSourceConfig = {}

  if (source.exclude !== undefined) {
    const exclude =
      normalizeSourcePathArray(source.exclude, 'regesta.json source.exclude') ??
      []
    if (exclude.some((entry) => sourcePathMatches(entry, regestaConfigFile))) {
      throw new TypeError(
        'regesta.json source.exclude must not exclude regesta.json',
      )
    }
    config.exclude = exclude
  }

  if (source.include !== undefined) {
    config.include = normalizeSourcePathArray(
      source.include,
      'regesta.json source.include',
    )
  }

  return config
}

function normalizeSourcePathArray(
  value: unknown,
  field: string,
): string[] | undefined {
  if (value === undefined) {
    return undefined
  }

  if (!Array.isArray(value)) {
    throw new TypeError(`${field} must be an array`)
  }

  return value.map((item) => {
    if (typeof item !== 'string') {
      throw new TypeError(`${field} must contain strings`)
    }

    return normalizeSourcePath(item, field)
  })
}

function normalizeSourcePath(value: string, field: string): string {
  const label = `${field} paths`
  return assertSourceArchivePath(value, label)
}

function sourcePathMatches(entry: string, target: string): boolean {
  return trimTrailingSlashes(entry) === target
}

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/u, '')
}

function normalizeStringArray(
  value: unknown,
  field: string,
): string[] | undefined {
  if (value === undefined) {
    return undefined
  }

  if (!Array.isArray(value)) {
    throw new TypeError(`${field} must be an array`)
  }

  return value.map((item) => {
    if (typeof item !== 'string' || item.length === 0) {
      throw new TypeError(`${field} must contain non-empty strings`)
    }

    return item
  })
}

function assertOptionalString(
  value: unknown,
  field: string,
): asserts value is string {
  if (typeof value !== 'string') {
    throw new TypeError(`${field} must be a string`)
  }
}

function assertKnownFields(
  value: Record<string, unknown>,
  knownFields: readonly string[],
  label: string,
): void {
  const known = new Set(knownFields)
  const unknown = Object.keys(value).find((field) => !known.has(field))

  if (unknown) {
    throw new TypeError(`${label} must not include unknown field: ${unknown}`)
  }
}

function isPackageExport(value: unknown): value is RegestaPackageExport {
  if (value === null || typeof value === 'string') {
    return true
  }

  if (Array.isArray(value)) {
    return value.every((item) => isPackageExport(item))
  }

  if (value && typeof value === 'object') {
    return Object.values(value).every((item) => isPackageExport(item))
  }

  return false
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
