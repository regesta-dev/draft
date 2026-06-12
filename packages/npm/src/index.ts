import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import {
  parsePackageId,
  type ArtifactEcosystemMetadata,
  type PackageId,
  type RegestaConfig,
  type ReleaseArtifact,
  type ReleaseManifest,
} from '@regesta/protocol'
import * as tar from 'tar'
import type { ReadEntry } from 'tar'

export interface NpmReleaseMetadata {
  bin?: string | Record<string, string>
  bundleDependencies?: boolean | string[]
  bundledDependencies?: string[]
  cpu?: string[]
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  engines?: Record<string, string>
  libc?: string[]
  optionalDependencies?: Record<string, string>
  os?: string[]
  peerDependencies?: Record<string, string>
  peerDependenciesMeta?: Record<string, NpmPeerDependencyMeta>
}

export interface NpmPeerDependencyMeta {
  optional?: boolean
}

export interface NpmPackument {
  'dist-tags': Record<string, string>
  description?: string
  name: string
  time: NpmPackumentTime
  versions: Record<string, NpmPackumentVersion>
}

export interface NpmPackumentTime {
  created: string
  modified: string
  [version: string]: string
}

export interface NpmPackumentVersion extends NpmReleaseMetadata {
  description?: string
  dist: {
    integrity: string
    tarball: string
  }
  name: string
  version: string
}

export interface NpmPackageManifestSnapshot {
  description?: string
  metadata?: NpmReleaseMetadata
  name?: string
  version?: string
}

export interface NpmPublishArtifactInput {
  bytes: Uint8Array
  role: string
}

export interface NpmArtifactProcessingResult {
  description?: string
  ecosystemMetadata?: ArtifactEcosystemMetadata
}

const npmReleaseMetadataFields = [
  'bin',
  'bundleDependencies',
  'bundledDependencies',
  'cpu',
  'dependencies',
  'devDependencies',
  'engines',
  'libc',
  'optionalDependencies',
  'os',
  'peerDependencies',
  'peerDependenciesMeta',
] as const satisfies ReadonlyArray<keyof NpmReleaseMetadata>

export function createNpmPackument(
  packageId: PackageId,
  releases: Array<{ manifest: ReleaseManifest }>,
  registryBaseUrl: string,
  channels: Record<string, string> = {},
  modifiedAt?: string,
): NpmPackument {
  const packageName = npmPackageName(packageId)
  for (const release of releases) {
    assertNpmReleaseMatchesPackage(packageId, release.manifest)
  }
  const sortedReleases = releases.toSorted((left, right) =>
    left.manifest.createdAt.localeCompare(right.manifest.createdAt),
  )
  const latest = sortedReleases.at(-1)
  const knownVersions = new Set(
    sortedReleases.map((release) => release.manifest.version),
  )
  const projectedChannels = Object.fromEntries(
    Object.entries(channels).filter(([, version]) => {
      return knownVersions.has(version)
    }),
  )
  const distTags =
    Object.keys(projectedChannels).length > 0
      ? projectedChannels
      : latest
        ? { latest: latest.manifest.version }
        : {}

  return {
    'dist-tags': distTags,
    ...npmDescription(latest?.manifest),
    name: packageName,
    time: npmPackumentTime(sortedReleases, modifiedAt),
    versions: Object.fromEntries(
      sortedReleases.map((release) => [
        release.manifest.version,
        {
          ...npmDescription(release.manifest),
          dist: {
            integrity: integrityFromDigest(
              npmInstallArtifact(release.manifest).digest,
            ),
            tarball: tarballUrl(
              packageId,
              release.manifest.version,
              registryBaseUrl,
            ),
          },
          ...npmArtifactMetadata(npmInstallArtifact(release.manifest)),
          name: packageName,
          version: release.manifest.version,
        },
      ]),
    ),
  }
}

function npmDescription(
  manifest: ReleaseManifest | undefined,
): Pick<NpmPackument, 'description'> | Record<string, never> {
  if (manifest?.metadata?.description === undefined) {
    return {}
  }

  return {
    description: manifest.metadata.description,
  }
}

function assertNpmReleaseMatchesPackage(
  packageId: PackageId,
  manifest: ReleaseManifest,
): void {
  const parsed = parsePackageId(packageId)

  if (
    manifest.id !== packageId ||
    manifest.ecosystem !== parsed.ecosystem ||
    manifest.name !== parsed.name
  ) {
    throw new Error(
      `Release manifest does not match npm package id: ${packageId}`,
    )
  }
}

