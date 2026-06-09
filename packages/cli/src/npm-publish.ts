import { execFile } from 'node:child_process'
import { access, readdir, readFile, rm } from 'node:fs/promises'
import { dirname, join, parse } from 'node:path'
import { promisify } from 'node:util'
import {
  normalizeRegestaConfig,
  type PublishArtifactInput,
} from '@regesta/core'
import { npmPackageIdFromName } from '@regesta/npm'
import {
  parsePackageId,
  type RegestaConfig,
  type RegestaPackageExport,
} from '@regesta/protocol'
import json5 from 'json5'
import {
  createSourceArchive,
  regestaConfigFile,
  temporaryDirectory,
} from './source-archive.ts'

const execFileAsync = promisify(execFile)

interface NpmPackageJsonDefaults {
  description?: string
  exports?: RegestaPackageExport
  name?: string
  repository?: string
  version?: string
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

  const id = value.id

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
