import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const npmSourceRoot = new URL('.', import.meta.url).pathname
const npmPackageRoot = join(npmSourceRoot, '..')

describe('npm package architecture', () => {
  it('keeps production npm helpers independent from core, server, and storage implementations', async () => {
    const forbiddenPatterns = [
      { label: 'core package dependency', pattern: /@regesta\/core/u },
      { label: 'auth package dependency', pattern: /@regesta\/auth/u },
      { label: 'adapter package dependency', pattern: /@regesta\/adapters/u },
      { label: 'Hono route dependency', pattern: /\bhono\b/u },
      { label: 'upstream npm fallback', pattern: /registry\.npmjs\.org/u },
      { label: 'upstream fetch', pattern: /\bfetch\b/u },
      { label: 'filesystem storage implementation', pattern: /node:fs/u },
      { label: 'SQLite implementation', pattern: /\bDatabaseSync\b/u },
      { label: 'SQLite storage implementation', pattern: /node:sqlite/u },
      { label: 'package-manager process execution', pattern: /child_process/u },
    ]
    const violations: string[] = []

    for (const file of await sourceFiles(npmSourceRoot)) {
      const source = await readFile(file, 'utf8')
      for (const { label, pattern } of forbiddenPatterns) {
        if (pattern.test(source)) {
          violations.push(`${relative(npmSourceRoot, file)}: ${label}`)
        }
      }
    }

    expect(violations).toEqual([])
  })

  it('keeps the npm package manifest free from registry implementation dependencies', async () => {
    const manifest = JSON.parse(
      await readFile(join(npmPackageRoot, 'package.json'), 'utf8'),
    )
    const forbiddenDependencies = [
      '@regesta/adapters',
      '@regesta/auth',
      '@regesta/core',
      'hono',
    ]
    const violations: string[] = []

    if (!isRecord(manifest)) {
      throw new TypeError('npm package manifest must be an object')
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
