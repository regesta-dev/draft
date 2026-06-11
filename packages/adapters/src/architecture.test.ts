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
      { label: 'package-manager process execution', pattern: /child_process/u },
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
