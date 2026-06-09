import { access, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, isAbsolute, join, posix, win32 } from 'node:path'
import { assertSourceArchivePath, type RegestaConfig } from '@regesta/protocol'
import * as tar from 'tar'

export const regestaConfigFile = 'regesta.json'

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

export async function temporaryDirectory(prefix: string): Promise<string> {
  const { mkdtemp } = await import('node:fs/promises')
  return mkdtemp(join(tmpdir(), `${prefix}-`))
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
  const requestedEntries = normalizeArchivePaths(
    config.source.include ?? defaultSourceEntries,
    'regesta source include',
  )
  const excludedEntries = normalizeArchivePaths(
    config.source.exclude ?? [],
    'regesta source exclude',
  )
  if (isExcluded(regestaConfigFile, excludedEntries)) {
    throw new TypeError('regesta source exclude must not exclude regesta.json')
  }
  const entries: string[] = []
  const requireEntries = Boolean(config.source.include)

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

function isExcluded(entry: string, excludedEntries: string[]): boolean {
  const normalizedEntry = trimTrailingSlashes(entry)
  return excludedEntries.some(
    (excluded) =>
      normalizedEntry === trimTrailingSlashes(excluded) ||
      normalizedEntry.startsWith(`${trimTrailingSlashes(excluded)}/`),
  )
}

function normalizeArchivePaths(entries: string[], field: string): string[] {
  return entries.map((entry) => normalizeArchivePath(entry, field))
}

function normalizeArchivePath(entry: string, field: string): string {
  assertSourceArchivePath(entry, `${field} paths`)

  if (isAbsolute(entry) || posix.isAbsolute(entry) || win32.isAbsolute(entry)) {
    throw new TypeError(`${field} paths must be relative`)
  }

  const normalized = posix.normalize(entry)
  if (normalized !== entry) {
    throw new TypeError(`${field} paths must be normalized`)
  }

  return entry
}

function trimTrailingSlashes(entry: string): string {
  return entry.replace(/\/+$/u, '')
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

async function temporaryTarballPath(prefix: string): Promise<string> {
  const dir = await temporaryDirectory(prefix)
  return join(dir, `${basename(dir)}.tgz`)
}
