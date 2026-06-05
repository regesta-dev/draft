import { Buffer } from 'node:buffer'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, readdir, readFile, rm } from 'node:fs/promises'
import { dirname, join, parse } from 'node:path'
import { promisify } from 'node:util'
import {
  createSourceArchive,
  normalizeRegestaConfig,
  regestaConfigFile,
  temporaryDirectory,
  type PublishArtifactInput,
  type RegestaConfigDefaults,
} from '@regesta/core'
import {
  parsePackageId,
  type ArtifactEcosystemMetadata,
  type NpmPackument,
  type NpmPackumentTime,
  type NpmReleaseMetadata,
  type PackageId,
  type RegestaConfig,
  type RegestaPackageExport,
  type ReleaseArtifact,
  type ReleaseManifest,
} from '@regesta/protocol'
import json5 from 'json5'
import * as tar from 'tar'
import type { ReadEntry } from 'tar'

const execFileAsync = promisify(execFile)

interface NpmPackageJsonDefaults extends RegestaConfigDefaults {
  name?: string
}

export interface NpmPackageManifestSnapshot {
  metadata?: NpmReleaseMetadata
  name?: string
  version?: string
}

export interface NpmPublishArtifactInput {
  bytes: Uint8Array
  role: string
}

export interface PreparedNpmPublish {
  artifacts: PublishArtifactInput[]
  config: RegestaConfig
  source: Uint8Array
}

export async function prepareNpmPublish(
  projectDir: string,
): Promise<PreparedNpmPublish> {
  const config = await readNpmRegestaConfig(projectDir)
  const sourceArchive = await createSourceArchive(projectDir, config)
  const tarball = await createNpmPackageTarball(projectDir)

  return {
    artifacts: [
      {
        bytes: tarball.bytes,
        filename: tarball.entries[0],
        format: 'npm-tarball',
        mediaType: 'application/gzip',
        role: 'install',
      },
    ],
    config,
    source: sourceArchive.bytes,
  }
}

export async function readNpmRegestaConfig(
  projectDir: string,
): Promise<RegestaConfig> {
  const raw = await readFile(join(projectDir, regestaConfigFile), 'utf8')
  const packageJson = await readNpmPackageJsonDefaults(projectDir)
  const config = normalizeRegestaConfig(
    normalizeNpmRegestaConfigInput(json5.parse<unknown>(raw), packageJson.name),
    {
      description: packageJson.description,
      exports: packageJson.exports,
      repository: packageJson.repository,
      version: packageJson.version,
    },
  )
  const packageId = parsePackageId(config.id)

  if (packageId.ecosystem !== 'npm') {
    throw new TypeError(
      `npm publish config must use npm ecosystem: ${config.id}`,
    )
  }

  return config
}

export async function createNpmPackageTarball(
  projectDir: string,
): Promise<{ bytes: Uint8Array; entries: string[] }> {
  const outputDir = await temporaryDirectory('regesta-package')

  try {
    await runPackagePack(projectDir, outputDir)

    const tarballs = (await readdir(outputDir)).filter((file) =>
      file.endsWith('.tgz'),
    )

    if (tarballs.length !== 1) {
      throw new Error(
        `Package manager pack must produce exactly one .tgz file, found ${tarballs.length}`,
      )
    }

    const tarball = tarballs[0]!

    return {
      bytes: await readFile(join(outputDir, tarball)),
      entries: [tarball],
    }
  } finally {
    await rm(outputDir, { force: true, recursive: true })
  }
}

export function createNpmPackument(
  packageId: PackageId,
  releases: Array<{ manifest: ReleaseManifest }>,
  registryBaseUrl: string,
  channels: Record<string, string> = {},
  modifiedAt?: string,
): NpmPackument {
  const packageName = npmPackageName(packageId)
  const sortedReleases = releases.toSorted((left, right) =>
    left.manifest.createdAt.localeCompare(right.manifest.createdAt),
  )
  const latest = sortedReleases.at(-1)
  const distTags =
    Object.keys(channels).length === 0 && latest
      ? { latest: latest.manifest.version }
      : channels

  return {
    'dist-tags': distTags,
    name: packageName,
    time: npmPackumentTime(sortedReleases, modifiedAt),
    versions: Object.fromEntries(
      sortedReleases.map((release) => [
        release.manifest.version,
        {
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
          ...npmInstallArtifact(release.manifest).ecosystemMetadata?.npm,
          name: packageName,
          version: release.manifest.version,
        },
      ]),
    ),
  }
}

