import {
  access,
  cp,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, relative } from 'node:path'
import * as tar from 'tar'
import { regestaConfigFile } from './config.ts'
import type { RegestaConfig } from '@regesta/protocol'

const defaultSourceEntries = [
  regestaConfigFile,
  'package.json',
  'README.md',
  'LICENSE',
  'src',
]

export interface PreparedArchive {
  bytes: Uint8Array
  entries: string[]
}

export async function createSourceArchive(
  projectDir: string,
  config: RegestaConfig,
): Promise<PreparedArchive> {
  const entries = await resolveArchiveEntries(projectDir, config)
  const file = await temporaryTarballPath('regesta-source')

  await tar.create(tarOptions(projectDir, file, config.source.exclude), entries)

  const bytes = await readArchiveAndCleanup(file)
  return { bytes, entries }
}

export async function createNpmTarball(
  projectDir: string,
  config: RegestaConfig,
): Promise<PreparedArchive> {
  const configuredPath = config.artifacts?.npmTarball?.path
  if (configuredPath) {
    return {
      bytes: await readFile(join(projectDir, configuredPath)),
      entries: [configuredPath],
    }
  }

  const entries = await resolveArchiveEntries(projectDir, config)
  const tempRoot = await temporaryDirectory('regesta-npm')
  const packageRoot = join(tempRoot, 'package')

  await mkdir(packageRoot, { recursive: true })

  for (const entry of entries) {
    if (entry === 'package.json') {
      continue
    }

    await cp(join(projectDir, entry), join(packageRoot, entry), {
      filter: (source) => {
        return !isExcluded(
          relative(projectDir, source),
          config.source.exclude ?? [],
        )
      },
      recursive: true,
    })
  }

  await writeFile(
    join(packageRoot, 'package.json'),
    `${JSON.stringify(createNpmPackageJson(config), null, 2)}\n`,
  )

  const file = await temporaryTarballPath('regesta-npm-package')
  await tar.create(tarOptions(tempRoot, file), ['package'])

  const bytes = await readArchiveAndCleanup(file)
  await rm(tempRoot, { force: true, recursive: true })

  return { bytes, entries }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function readArchiveAndCleanup(file: string): Promise<Uint8Array> {
  const bytes = await readFile(file)
  await rm(file, { force: true })
  return bytes
}

async function resolveArchiveEntries(
  projectDir: string,
  config: RegestaConfig,
): Promise<string[]> {
  const requestedEntries =
    config.source.include ?? config.files ?? defaultSourceEntries
  const excludedEntries = config.source.exclude ?? []
  const entries: string[] = []
  const requireEntries = Boolean(config.source.include || config.files)

  for (const entry of requestedEntries) {
    if (isExcluded(entry, excludedEntries)) {
      continue
    }

    const fullPath = join(projectDir, entry)

    if (requireEntries) {
      await stat(fullPath)
      entries.push(entry)
    } else if (await exists(fullPath)) {
      entries.push(entry)
    }
  }

  if (!entries.includes(regestaConfigFile)) {
    entries.unshift(regestaConfigFile)
  }

  return [...new Set(entries)].toSorted()
}

function createNpmPackageJson(config: RegestaConfig): Record<string, unknown> {
  const packageJson: Record<string, unknown> = {
    name: config.package,
    version: config.version,
    type: 'module',
  }

  if (config.description) {
    packageJson.description = config.description
  }

  if (config.exports) {
    packageJson.exports = config.exports
  }

  if (config.repository) {
    packageJson.repository = config.repository
  }

  return packageJson
}

function isExcluded(entry: string, excludedEntries: string[]): boolean {
  return excludedEntries.some(
    (excluded) => entry === excluded || entry.startsWith(`${excluded}/`),
  )
}

function tarOptions(cwd: string, file: string, excludedEntries: string[] = []) {
  return {
    cwd,
    file,
    filter: (path: string) => !isExcluded(path, excludedEntries),
    gzip: true,
    mtime: new Date(0),
    noMtime: false,
    portable: true,
  }
}

async function temporaryDirectory(prefix: string): Promise<string> {
  const { mkdtemp } = await import('node:fs/promises')
  return mkdtemp(join(tmpdir(), `${prefix}-`))
}

async function temporaryTarballPath(prefix: string): Promise<string> {
  const dir = await temporaryDirectory(prefix)
  return join(dir, `${basename(dir)}.tgz`)
}
