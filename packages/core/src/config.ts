import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  canonicalJson,
  parsePackageCoordinate,
  sha256,
  type RegestaConfig,
  type RegestaPackageExport,
  type RegestaProvenance,
  type RegestaSourceConfig,
  type Sha256Digest,
} from '@regesta/protocol'

export const regestaConfigFile = 'regesta.json'

interface PackageJsonDefaults {
  description?: string
  exports?: RegestaPackageExport
  name?: string
  repository?: string
  version?: string
}

export async function readRegestaConfig(
  projectDir: string,
): Promise<RegestaConfig> {
  const raw = await readFile(join(projectDir, regestaConfigFile), 'utf8')
  const packageJson = await readPackageJsonDefaults(projectDir)
  return normalizeRegestaConfig(JSON.parse(raw), packageJson)
}

export function normalizeRegestaConfig(
  value: unknown,
  packageJson: PackageJsonDefaults = {},
): RegestaConfig {
  if (!value || typeof value !== 'object') {
    throw new TypeError('regesta.json must be an object')
  }

  const input = value as Record<string, unknown>

  if (input.schema !== undefined && input.schema !== 'regesta.config.v0') {
    throw new TypeError('regesta.json schema must be regesta.config.v0')
  }

  const packageName = input.package ?? packageJson.name
  if (typeof packageName !== 'string') {
    throw new TypeError(
      'regesta.json package must be a string or inherited from package.json name',
    )
  }

  const version = input.version ?? packageJson.version
  if (typeof version !== 'string' || version.length === 0) {
    throw new TypeError(
      'regesta.json version must be a non-empty string or inherited from package.json version',
    )
  }

  const config: RegestaConfig = {
    package: parsePackageCoordinate(packageName).coordinate,
    provenance: normalizeProvenance(input.provenance),
    schema: 'regesta.config.v0',
    source: normalizeSource(input),
    version,
  }

  const description = input.description ?? packageJson.description
  if (typeof description === 'string') {
    config.description = description
  }

  const repository = input.repository ?? packageJson.repository
  if (typeof repository === 'string') {
    config.repository = repository
  }

  if (Array.isArray(input.files)) {
    config.files = input.files.map((file) => {
      if (typeof file !== 'string' || file.length === 0) {
        throw new TypeError('regesta.json files must be non-empty strings')
      }

      return file
    })
  }

  const exportsValue = input.exports ?? packageJson.exports
  if (exportsValue !== undefined) {
    config.exports = normalizePackageExports(exportsValue)
  }

  const artifacts = normalizeArtifacts(input.artifacts)
  if (artifacts) {
    config.artifacts = artifacts
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

async function readPackageJsonDefaults(
  projectDir: string,
): Promise<PackageJsonDefaults> {
  try {
    const packageJson = JSON.parse(
      await readFile(join(projectDir, 'package.json'), 'utf8'),
    ) as Record<string, unknown>

    return {
      description:
        typeof packageJson.description === 'string'
          ? packageJson.description
          : undefined,
      exports:
        packageJson.exports === undefined
          ? undefined
          : normalizePackageExports(packageJson.exports),
      name: typeof packageJson.name === 'string' ? packageJson.name : undefined,
      repository: normalizeRepository(packageJson.repository),
      version:
        typeof packageJson.version === 'string'
          ? packageJson.version
          : undefined,
    }
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return {}
    }

    throw error
  }
}

function normalizeArtifacts(value: unknown): RegestaConfig['artifacts'] {
  if (value === undefined) {
    return undefined
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('regesta.json artifacts must be an object')
  }

  const input = value as Record<string, unknown>

  if (
    input.npmTarball === undefined ||
    input.npmTarball === null ||
    typeof input.npmTarball !== 'object' ||
    Array.isArray(input.npmTarball)
  ) {
    throw new TypeError('regesta.json artifacts.npmTarball must be an object')
  }

  const npmTarball = input.npmTarball as Record<string, unknown>
  if (npmTarball.path !== undefined && typeof npmTarball.path !== 'string') {
    throw new TypeError(
      'regesta.json artifacts.npmTarball.path must be a string',
    )
  }

  return {
    npmTarball: {
      ...(npmTarball.path ? { path: npmTarball.path } : {}),
    },
  }
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
  const compatibility = {
    packageManagers: normalizeStringArray(
      input.packageManagers,
      'regesta.json compatibility.packageManagers',
    ),
    runtimes: normalizeStringArray(
      input.runtimes,
      'regesta.json compatibility.runtimes',
    ),
  }

  return Object.fromEntries(
    Object.entries(compatibility).filter(([, item]) => item !== undefined),
  )
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
  const level =
    input.level ?? (input.command ? 'declared-build' : 'source-attached')

  if (level !== 'source-attached' && level !== 'declared-build') {
    throw new TypeError(
      'regesta.json provenance.level must be source-attached or declared-build',
    )
  }

  if (input.command !== undefined && typeof input.command !== 'string') {
    throw new TypeError('regesta.json provenance.command must be a string')
  }

  if (level === 'declared-build' && !input.command) {
    throw new TypeError(
      'regesta.json provenance.command is required for declared-build provenance',
    )
  }

  const provenance: RegestaProvenance = { level }

  if (typeof input.command === 'string') {
    provenance.command = input.command
  }

  const toolchain = normalizeToolchain(input.toolchain)
  if (toolchain) {
    provenance.toolchain = toolchain
  }

  return provenance
}

function normalizeRepository(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value
  }

  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const url = (value as Record<string, unknown>).url
    return typeof url === 'string' ? url : undefined
  }

  return undefined
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

function normalizeToolchain(
  value: unknown,
): Record<string, string> | undefined {
  if (value === undefined) {
    return undefined
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('regesta.json provenance.toolchain must be an object')
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => {
      if (typeof item !== 'string') {
        throw new TypeError(
          'regesta.json provenance.toolchain values must be strings',
        )
      }

      return [key, item]
    }),
  )
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
