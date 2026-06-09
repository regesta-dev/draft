import { readdir, readFile, stat } from 'node:fs/promises'
import { isAbsolute, join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const serverSourceRoot = new URL('.', import.meta.url).pathname
const workspaceRoot = join(serverSourceRoot, '../../..')

describe('server layer boundaries', () => {
  it('keeps core routes independent from projection and trust implementations', async () => {
    await expectNoForbiddenImports('core', [
      '@regesta/auth',
      '@regesta/npm',
      '../artifacts/',
      '../auth/',
      '../dev/',
      '../npm/',
      '../transport/',
      '../trust/',
    ])
  })

  it('keeps transport routes independent from registry business layers', async () => {
    await expectNoForbiddenImports('transport', [
      '@regesta/adapters',
      '@regesta/auth',
      '@regesta/core',
      '@regesta/npm',
      '@regesta/protocol',
      '../artifacts/',
      '../auth/',
      '../core/',
      '../dev/',
      '../npm/',
      '../trust/',
    ])
  })

  it('keeps shared HTTP response helpers independent from business layers', async () => {
    await expectNoForbiddenImports('responses.ts', [
      '@regesta/adapters',
      '@regesta/auth',
      '@regesta/core',
      '@regesta/npm',
      '@regesta/protocol',
      '../artifacts/',
      '../auth/',
      '../core/',
      '../dev/',
      '../npm/',
      '../trust/',
    ])
  })

  it('keeps shared request helpers independent from protocol and business layers', async () => {
    await expectNoForbiddenImports('request.ts', [
      '@regesta/adapters',
      '@regesta/auth',
      '@regesta/core',
      '@regesta/npm',
      '@regesta/protocol',
      '../artifacts/',
      '../auth/',
      '../core/',
      '../dev/',
      '../npm/',
      '../trust/',
    ])
  })

  it('keeps npm projection routes independent from core routes and trust implementations', async () => {
    await expectNoForbiddenImports('npm', [
      '@regesta/auth',
      '../artifacts/',
      '../auth/',
      '../core/',
      '../dev/',
      '../transport/',
      '../trust/',
    ])
  })

  it('keeps npm projection channels derived from core event state', async () => {
    const source = await readFile(join(serverSourceRoot, 'npm/app.ts'), 'utf8')

    expect(source).toContain('replayPackageState')
    expect(source).not.toContain('getPackageChannels')
  })

  it('keeps artifact helpers independent from server routes', async () => {
    await expectNoForbiddenImports('artifacts', [
      '@regesta/core',
      '../auth/',
      '../core/',
      '../dev/',
      '../npm/',
      '../transport/',
      '../trust/',
    ])
  })

  it('keeps dev helpers independent from registry business implementations', async () => {
    await expectNoForbiddenImports('dev', [
      '@regesta/adapters',
      '@regesta/core',
      '@regesta/npm',
      '../adapters/',
      '../core/',
      '../npm/',
      '../transport/',
      '../trust/',
    ])
  })

  it('keeps trust services independent from registry, projection, storage, and transport implementations', async () => {
    await expectNoForbiddenImports('trust', [
      '@regesta/adapters',
      '@regesta/core',
      '@regesta/npm',
      'hono',
      'valibot',
      '../adapters/',
      '../artifacts/',
      '../core/',
      '../dev/',
      '../npm/',
      '../transport/',
    ])
  })

  it('keeps unexpected 500 responses centralized in the transport error boundary', async () => {
    const violations: string[] = []

    for (const file of await sourceFiles(serverSourceRoot)) {
      const relativePath = relative(serverSourceRoot, file)
      if (relativePath === 'transport/errors.ts') {
        continue
      }

      const source = await readFile(file, 'utf8')
      if (source.includes(', 500') || source.includes('status: 500')) {
        violations.push(relativePath)
      }
    }

    expect(violations).toEqual([])
  })

  it('keeps the server entrypoint wired to persistent local adapters', async () => {
    const source = await readFile(
      join(workspaceRoot, 'apps/server/server.ts'),
      'utf8',
    )

    expect(source).toContain('createLocalRegistryAdapters')
    expect(source).toContain('REGESTA_DATA_DIR')
    expect(source).not.toContain('createMemoryRegistryAdapters')
  })

  it('keeps container deployment data on a persistent volume', async () => {
    const dockerfile = await readFile(join(workspaceRoot, 'Dockerfile'), 'utf8')
    const compose = await readFile(join(workspaceRoot, 'compose.yaml'), 'utf8')

    expect(dockerfile).toContain('ENV REGESTA_DATA_DIR=/data')
    expect(dockerfile).toContain('VOLUME ["/data"]')
    expect(compose).toContain('REGESTA_DATA_DIR: /data')
    expect(compose).toContain('regesta-data:/data')
  })

  it('keeps Docker development mode wired to dev.localhost support', async () => {
    const compose = await readFile(join(workspaceRoot, 'compose.yaml'), 'utf8')
    const app = await readFile(join(serverSourceRoot, 'app.ts'), 'utf8')
    const devBinding = await readFile(
      join(serverSourceRoot, 'dev/domain-binding.ts'),
      'utf8',
    )

    expect(compose).toContain('NODE_ENV: development')
    expect(app).toContain(
      "import.meta.dev || process.env.NODE_ENV === 'development'",
    )
    expect(devBinding).toContain(
      "import.meta.dev && process.env.NODE_ENV !== 'development'",
    )
  })
})

describe('workspace layer boundaries', () => {
  it('keeps package manifest dependencies aligned with layer direction', async () => {
    await expectWorkspaceDependencies('packages/protocol/package.json', [])
    await expectWorkspaceDependencies('packages/core/package.json', [
      '@regesta/protocol',
    ])
    await expectWorkspaceDependencies('packages/auth/package.json', [
      '@regesta/protocol',
    ])
    await expectWorkspaceDependencies('packages/npm/package.json', [
      '@regesta/protocol',
    ])
    await expectWorkspaceDependencies('packages/adapters/package.json', [
      '@regesta/core',
      '@regesta/protocol',
    ])
    await expectWorkspaceDependencies('packages/cli/package.json', [
      '@regesta/auth',
      '@regesta/core',
      '@regesta/npm',
      '@regesta/protocol',
    ])
    await expectWorkspaceDependencies('apps/server/package.json', [
      '@regesta/adapters',
      '@regesta/auth',
      '@regesta/core',
      '@regesta/npm',
      '@regesta/protocol',
    ])
  })

  it('keeps the core package independent from ecosystem and trust implementations', async () => {
    await expectNoForbiddenImports(join(workspaceRoot, 'packages/core/src'), [
      '@regesta/adapters',
      '@regesta/auth',
      '@regesta/npm',
      'json5',
      'node:fs',
      'node:os',
      'node:path',
      'tar',
      '../adapters/',
      '../auth/',
      '../npm/',
    ])
  })

  it('keeps core base64 primitives centralized for portable verifier paths', async () => {
    const coreSourceRoot = join(workspaceRoot, 'packages/core/src')
    const violations: string[] = []

    for (const file of await sourceFiles(coreSourceRoot)) {
      const relativePath = relative(coreSourceRoot, file)
      if (relativePath === 'base64.ts') {
        continue
      }

      if (importsSpecifier(await readFile(file, 'utf8'), 'node:buffer')) {
        violations.push(relativePath)
      }
    }

    expect(violations).toEqual([])
  })

  it('keeps generic protocol objects independent from ecosystem projection types', async () => {
    for (const file of [
      'auth.ts',
      'compatibility.ts',
      'config.ts',
      'digest.ts',
      'event.ts',
      'package-id.ts',
      'package.ts',
      'release.ts',
    ]) {
      await expectNoForbiddenImports(
        join(workspaceRoot, 'packages/protocol/src', file),
        ['./npm'],
      )
    }
  })

  it('keeps ecosystem projection protocols out of the protocol package', async () => {
    const protocolFiles = await sourceFiles(
      join(workspaceRoot, 'packages/protocol/src'),
    )
    const projectionFiles = protocolFiles
      .map((file) =>
        relative(join(workspaceRoot, 'packages/protocol/src'), file),
      )
      .filter((file) => {
        return ['cargo.ts', 'go.ts', 'npm.ts', 'oci.ts', 'pypi.ts'].includes(
          file,
        )
      })

    expect(projectionFiles).toEqual([])
  })

  it('keeps storage adapters independent from registry business implementations', async () => {
    await expectNoForbiddenImports(
      join(workspaceRoot, 'packages/adapters/src'),
      ['@regesta/auth', '@regesta/npm', '../auth/', '../npm/'],
    )
  })

  it('keeps the auth package independent from registry and ecosystem implementations', async () => {
    await expectNoForbiddenImports(join(workspaceRoot, 'packages/auth/src'), [
      '@regesta/adapters',
      '@regesta/core',
      '@regesta/npm',
      '../adapters/',
      '../core/',
      '../npm/',
    ])
  })

  it('keeps the npm package independent from registry, trust, storage, and transport implementations', async () => {
    await expectNoForbiddenImports(join(workspaceRoot, 'packages/npm/src'), [
      '@regesta/adapters',
      '@regesta/auth',
      '@regesta/core',
      'hono',
      'valibot',
      '../adapters/',
      '../auth/',
      '../core/',
    ])
  })
})

async function expectNoForbiddenImports(
  directory: string,
  forbiddenSpecifiers: string[],
): Promise<void> {
  const violations: string[] = []

  const sourceRoot = isAbsolute(directory)
    ? directory
    : join(serverSourceRoot, directory)

  for (const file of await sourceFiles(sourceRoot)) {
    const source = await readFile(file, 'utf8')

    for (const specifier of forbiddenSpecifiers) {
      if (importsSpecifier(source, specifier)) {
        violations.push(`${relative(sourceRoot, file)} imports ${specifier}`)
      }
    }
  }

  expect(violations).toEqual([])
}

async function sourceFiles(path: string): Promise<string[]> {
  const pathStat = await stat(path)

  if (pathStat.isFile()) {
    return isSourceFile(path) ? [path] : []
  }

  if (!pathStat.isDirectory()) {
    return []
  }

  const entries = await readdir(path, { withFileTypes: true })
  const files: string[] = []

  for (const entry of entries) {
    const childPath = join(path, entry.name)

    if (entry.isDirectory()) {
      files.push(...(await sourceFiles(childPath)))
      continue
    }

    if (entry.isFile() && isSourceFile(childPath)) {
      files.push(childPath)
    }
  }

  return files
}

function isSourceFile(path: string): boolean {
  return path.endsWith('.ts') && !path.endsWith('.test.ts')
}

function importsSpecifier(source: string, specifier: string): boolean {
  return (
    source.includes(`from '${specifier}`) ||
    source.includes(`from "${specifier}`) ||
    source.includes(`import('${specifier}`) ||
    source.includes(`import("${specifier}`)
  )
}

async function expectWorkspaceDependencies(
  packageJsonPath: string,
  expectedDependencies: string[],
): Promise<void> {
  const raw = await readFile(join(workspaceRoot, packageJsonPath), 'utf8')
  const manifest: unknown = JSON.parse(raw)
  const dependencies = workspaceDependencies(manifest)

  expect(dependencies).toEqual(expectedDependencies.toSorted())
}

function workspaceDependencies(manifest: unknown): string[] {
  if (!isRecord(manifest)) {
    throw new TypeError('package.json must be an object')
  }

  const { dependencies } = manifest
  if (dependencies === undefined) {
    return []
  }

  if (!isRecord(dependencies)) {
    throw new TypeError('package.json dependencies must be an object')
  }

  return Object.keys(dependencies)
    .filter((name) => name.startsWith('@regesta/'))
    .toSorted()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
