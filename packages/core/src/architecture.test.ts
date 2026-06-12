import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const coreSourceRoot = new URL('.', import.meta.url).pathname
const corePackageRoot = join(coreSourceRoot, '..')

describe('core package architecture', () => {
  it('keeps production core source independent from ecosystem projections and concrete storage', async () => {
    const forbiddenPatterns = [
      { label: 'npm package dependency', pattern: /@regesta\/npm/u },
      { label: 'auth package dependency', pattern: /@regesta\/auth/u },
      { label: 'adapter package dependency', pattern: /@regesta\/adapters/u },
      { label: 'npm packument logic', pattern: /\bpackument\b/u },
      { label: 'npm dist-tags logic', pattern: /dist-tags/u },
      { label: 'npm upstream registry', pattern: /registry\.npmjs\.org/u },
      { label: 'npm media type', pattern: /application\/vnd\.npm/u },
      { label: 'PyPI projection vocabulary', pattern: /\bpypi\b/iu },
      { label: 'Cargo projection vocabulary', pattern: /\bcargo\b/iu },
      { label: 'OCI projection vocabulary', pattern: /\boci\b/iu },
      { label: 'SQLite implementation', pattern: /\bDatabaseSync\b/u },
      { label: 'filesystem storage implementation', pattern: /node:fs/u },
      { label: 'SQLite storage implementation', pattern: /node:sqlite/u },
    ]
    const violations: string[] = []

    for (const file of await sourceFiles(coreSourceRoot)) {
      const source = await readFile(file, 'utf8')
      for (const { label, pattern } of forbiddenPatterns) {
        if (pattern.test(source)) {
          violations.push(`${relative(coreSourceRoot, file)}: ${label}`)
        }
      }
    }

    expect(violations).toEqual([])
  })

  it('keeps the core package manifest free from projection and adapter dependencies', async () => {
    const manifest = JSON.parse(
      await readFile(join(corePackageRoot, 'package.json'), 'utf8'),
    )
    const forbiddenDependencies = [
      '@regesta/adapters',
      '@regesta/auth',
      '@regesta/npm',
    ]
    const violations: string[] = []

    if (!isRecord(manifest)) {
      throw new TypeError('core package manifest must be an object')
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
})

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const files: string[] = []

  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await sourceFiles(path)))
      continue
    }

    if (entry.isFile() && entry.name.endsWith('.ts') && !isTestFile(path)) {
      files.push(path)
    }
  }

  return files
}

function isTestFile(path: string): boolean {
  return path.endsWith('.test.ts')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
