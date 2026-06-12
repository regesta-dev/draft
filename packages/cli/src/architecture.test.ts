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

  it('keeps Cache-Control directive parsing centralized', async () => {
    const helperSource = await readFile(
      join(cliSourceRoot, 'http-headers.ts'),
      'utf8',
    )
    const mirrorSource = await readFile(
      join(cliSourceRoot, 'mirror.ts'),
      'utf8',
    )
    const verifySource = await readFile(
      join(cliSourceRoot, 'verify.ts'),
      'utf8',
    )
    const violations: string[] = []

    expect(helperSource).toContain('export function cacheControlHasDirective')
    expect(helperSource).toContain('function cacheControlParts')
    expect(helperSource).toContain("character === ','")
    expect(helperSource).toContain('quoted')
    expect(mirrorSource).toContain('cacheControlHasDirective')
    expect(mirrorSource).toContain('isolatedRequestInit')
    expect(mirrorSource).toContain("} from './http-headers.ts'")
    expect(verifySource).toContain('cacheControlHasDirective')
    expect(verifySource).toContain('isolatedRequestInit')
    expect(verifySource).toContain("} from './http-headers.ts'")

    for (const file of await productionSourceFiles(cliSourceRoot)) {
      const relativePath = relative(cliSourceRoot, file)
      if (relativePath === 'http-headers.ts') {
        continue
      }

      const source = await readFile(file, 'utf8')
      for (const text of [
        'function cacheControlHas',
        "split(',').some",
        "part.split('=', 1)",
      ]) {
        if (source.includes(text)) {
          violations.push(`${relativePath} contains ${text}`)
        }
      }
    }

    expect(violations).toEqual([])
  })

  it('keeps publish write requests isolated from ambient client state', async () => {
    const cliSource = await readFile(join(cliSourceRoot, 'index.ts'), 'utf8')
    const helperSource = await readFile(
      join(cliSourceRoot, 'http-headers.ts'),
      'utf8',
    )
    const publishFetchBlock = sourceBetween(
      cliSource,
      'await fetch(`${registry}/releases`, {',
      '})',
    )

    expect(cliSource).toContain(
      "import { isolatedRequestInit } from './http-headers.ts'",
    )
    expect(publishFetchBlock).toContain('isolatedRequestInit')
    expect(publishFetchBlock).toContain("accept: 'application/json'")
    expect(publishFetchBlock).toContain("method: 'POST'")
    expect(helperSource).toContain("cache: 'no-store'")
    expect(helperSource).toContain("credentials: 'omit'")
    expect(helperSource).toContain("redirect: 'error'")
  })

  it('keeps isolated registry request options centralized', async () => {
    const helperSource = await readFile(
      join(cliSourceRoot, 'http-headers.ts'),
      'utf8',
    )
    const violations: string[] = []

    expect(helperSource).toContain('export function isolatedRequestInit')
    expect(helperSource).toContain("cache: 'no-store'")
    expect(helperSource).toContain("credentials: 'omit'")
    expect(helperSource).toContain("redirect: 'error'")

    for (const file of await productionSourceFiles(cliSourceRoot)) {
      const relativePath = relative(cliSourceRoot, file)
      if (relativePath === 'http-headers.ts') {
        continue
      }

      const source = await readFile(file, 'utf8')
      for (const text of [
        "cache: 'no-store'",
        "credentials: 'omit'",
        "redirect: 'error'",
      ]) {
        if (source.includes(text)) {
          violations.push(`${relativePath} contains ${text}`)
        }
      }
    }

    expect(violations).toEqual([])
  })

  it('keeps CLI network access owned by publisher, verifier, and mirror paths', async () => {
    const allowedFetchSources = new Set(['index.ts', 'mirror.ts', 'verify.ts'])
    const violations: string[] = []

    for (const file of await productionSourceFiles(cliSourceRoot)) {
      const relativePath = relative(cliSourceRoot, file)
      const source = await readFile(file, 'utf8')

      if (/\bfetch\b/u.test(source) && !allowedFetchSources.has(relativePath)) {
        violations.push(relativePath)
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

function sourceBetween(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start)

  if (startIndex === -1) {
    throw new Error(`Source start marker not found: ${start}`)
  }

  const endIndex = source.indexOf(end, startIndex + start.length)

  if (endIndex === -1) {
    throw new Error(`Source end marker not found: ${end}`)
  }

  return source.slice(startIndex, endIndex + end.length)
}