export async function extractNpmArtifactEcosystemMetadata(
  config: RegestaConfig,
  artifacts: NpmPublishArtifactInput[],
): Promise<ArtifactEcosystemMetadata | undefined> {
  return (await processNpmPublishArtifacts(config, artifacts))
    ?.ecosystemMetadata
}

export async function processNpmPublishArtifacts(
  config: RegestaConfig,
  artifacts: NpmPublishArtifactInput[],
): Promise<NpmArtifactProcessingResult | undefined> {
  const packageId = parsePackageId(config.id)

  if (packageId.ecosystem !== 'npm') {
    return undefined
  }

  const artifact = artifacts.find((item) => {
    return item.role === 'install'
  })

  if (!artifact) {
    return undefined
  }

  const npmManifest = await readNpmPackageManifestFromTarball(artifact.bytes)

  const packageName = npmPackageName(config.id)

  if (npmManifest.name === undefined) {
    throw new TypeError('npm package.json name is required')
  }

  if (npmManifest.name !== packageName) {
    throw new TypeError(
      `npm package.json name must match package id projection: ${packageName}`,
    )
  }

  if (npmManifest.version === undefined) {
    throw new TypeError('npm package.json version is required')
  }

  if (npmManifest.version !== config.version) {
    throw new TypeError(
      `npm package.json version must match release version: ${config.version}`,
    )
  }

  const result: NpmArtifactProcessingResult = {}

  if (npmManifest.description !== undefined) {
    result.description = npmManifest.description
  }

  if (npmManifest.metadata) {
    result.ecosystemMetadata = { npm: npmManifest.metadata }
  }

  return result
}

export function integrityFromBytes(bytes: Uint8Array): string {
  return `sha512-${createHash('sha512').update(bytes).digest('base64')}`
}

export function integrityFromDigest(digest: string): string {
  return `sha256-${Buffer.from(digest.slice('sha256:'.length), 'hex').toString('base64')}`
}

export function npmInstallArtifact(manifest: ReleaseManifest): ReleaseArtifact {
  const artifact = manifest.artifacts.find((item) => {
    return item.role === 'install'
  })

  if (!artifact) {
    throw new Error(`Release has no npm install artifact: ${manifest.id}`)
  }

  return artifact
}

function npmArtifactMetadata(
  artifact: ReleaseArtifact,
): NpmReleaseMetadata | undefined {
  const metadata = artifact.ecosystemMetadata?.npm
  if (!isNpmReleaseMetadata(metadata)) {
    return undefined
  }

  return pickNpmReleaseMetadata(metadata)
}

function pickNpmReleaseMetadata(
  metadata: NpmReleaseMetadata,
): NpmReleaseMetadata | undefined {
  const output: NpmReleaseMetadata = {}

  for (const field of npmReleaseMetadataFields) {
    copyNpmReleaseMetadataField(output, metadata, field)
  }

  return Object.keys(output).length === 0 ? undefined : output
}

function copyNpmReleaseMetadataField<Field extends keyof NpmReleaseMetadata>(
  output: NpmReleaseMetadata,
  metadata: NpmReleaseMetadata,
  field: Field,
): void {
  const value = metadata[field]

  if (value !== undefined) {
    output[field] = value
  }
}

export function npmPackageName(packageId: PackageId): string {
  const parsed = parsePackageId(packageId)

  if (parsed.ecosystem !== 'npm') {
    throw new Error(`Package is not in the npm ecosystem: ${packageId}`)
  }

  return `@${parsed.name}`
}

export function npmPackageIdFromName(packageName: string): PackageId {
  const match = /^@([^/]+\/[^/]+)$/u.exec(packageName)

  if (!match) {
    throw new TypeError(
      `npm package name must be domain-scoped: ${packageName}`,
    )
  }

  return parsePackageId(`npm:${match[1]}`).id
}

export function tarballFileName(packageId: PackageId, version: string): string {
  const name = npmPackageName(packageId).split('/').at(-1)!
  return `${name}-${version}.tgz`
}

export function tarballUrl(
  packageId: PackageId,
  version: string,
  registryBaseUrl: string,
): string {
  const baseUrl = registryBaseUrl.endsWith('/')
    ? registryBaseUrl.slice(0, -1)
    : registryBaseUrl

  return `${baseUrl}/${npmPackageName(packageId)}/-/${tarballFileName(packageId, version)}`
}

