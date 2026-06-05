import { access, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
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

export async function temporaryDirectory(prefix: string): Promise<string> {
  const { mkdtemp } = await import('node:fs/promises')
  return mkdtemp(join(tmpdir(), `${prefix}-`))
}

async function temporaryTarballPath(prefix: string): Promise<string> {
  const dir = await temporaryDirectory(prefix)
  return join(dir, `${basename(dir)}.tgz`)
}
