import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const authSourceRoot = new URL('.', import.meta.url).pathname
const authPackageRoot = join(authSourceRoot, '..')

describe('auth package architecture', () => {
  it('keeps production auth helpers independent from registry, ecosystem, storage, and server implementations', async () => {
    const forbiddenPatterns = [
      { label: 'core package dependency', pattern: /@regesta\/core/u },
      { label: 'npm package dependency', pattern: /@regesta\/npm/u },
      { label: 'adapter package dependency', pattern: /@regesta\/adapters/u },
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
      { label: 'filesystem storage implementation', pattern: /node:fs/u },
      { label: 'SQLite implementation', pattern: /\bDatabaseSync\b/u },
      { label: 'SQLite storage implementation', pattern: /node:sqlite/u },
      { label: 'package-manager process execution', pattern: /child_process/u },
    ]
    const violations: string[] = []

    for (const file of await sourceFiles(authSourceRoot)) {
      const source = await readFile(file, 'utf8')
      for (const { label, pattern } of forbiddenPatterns) {
        if (pattern.test(source)) {
          violations.push(`${relative(authSourceRoot, file)}: ${label}`)
        }
      }
    }

    expect(violations).toEqual([])
  })

  it('keeps the auth package manifest free from registry implementation dependencies', async () => {
    const manifest = JSON.parse(
      await readFile(join(authPackageRoot, 'package.json'), 'utf8'),
    )
    const forbiddenDependencies = [
      '@regesta/adapters',
      '@regesta/core',
      '@regesta/npm',
      'hono',
      'valibot',
    ]
    const violations: string[] = []

    if (!isRecord(manifest)) {
      throw new TypeError('auth package manifest must be an object')
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