export async function readNpmPackageManifestFromTarball(
  bytes: Uint8Array,
): Promise<NpmPackageManifestSnapshot> {
  let rawPackageJson: string | undefined

  try {
    rawPackageJson = await readPackageJsonEntry(bytes)
  } catch {
    throw new TypeError('npm install artifact must be a readable tarball')
  }

  if (!rawPackageJson) {
    throw new TypeError(
      'npm install artifact must include package/package.json',
    )
  }

  let value: unknown

  try {
    value = JSON.parse(rawPackageJson)
  } catch {
    throw new TypeError('npm package.json must be valid JSON')
  }

  return normalizeNpmPackageManifest(value)
}

function npmPackumentTime(
  releases: Array<{ manifest: ReleaseManifest }>,
  modifiedAt?: string,
): NpmPackumentTime {
  const firstRelease = releases[0]
  const latestRelease = releases.at(-1)
  const releaseModifiedAt = latestRelease?.manifest.createdAt
  const modified = latestTimestamp([releaseModifiedAt, modifiedAt])

  return {
    created: firstRelease?.manifest.createdAt ?? modified,
    modified,
    ...Object.fromEntries(
      releases.map((release) => [
        release.manifest.version,
        release.manifest.createdAt,
      ]),
    ),
  }
}

function latestTimestamp(timestamps: Array<string | undefined>): string {
  return (
    timestamps
      .filter((timestamp) => timestamp !== undefined)
      .toSorted()
      .at(-1) ?? ''
  )
}

function readPackageJsonEntry(bytes: Uint8Array): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    let rawPackageJson: string | undefined
    const parser = new tar.Parser()

    parser.on('entry', (entry: ReadEntry) => {
      if (!isRootPackageJsonEntry(entry.path)) {
        entry.resume()
        return
      }

      const chunks: Buffer[] = []

      entry.on('data', (chunk: Buffer) => {
        chunks.push(Buffer.from(chunk))
      })
      entry.on('end', () => {
        rawPackageJson = Buffer.concat(chunks).toString('utf8')
      })
      entry.on('error', reject)
    })
    parser.on('error', reject)
    parser.on('end', () => {
      resolve(rawPackageJson)
    })
    parser.end(Buffer.from(bytes))
  })
}

function isRootPackageJsonEntry(path: string): boolean {
  return path === 'package/package.json' || path === 'package.json'
}

function normalizeNpmPackageManifest(
  value: unknown,
): NpmPackageManifestSnapshot {
  if (!isRecord(value)) {
    throw new TypeError('npm package.json must be an object')
  }

  const metadata: NpmReleaseMetadata = {}
  const dependencies = normalizeStringMap(
    value.dependencies,
    'npm package.json dependencies',
  )
  const optionalDependencies = normalizeStringMap(
    value.optionalDependencies,
    'npm package.json optionalDependencies',
  )
  const devDependencies = normalizeStringMap(
    value.devDependencies,
    'npm package.json devDependencies',
  )
  const peerDependencies = normalizeStringMap(
    value.peerDependencies,
    'npm package.json peerDependencies',
  )
  const peerDependenciesMeta = normalizePeerDependenciesMeta(
    value.peerDependenciesMeta,
  )
  const engines = normalizeStringMap(value.engines, 'npm package.json engines')
  const os = normalizeStringArray(value.os, 'npm package.json os')
  const cpu = normalizeStringArray(value.cpu, 'npm package.json cpu')
  const libc = normalizeStringArray(value.libc, 'npm package.json libc')
  const bundledDependencies = normalizeStringArray(
    value.bundledDependencies,
    'npm package.json bundledDependencies',
  )
  const bundleDependencies = normalizeBundleDependencies(
    value.bundleDependencies,
  )
  const bin = normalizeBin(value.bin)

  if (dependencies) {
    metadata.dependencies = dependencies
  }

  if (optionalDependencies) {
    metadata.optionalDependencies = optionalDependencies
  }

  if (devDependencies) {
    metadata.devDependencies = devDependencies
  }

  if (peerDependencies) {
    metadata.peerDependencies = peerDependencies
  }

  if (peerDependenciesMeta) {
    metadata.peerDependenciesMeta = peerDependenciesMeta
  }

  if (engines) {
    metadata.engines = engines
  }

  if (os) {
    metadata.os = os
  }

  if (cpu) {
    metadata.cpu = cpu
  }

  if (libc) {
    metadata.libc = libc
  }

  if (bundledDependencies) {
    metadata.bundledDependencies = bundledDependencies
  }

  if (bundleDependencies !== undefined) {
    metadata.bundleDependencies = bundleDependencies
  }

  if (bin) {
    metadata.bin = bin
  }

  return {
    description:
      typeof value.description === 'string' ? value.description : undefined,
    metadata: Object.keys(metadata).length === 0 ? undefined : metadata,
    name: typeof value.name === 'string' ? value.name : undefined,
    version: typeof value.version === 'string' ? value.version : undefined,
  }
}

