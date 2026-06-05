import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  canonicalJson,
  parsePackageId,
  sha256,
  type AbiCompatibility,
  type RegestaCompatibility,
  type RegestaConfig,
  type RegestaPackageExport,
  type RegestaProvenance,
  type RegestaSourceConfig,
  type RuntimeCompatibility,
  type Sha256Digest,
} from '@regesta/protocol'
import json5 from 'json5'

export const regestaConfigFile = 'regesta.json'

export interface RegestaConfigDefaults {
  description?: string
  exports?: RegestaPackageExport
  id?: string
  repository?: string
  version?: string
}

export async function readRegestaConfig(
  projectDir: string,
  defaults: RegestaConfigDefaults = {},
): Promise<RegestaConfig> {
  const raw = await readFile(join(projectDir, regestaConfigFile), 'utf8')
  return normalizeRegestaConfig(json5.parse<unknown>(raw), defaults)
}

export function normalizeRegestaConfig(
  value: unknown,
  defaults: RegestaConfigDefaults = {},
): RegestaConfig {
  if (!value || typeof value !== 'object') {
    throw new TypeError('regesta.json must be an object')
  }

  const input = value as Record<string, unknown>

  const id = normalizeConfigId(input.id ?? input.package ?? defaults.id)
  if (id === undefined) {
    throw new TypeError('regesta.json id must be a package id string')
  }

  const version = input.version ?? defaults.version
  if (typeof version !== 'string' || version.length === 0) {
    throw new TypeError('regesta.json version must be a non-empty string')
  }

  const config: RegestaConfig = {
    id,
    provenance: normalizeProvenance(input.provenance),
    source: normalizeSource(input),
    version,
  }

  const description = input.description ?? defaults.description
  if (typeof description === 'string') {
    config.description = description
  }

  const repository = input.repository ?? defaults.repository
  if (typeof repository === 'string') {
    config.repository = repository
  }

  if (Array.isArray(input.files)) {
    config.files = normalizeFiles(input.files)
  }

  const languages = normalizeStringArray(
    input.languages,
    'regesta.json languages',
  )
  if (languages) {
    config.languages = languages
  }

  const exportsValue = input.exports ?? defaults.exports
  if (exportsValue !== undefined) {
    config.exports = normalizePackageExports(exportsValue)
  }

  if (typeof input.family === 'string') {
    config.family = input.family
  }

  const compatibility = normalizeCompatibility(input.compatibility)
  if (compatibility) {
    config.compatibility = compatibility
  }

  return config
}

export function configDigest(config: RegestaConfig): Sha256Digest {
  return sha256(canonicalJson(config as never))
}

function normalizeCompatibility(
  value: unknown,
): RegestaConfig['compatibility'] {
  if (value === undefined) {
    return undefined
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('regesta.json compatibility must be an object')
  }

  const input = value as Record<string, unknown>
  const compatibility: RegestaCompatibility = {
    abi: normalizeAbiArray(input.abi),
    modules: normalizeStringArray(
      input.modules,
      'regesta.json compatibility.modules',
    ),
    platforms: normalizePlatformArray(input.platforms),
    runtimes: normalizeRuntimeArray(input.runtimes),
  }

  const normalized = Object.fromEntries(
    Object.entries(compatibility).filter(([, item]) => item !== undefined),
  ) as RegestaCompatibility

  return Object.keys(normalized).length === 0 ? undefined : normalized
}

function normalizeAbiArray(value: unknown): AbiCompatibility[] | undefined {
  if (value === undefined) {
    return undefined
  }

  if (!Array.isArray(value)) {
    throw new TypeError('regesta.json compatibility.abi must be an array')
  }

  return value.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new TypeError(
        'regesta.json compatibility.abi items must be objects',
      )
    }

    const input = item as Record<string, unknown>
    if (typeof input.name !== 'string' || input.name.length === 0) {
      throw new TypeError(
        'regesta.json compatibility.abi items must include a name',
      )
    }

    const versions = normalizeStringArray(
      input.versions,
      'regesta.json compatibility.abi.versions',
    )

    return {
      name: input.name,
      ...(versions ? { versions } : {}),
    }
  })
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

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('regesta.json provenance must be an object')
  }

  const input = value as Record<string, unknown>
  const level = input.level ?? 'source-attached'

  if (level !== 'source-attached') {
    throw new TypeError('regesta.json provenance.level must be source-attached')
  }

  return { level }
}

function normalizePlatformArray(
  value: unknown,
): RegestaCompatibility['platforms'] {
  if (value === undefined) {
    return undefined
  }

  if (!Array.isArray(value)) {
    throw new TypeError('regesta.json compatibility.platforms must be an array')
  }

  return value.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new TypeError(
        'regesta.json compatibility.platforms items must be objects',
      )
    }

    const input = item as Record<string, unknown>
    const arch = normalizeStringArray(
      input.arch,
      'regesta.json compatibility.platforms.arch',
    )
    const libc = normalizeStringArray(
      input.libc,
      'regesta.json compatibility.platforms.libc',
    )
    const os = normalizeStringArray(
      input.os,
      'regesta.json compatibility.platforms.os',
    )

    return {
      ...(arch ? { arch } : {}),
      ...(libc ? { libc } : {}),
      ...(os ? { os } : {}),
    }
  })
}

function normalizeSource(input: Record<string, unknown>): RegestaSourceConfig {
  if (input.source === undefined) {
    return {
      ...(Array.isArray(input.files)
        ? { include: normalizeFiles(input.files) }
        : {}),
    }
  }

  if (
    !input.source ||
    typeof input.source !== 'object' ||
    Array.isArray(input.source)
  ) {
    throw new TypeError('regesta.json source must be an object')
  }

  const source = input.source as Record<string, unknown>
  const config: RegestaSourceConfig = {}

  if (source.exclude !== undefined) {
    config.exclude = normalizeStringArray(
      source.exclude,
      'regesta.json source.exclude',
    )
  }

  if (source.include !== undefined) {
    config.include = normalizeStringArray(
      source.include,
      'regesta.json source.include',
    )
  }

  return config
}

function normalizeRuntimeArray(
  value: unknown,
): RuntimeCompatibility[] | undefined {
  if (value === undefined) {
    return undefined
  }

  if (!Array.isArray(value)) {
    throw new TypeError('regesta.json compatibility.runtimes must be an array')
  }

  return value.map((item) => {
    if (typeof item === 'string') {
      return normalizeString(item, 'compatibility.runtimes')
    }

    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new TypeError(
        'regesta.json compatibility.runtimes items must be strings or objects',
      )
    }

    const input = item as Record<string, unknown>
    if (typeof input.name !== 'string' || input.name.length === 0) {
      throw new TypeError(
        'regesta.json compatibility.runtimes items must include a name',
      )
    }

    const conditions = normalizeStringArray(
      input.conditions,
      'regesta.json compatibility.runtimes.conditions',
    )

    return {
      ...(conditions ? { conditions } : {}),
      name: input.name,
      ...(input.versions === undefined
        ? {}
        : { versions: normalizeString(input.versions, 'versions') }),
    }
  })
}

function normalizeFiles(value: unknown[]): string[] {
  return value.map((file) => {
    if (typeof file !== 'string' || file.length === 0) {
      throw new TypeError('regesta.json files must be non-empty strings')
    }

    return file
  })
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

function normalizeString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`regesta.json ${field} must be a non-empty string`)
  }

  return value
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