export async function extractNpmArtifactEcosystemMetadata(
  config: RegestaConfig,
  artifacts: NpmPublishArtifactInput[],
): Promise<ArtifactEcosystemMetadata | undefined> {
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

  if (npmManifest.name !== undefined && npmManifest.name !== packageName) {
    throw new TypeError(
      `npm package.json name must match package id projection: ${packageName}`,
    )
  }

  if (
    npmManifest.version !== undefined &&
    npmManifest.version !== config.version
  ) {
    throw new TypeError(
      `npm package.json version must match release version: ${config.version}`,
    )
  }

  return npmManifest.metadata ? { npm: npmManifest.metadata } : undefined
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
  const rawPackageJson = await readPackageJsonEntry(bytes)

  if (!rawPackageJson) {
    throw new TypeError(
      'npm install artifact must include package/package.json',
    )
  }

  const value: unknown = JSON.parse(rawPackageJson)
  return normalizeNpmPackageManifest(value)
}

async function readNpmPackageJsonDefaults(
  projectDir: string,
): Promise<NpmPackageJsonDefaults> {
  try {
    const packageJson: unknown = JSON.parse(
      await readFile(join(projectDir, 'package.json'), 'utf8'),
    )

    if (!isRecord(packageJson)) {
      return {}
    }

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

function normalizeNpmRegestaConfigInput(
  value: unknown,
  packageJsonName: string | undefined,
): unknown {
  if (!isRecord(value)) {
    return value
  }

  const id = value.id ?? value.package

  if (typeof id === 'string' && !id.includes(':')) {
    return { ...value, id: npmPackageIdFromName(id) }
  }

  if (id === undefined && packageJsonName) {
    return { ...value, id: npmPackageIdFromName(packageJsonName) }
  }

  return value
}

async function runPackagePack(
  projectDir: string,
  outputDir: string,
): Promise<void> {
  const packageManager = await detectPackageManager(projectDir)

  if (packageManager === 'pnpm') {
    await execFileAsync('pnpm', ['pack', '--pack-destination', outputDir], {
      cwd: projectDir,
    })
    return
  }

  if (packageManager === 'npm') {
    await execFileAsync('npm', ['pack', '--pack-destination', outputDir], {
      cwd: projectDir,
    })
    return
  }

  throw new Error(
    `Unsupported package manager for npm tarball generation: ${packageManager}`,
  )
}

async function detectPackageManager(projectDir: string): Promise<string> {
  const fromPackageJson = await findPackageManagerField(projectDir)

  if (fromPackageJson) {
    return fromPackageJson
  }

  if (await exists(join(projectDir, 'pnpm-lock.yaml'))) {
    return 'pnpm'
  }

  if (await exists(join(projectDir, 'package-lock.json'))) {
    return 'npm'
  }

  return 'npm'
}

async function findPackageManagerField(
  projectDir: string,
): Promise<string | undefined> {
  let current = projectDir

  while (true) {
    try {
      const packageJson: unknown = JSON.parse(
        await readFile(join(current, 'package.json'), 'utf8'),
      )

      if (
        isRecord(packageJson) &&
        typeof packageJson.packageManager === 'string'
      ) {
        return packageJson.packageManager.split('@')[0]
      }
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !('code' in error) ||
        error.code !== 'ENOENT'
      ) {
        throw error
      }
    }

    const parent = dirname(current)

    if (parent === current || parse(parent).root === parent) {
      return undefined
    }

    current = parent
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
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
    metadata: Object.keys(metadata).length === 0 ? undefined : metadata,
    name: typeof value.name === 'string' ? value.name : undefined,
    version: typeof value.version === 'string' ? value.version : undefined,
  }
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

function normalizePackageExports(value: unknown): RegestaPackageExport {
  if (!isPackageExport(value)) {
    throw new TypeError(
      'package exports must be JSON string, null, array, or object values',
    )
  }

  return value
}

function normalizeRepository(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value
  }

  if (isRecord(value)) {
    const { url } = value
    return typeof url === 'string' ? url : undefined
  }

  return undefined
}

function isPackageExport(value: unknown): value is RegestaPackageExport {
  if (value === null || typeof value === 'string') {
    return true
  }

  if (Array.isArray(value)) {
    return value.every((item) => isPackageExport(item))
  }

  if (isRecord(value)) {
    return Object.values(value).every((item) => isPackageExport(item))
  }

  return false
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
