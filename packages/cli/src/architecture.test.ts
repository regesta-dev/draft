import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const cliSourceRoot = new URL('.', import.meta.url).pathname
const cliPackageRoot = join(cliSourceRoot, '..')

describe('cli package architecture', () => {
  it('keeps production CLI source independent from server and storage implementations', async () => {
    const forbiddenPatterns = [
      { label: 'adapter package dependency', pattern: /@regesta\/adapters/u },
      { label: 'Hono route dependency', pattern: /\bhono\b/u },
      { label: 'Valibot HTTP validation dependency', pattern: /\bvalibot\b/u },
      { label: 'server app factory', pattern: /createRegestaApp/u },
      {
        label: 'server npm route factory',
        pattern: /createNpmRegistryRoutes/u,
      },
      {
        label: 'local adapter factory',
        pattern: /createLocalRegistryAdapters/u,
      },
      { label: 'SQLite implementation', pattern: /\bDatabaseSync\b/u },
      { label: 'SQLite storage implementation', pattern: /node:sqlite/u },
      { label: 'upstream npm fallback', pattern: /registry\.npmjs\.org/u },
      { label: 'PyPI upstream registry', pattern: /pypi\.org/u },
      { label: 'Cargo upstream registry', pattern: /crates\.io/u },
      { label: 'Cargo upstream index', pattern: /index\.crates\.io/u },
      { label: 'Go upstream proxy', pattern: /proxy\.golang\.org/u },
      { label: 'OCI upstream registry', pattern: /registry-1\.docker\.io/u },
      { label: 'OCI upstream registry', pattern: /\bghcr\.io\b/u },
    ]
    const violations: string[] = []

    for (const file of await productionSourceFiles(cliSourceRoot)) {
      const source = await readFile(file, 'utf8')
      for (const { label, pattern } of forbiddenPatterns) {
        if (pattern.test(source)) {
          violations.push(`${relative(cliSourceRoot, file)}: ${label}`)
        }
      }
    }

    expect(violations).toEqual([])
  })

  it('keeps the CLI package manifest free from server and storage dependencies', async () => {
    const manifest = JSON.parse(
      await readFile(join(cliPackageRoot, 'package.json'), 'utf8'),
    )
    const forbiddenDependencies = ['@regesta/adapters', 'hono', 'valibot']
    const violations: string[] = []

    if (!isRecord(manifest)) {
      throw new TypeError('cli package manifest must be an object')
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
  return path.endsWith('.test.ts')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
