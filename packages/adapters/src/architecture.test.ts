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
    expect(sqliteSource).toContain('registry_event_releases')
    expect(sqliteSource).toContain('registry_event_channels')
  })

  it('keeps package counts on indexed adapter statistics', async () => {
    const sources = {
      memory: await readFile(join(adaptersSourceRoot, 'memory.ts'), 'utf8'),
      sqlite: await readFile(join(adaptersSourceRoot, 'sqlite.ts'), 'utf8'),
    }
    const memorySource = methodSource(
      sources.memory,
      'countPackages',
      'getEventLog',
    )
    const sqliteSource = methodSource(
      sources.sqlite,
      'countPackages',
      'appendEvent',
    )

    expect(memorySource).toContain('this.releases.size')
    expect(memorySource).not.toContain('new Set')
    expect(memorySource).not.toContain('for (')
    expect(sqliteSource).toContain("registryStat('package_count')")
    expect(sqliteSource).not.toContain('COUNT(')
    expect(sqliteSource).not.toContain('DISTINCT')
    expect(sqliteSource).not.toContain('releases')
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
