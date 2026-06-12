import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const adaptersSourceRoot = new URL('.', import.meta.url).pathname
const adaptersPackageRoot = join(adaptersSourceRoot, '..')

describe('adapters package architecture', () => {
  it('keeps production storage adapters independent from trust, projection, and server implementations', async () => {
    const forbiddenPatterns = [
      { label: 'auth package dependency', pattern: /@regesta\/auth/u },
      { label: 'npm package dependency', pattern: /@regesta\/npm/u },
      { label: 'Hono route dependency', pattern: /\bhono\b/u },
      { label: 'Valibot HTTP validation dependency', pattern: /\bvalibot\b/u },
      { label: 'npm packument logic', pattern: /\bpackument\b/u },
      { label: 'npm dist-tags logic', pattern: /dist-tags/u },
      { label: 'npm upstream registry', pattern: /registry\.npmjs\.org/u },
      { label: 'PyPI upstream registry', pattern: /pypi\.org/u },
      { label: 'Cargo upstream registry', pattern: /crates\.io/u },
      { label: 'Cargo upstream index', pattern: /index\.crates\.io/u },
      { label: 'Go upstream proxy', pattern: /proxy\.golang\.org/u },
      { label: 'OCI upstream registry', pattern: /registry-1\.docker\.io/u },
      { label: 'OCI upstream registry', pattern: /\bghcr\.io\b/u },
      { label: 'npm media type', pattern: /application\/vnd\.npm/u },
      { label: 'PyPI projection vocabulary', pattern: /\bpypi\b/iu },
      { label: 'Cargo projection vocabulary', pattern: /\bcargo\b/iu },
      { label: 'OCI projection vocabulary', pattern: /\boci\b/iu },
      { label: 'package-manager process execution', pattern: /child_process/u },
      { label: 'full package-state replay', pattern: /replayPackageState/u },
      {
        label: 'full appendable event replay helper',
        pattern: /assertAppendableRegistryEvent/u,
      },
    ]
    const violations: string[] = []

    for (const file of await productionSourceFiles(adaptersSourceRoot)) {
      const source = await readFile(file, 'utf8')
      for (const { label, pattern } of forbiddenPatterns) {
        if (pattern.test(source)) {
          violations.push(`${relative(adaptersSourceRoot, file)}: ${label}`)
        }
      }
    }

    expect(violations).toEqual([])
  })

  it('keeps the adapters package manifest free from projection and server dependencies', async () => {
    const manifest = JSON.parse(
      await readFile(join(adaptersPackageRoot, 'package.json'), 'utf8'),
    )
    const forbiddenDependencies = [
      '@regesta/auth',
      '@regesta/npm',
      'hono',
      'valibot',
    ]
    const violations: string[] = []

    if (!isRecord(manifest)) {
      throw new TypeError('adapters package manifest must be an object')
    }

    for (const dependencyField of [
      'dependencies',
      'devDependencies',
      'peerDependencies',
    ]) {
      const dependencies = manifest[dependencyField]
      if (dependencies === undefined) {
        continue
      }

      if (!isRecord(dependencies)) {
        throw new TypeError(`${dependencyField} must be an object`)
      }

      for (const dependencyName of forbiddenDependencies) {
        if (dependencyName in dependencies) {
          violations.push(`${dependencyField}: ${dependencyName}`)
        }
      }
    }

    expect(violations).toEqual([])
  })

  it('delegates stored release integrity checks to the core registry layer', async () => {
    const source = await readFile(join(adaptersSourceRoot, 'events.ts'), 'utf8')

    expect(source).toContain('assertStoredReleaseIntegrity')
    expect(source).not.toContain('parseReleaseManifest')
    expect(source).not.toContain('parseObjectDescriptor')
    expect(source).not.toContain('canonicalJson')
    expect(source).not.toContain('sha256')
    expect(source).not.toContain('assertReleaseManifestDescriptor')
  })

  it('keeps typed channel commits on indexed channel state', async () => {
    for (const file of ['memory.ts', 'sqlite.ts']) {
      const source = await readFile(join(adaptersSourceRoot, file), 'utf8')
      const appendSource = methodSource(
        source,
        'appendEvent',
        'commitPackageChannelUpdate',
      )
      const updateSource = methodSource(
        source,
        'commitPackageChannelUpdate',
        'commitPackageChannelDelete',
      )
      const deleteSource = methodSource(
        source,
        'commitPackageChannelDelete',
        'commitPublishedRelease',
      )

      expect(appendSource).toContain('assertRegistryEventCanBeApplied')
      expect(appendSource).not.toContain('packageEvents(')
      expect(appendSource).not.toContain('assertAppendableRegistryEvent')
      expect(updateSource).toContain('assertExpectedChannelVersion')
      expect(updateSource).toContain('assertReleaseExists')
      expect(updateSource).not.toContain('packageEvents(')
      expect(updateSource).not.toContain('assertAppendableRegistryEvent')
      expect(deleteSource).toContain('assertExpectedChannelVersion')
      expect(deleteSource).not.toContain('packageEvents(')
      expect(deleteSource).not.toContain('assertAppendableRegistryEvent')
    }
  })

  it('keeps package event state snapshots on indexed event state', async () => {
    const sources = {
      memory: await readFile(join(adaptersSourceRoot, 'memory.ts'), 'utf8'),
      sqlite: await readFile(join(adaptersSourceRoot, 'sqlite.ts'), 'utf8'),
    }
    const memorySource = methodSource(
      sources.memory,
      'getPackageEventState',
      'getRelease',
    )
    const sqliteSource = methodSource(
      sources.sqlite,
      'getPackageEventState',
      'getRelease',
    )

    for (const source of [memorySource, sqliteSource]) {
      expect(source).not.toContain('listPackageEvents')
      expect(source).not.toContain('replayPackageState')
      expect(source).not.toContain('event_json')
    }

    expect(memorySource).toContain('eventReleases')
    expect(memorySource).toContain('eventChannels')
    expect(memorySource).toContain('eventHeads')
    expect(memorySource).not.toContain('eventLast')
    expect(sqliteSource).toContain('registry_event_releases')
    expect(sqliteSource).toContain('registry_event_channels')
    expect(sqliteSource).toContain('registry_package_heads')
    expect(sqliteSource).not.toContain('registry_events')
    expect(sqliteSource).not.toContain('ORDER BY sequence')
    expect(sqliteSource).not.toContain('LIMIT 1')
  })

  it('keeps single package channel reads on indexed channel state', async () => {
    const sources = {
      memory: await readFile(join(adaptersSourceRoot, 'memory.ts'), 'utf8'),
      sqlite: await readFile(join(adaptersSourceRoot, 'sqlite.ts'), 'utf8'),
    }
    const memorySource = methodSource(
      sources.memory,
      'getPackageChannelVersion',
      'getPackageChannels',
    )
    const sqliteSource = methodSource(
      sources.sqlite,
      'getPackageChannelVersion',
      'getPackageChannels',
    )

    expect(memorySource).toContain('this.channels.get(packageId)?.get(channel)')
    expect(memorySource).not.toContain('Object.fromEntries')
    expect(sqliteSource).toContain('this.channelVersion(packageId, channel)')
    expect(sqliteSource).not.toContain('ORDER BY channel')
    expect(sqliteSource).not.toContain('Object.fromEntries')
  })

  it('keeps package event heads on indexed event state', async () => {
    const sources = {
      memory: await readFile(join(adaptersSourceRoot, 'memory.ts'), 'utf8'),
      sqlite: await readFile(join(adaptersSourceRoot, 'sqlite.ts'), 'utf8'),
    }
    const memorySource = methodSource(
      sources.memory,
      'getPackageEventHead',
      'getPackageEventState',
    )
    const sqliteSource = methodSource(
      sources.sqlite,
      'getPackageEventHead',
      'getPackageEventState',
    )

    for (const source of [memorySource, sqliteSource]) {
      expect(source).not.toContain('listPackageEvents')
      expect(source).not.toContain('replayPackageState')
      expect(source).not.toContain('event_json')
    }

    expect(memorySource).toContain('eventHeads')
    expect(memorySource).not.toContain('eventReleases')
    expect(sqliteSource).toContain('registry_package_heads')
    expect(sqliteSource).not.toContain('registry_event_releases')
    expect(sqliteSource).not.toContain('registry_events')
    expect(sqliteSource).not.toContain('COUNT(')
    expect(sqliteSource).not.toContain('LIMIT')
  })

  it('keeps package release heads on indexed release state', async () => {
    const sources = {
      memory: await readFile(join(adaptersSourceRoot, 'memory.ts'), 'utf8'),
      sqlite: await readFile(join(adaptersSourceRoot, 'sqlite.ts'), 'utf8'),
    }
    const memorySource = methodSource(
      sources.memory,
      'getPackageReleaseHead',
      'getRelease',
    )
    const sqliteSource = methodSource(
      sources.sqlite,
      'getPackageReleaseHead',
      'getRelease',
    )

    expect(memorySource).toContain('releaseHeads')
    expect(memorySource).not.toContain('releases.get')
    expect(sqliteSource).toContain('registry_package_release_heads')
    expect(sqliteSource).not.toContain('FROM releases')
    expect(sqliteSource).not.toContain('COUNT(')
    expect(sqliteSource).not.toContain('MAX(')
  })

  it('keeps package release listings bounded by release cursor pagination', async () => {
    const sources = {
      coreStorage: await readFile(
        join(adaptersSourceRoot, '../../core/src/storage.ts'),
        'utf8',
      ),
      memory: await readFile(join(adaptersSourceRoot, 'memory.ts'), 'utf8'),
      sqlite: await readFile(join(adaptersSourceRoot, 'sqlite.ts'), 'utf8'),
    }
    const memorySource = methodSource(
      sources.memory,
      'listPackageReleases',
      'putRelease',
    )
    const sqliteSource = methodSource(
      sources.sqlite,
      'listPackageReleases',
      'async putRelease',
    )

    expect(sources.coreStorage).toContain('options: PackageReleaseListOptions')
    expect(memorySource).toContain('assertPackageReleaseListOptions')
    expect(memorySource).toContain('start + options.limit')
    expect(sqliteSource).toContain('assertPackageReleaseListOptions')
    expect(sqliteSource).toContain('LIMIT ?')
    expect(sqliteSource).toContain('created_at > ?')
    expect(sqliteSource).toContain('version > ?')
    expect(sources.sqlite).toContain(
      'DROP INDEX IF EXISTS releases_package_created_idx',
    )
    expect(sources.sqlite).toContain('releases_package_created_version_idx')
    expect(sources.sqlite).toContain(
      'ON releases (package_id, created_at, version)',
    )
    expect(sources.sqlite).toContain(
      'registry_event_releases_package_created_version_idx',
    )
    expect(sources.sqlite).toContain(
      'ON registry_event_releases (package_id, created_at, version)',
    )
    for (const source of [memorySource, sqliteSource]) {
      expect(source).not.toContain('options.limit === undefined')
      expect(source).not.toContain('Number.POSITIVE_INFINITY')
    }
  })

  it('keeps package counts on indexed adapter statistics', async () => {
    const sources = {
      memory: await readFile(join(adaptersSourceRoot, 'memory.ts'), 'utf8'),
      sqlite: await readFile(join(adaptersSourceRoot, 'sqlite.ts'), 'utf8'),
    }
    const memorySource = methodSource(
      sources.memory,
      'countPackages',
      'listEvents',
    )
    const sqliteSource = methodSource(
      sources.sqlite,
      'countPackages',
      'appendEvent',
    )

    expect(memorySource).toContain('this.releaseHeads.size')
    expect(memorySource).not.toContain('new Set')
    expect(memorySource).not.toContain('for (')
    expect(sqliteSource).toContain("registryStat('package_count')")
    expect(sqliteSource).not.toContain('COUNT(')
    expect(sqliteSource).not.toContain('DISTINCT')
    expect(sqliteSource).not.toContain('releases')
  })

  it('keeps event log reads bounded by required adapter page limits', async () => {
    const sources = {
      coreStorage: await readFile(
        join(adaptersSourceRoot, '../../core/src/storage.ts'),
        'utf8',
      ),
      memory: await readFile(join(adaptersSourceRoot, 'memory.ts'), 'utf8'),
      sqlite: await readFile(join(adaptersSourceRoot, 'sqlite.ts'), 'utf8'),
    }
    const memorySource = methodSource(sources.memory, 'listEvents', 'getEvent')
    const sqliteSource = methodSource(sources.sqlite, 'listEvents', 'getEvent')

    expect(sources.coreStorage).toContain('limit: number')
    expect(sources.coreStorage).toContain(
      'listEvents: (options: RegistryEventListOptions)',
    )
    expect(memorySource).toContain('startIndex + options.limit')
    expect(memorySource).not.toContain('options.limit === undefined')
    expect(sqliteSource).toContain('LIMIT ?')
    expect(sqliteSource).not.toContain('options.limit === undefined')
  })

  it('keeps unbounded package and event-log reads out of the public adapter interface', async () => {
    const sources = {
      coreStorage: await readFile(
        join(adaptersSourceRoot, '../../core/src/storage.ts'),
        'utf8',
      ),
      memory: await readFile(join(adaptersSourceRoot, 'memory.ts'), 'utf8'),
      sqlite: await readFile(join(adaptersSourceRoot, 'sqlite.ts'), 'utf8'),
    }
    const sqliteHelperSource = methodSource(
      sources.sqlite,
      'private packageHasReleases',
      'private ensureRegistryEventColumns',
    )

    expect(sources.coreStorage).not.toContain('hasPackage')
    expect(sources.coreStorage).not.toContain('getEventLog')
    expect(sources.coreStorage).not.toContain('listPackageEvents')
    expect(sources.memory).not.toContain('hasPackage(')
    expect(sources.memory).not.toContain('getEventLog(')
    expect(sources.memory).not.toContain('listPackageEvents(')
    expect(sources.sqlite).not.toContain('hasPackage(')
    expect(sources.sqlite).not.toContain('getEventLog(')
    expect(sources.sqlite).not.toContain('listPackageEvents(')
    expect(sqliteHelperSource).toContain('registry_package_release_heads')
    expect(sqliteHelperSource).not.toContain('FROM releases')
    expect(sqliteHelperSource).not.toContain('COUNT(')
  })

  it('keeps local object inventory pagination bounded by cursor and limit', async () => {
    const coreStorageSource = await readFile(
      join(adaptersSourceRoot, '../../core/src/storage.ts'),
      'utf8',
    )
    const memorySource = await readFile(
      join(adaptersSourceRoot, 'memory.ts'),
      'utf8',
    )
    const source = await readFile(join(adaptersSourceRoot, 'local.ts'), 'utf8')
    const listSource = methodSource(
      source,
      'async listDescriptors',
      'async put',
    )
    const memoryListSource = methodSource(
      memorySource,
      'listDescriptors',
      'put',
    )
    const pageSource = sourceBetween(
      source,
      'async function listLocalObjectPageDigests',
      'async function statLocalObjectFile',
    )

    expect(coreStorageSource).toContain('limit: number')
    expect(coreStorageSource).toContain('options: ObjectDescriptorListOptions')
    expect(memoryListSource).toContain('assertObjectDescriptorListOptions')
    expect(memoryListSource).toContain('start + options.limit')
    expect(memoryListSource).not.toContain('options.limit ??')
    expect(listSource).toContain(
      'listLocalObjectPageDigests(this.root, options)',
    )
    expect(listSource).toContain('assertObjectDescriptorListOptions')
    expect(listSource).not.toContain('.slice(')
    expect(pageSource).toContain('const limit = options.limit')
    expect(pageSource).toContain('page.length >= limit')
    expect(pageSource).toContain('ObjectCursorNotFoundError')
    expect(pageSource).toContain('sortDirectoryEntries')
    expect(pageSource).not.toContain('Number.POSITIVE_INFINITY')
    expect(pageSource).not.toContain('toSorted()')
  })

  it('keeps checkpoint storage as an opaque adapter boundary', async () => {
    const coreStorageSource = await readFile(
      join(adaptersSourceRoot, '../../core/src/storage.ts'),
      'utf8',
    )
    const localSource = await readFile(
      join(adaptersSourceRoot, 'local.ts'),
      'utf8',
    )
    const memorySource = await readFile(
      join(adaptersSourceRoot, 'memory.ts'),
      'utf8',
    )
    const sqliteSource = await readFile(
      join(adaptersSourceRoot, 'sqlite.ts'),
      'utf8',
    )

    expect(coreStorageSource).toContain('export type CheckpointStore')
    expect(coreStorageSource).toContain('checkpoints?: CheckpointStore')
    expect(localSource).toContain('LocalCheckpointStore')
    expect(localSource).toContain("join(root, 'checkpoints')")
    expect(memorySource).toContain('MemoryCheckpointStore')
    expect(sqliteSource).not.toContain('checkpoint')

    for (const source of [localSource, memorySource]) {
      expect(source).not.toContain('inclusionProof')
      expect(source).not.toContain('consistencyProof')
      expect(source).not.toContain('witnessThreshold')
    }
  })
})

async function productionSourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const files: string[] = []

  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await productionSourceFiles(path)))
      continue
    }

    if (
      entry.isFile() &&
      entry.name.endsWith('.ts') &&
      !isTestSourceFile(path)
    ) {
      files.push(path)
    }
  }

  return files
}

function isTestSourceFile(path: string): boolean {
  return path.endsWith('.test.ts') || path.endsWith('.conformance.ts')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function methodSource(source: string, name: string, nextName: string): string {
  const start = source.indexOf(`${name}(`)
  const end = source.indexOf(`${nextName}(`, start + name.length)

  if (start === -1 || end === -1) {
    throw new Error(`Could not find method range: ${name}`)
  }

  return source.slice(start, end)
}

function sourceBetween(
  source: string,
  startText: string,
  endText: string,
): string {
  const start = source.indexOf(startText)
  const end = source.indexOf(endText, start + startText.length)

  if (start === -1 || end === -1) {
    throw new Error(`Could not find source range: ${startText}`)
  }

  return source.slice(start, end)
}