function isNpmReleaseMetadata(value: unknown): value is NpmReleaseMetadata {
  if (!isRecord(value)) {
    return false
  }

  return (
    isOptionalStringOrStringMap(value.bin) &&
    isOptionalBooleanOrStringArray(value.bundleDependencies) &&
    isOptionalStringArray(value.bundledDependencies) &&
    isOptionalStringArray(value.cpu) &&
    isOptionalStringMap(value.dependencies) &&
    isOptionalStringMap(value.devDependencies) &&
    isOptionalStringMap(value.engines) &&
    isOptionalStringArray(value.libc) &&
    isOptionalStringMap(value.optionalDependencies) &&
    isOptionalStringArray(value.os) &&
    isOptionalStringMap(value.peerDependencies) &&
    isOptionalPeerDependenciesMeta(value.peerDependenciesMeta)
  )
}

function isOptionalStringMap(
  value: unknown,
): value is Record<string, string> | undefined {
  if (value === undefined) {
    return true
  }

  return (
    isRecord(value) &&
    Object.values(value).every((item) => {
      return typeof item === 'string'
    })
  )
}

function isOptionalStringArray(value: unknown): value is string[] | undefined {
  if (value === undefined) {
    return true
  }

  return (
    Array.isArray(value) &&
    value.every((item) => {
      return typeof item === 'string'
    })
  )
}

function isOptionalStringOrStringMap(
  value: unknown,
): value is NpmReleaseMetadata['bin'] {
  return typeof value === 'string' || isOptionalStringMap(value)
}

function isOptionalBooleanOrStringArray(
  value: unknown,
): value is NpmReleaseMetadata['bundleDependencies'] {
  return typeof value === 'boolean' || isOptionalStringArray(value)
}

function isOptionalPeerDependenciesMeta(
  value: unknown,
): value is Record<string, NpmPeerDependencyMeta> | undefined {
  if (value === undefined) {
    return true
  }

  return (
    isRecord(value) &&
    Object.values(value).every((item) => {
      return (
        isRecord(item) &&
        (item.optional === undefined || typeof item.optional === 'boolean')
      )
    })
  )
}

function normalizeStringMap(
  value: unknown,
  field: string,
): Record<string, string> | undefined {
  if (value === undefined) {
    return undefined
  }

  if (!isRecord(value)) {
    throw new TypeError(`${field} must be an object`)
  }

  const output: Record<string, string> = {}

  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== 'string') {
      throw new TypeError(`${field}.${key} must be a string`)
    }

    output[key] = item
  }

  return Object.keys(output).length === 0 ? undefined : output
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

  const output: string[] = []

  for (const item of value) {
    if (typeof item !== 'string') {
      throw new TypeError(`${field} must contain only strings`)
    }

    output.push(item)
  }

  return output.length === 0 ? undefined : output
}

function normalizeBundleDependencies(
  value: unknown,
): boolean | string[] | undefined {
  if (value === undefined) {
    return undefined
  }

  if (typeof value === 'boolean') {
    return value
  }

  return normalizeStringArray(value, 'npm package.json bundleDependencies')
}

function normalizeBin(value: unknown): NpmReleaseMetadata['bin'] | undefined {
  if (value === undefined) {
    return undefined
  }

  if (typeof value === 'string') {
    return value
  }

  return normalizeStringMap(value, 'npm package.json bin')
}

function normalizePeerDependenciesMeta(
  value: unknown,
): Record<string, { optional?: boolean }> | undefined {
  if (value === undefined) {
    return undefined
  }

  if (!isRecord(value)) {
    throw new TypeError(
      'npm package.json peerDependenciesMeta must be an object',
    )
  }

  const output: Record<string, { optional?: boolean }> = {}

  for (const [name, item] of Object.entries(value)) {
    if (!isRecord(item)) {
      throw new TypeError(
        `npm package.json peerDependenciesMeta.${name} must be an object`,
      )
    }

    const meta: { optional?: boolean } = {}

    if (item.optional !== undefined) {
      if (typeof item.optional !== 'boolean') {
        throw new TypeError(
          `npm package.json peerDependenciesMeta.${name}.optional must be a boolean`,
        )
      }

      meta.optional = item.optional
    }

    if (Object.keys(meta).length > 0) {
      output[name] = meta
    }
  }

  return Object.keys(output).length === 0 ? undefined : output
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
