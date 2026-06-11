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

  it('keeps core routes independent from local storage implementations', async () => {
    await expectNoForbiddenImports('core', [
      '@regesta/adapters',
      'node:fs',
      'node:fs/promises',
      'node:path',
      'node:sqlite',
      '../adapters/',
      '../storage/',
    ])
    await expectNoForbiddenSourcePatterns('core', [
      { label: 'SQLite implementation', pattern: /\bDatabaseSync\b/u },
      {
        label: 'local adapter factory',
        pattern: /createLocalRegistryAdapters/u,
      },
      {
        label: 'memory adapter factory',
        pattern: /createMemoryRegistryAdapters/u,
      },
      { label: 'server data directory', pattern: /REGESTA_DATA_DIR/u },
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

  it('keeps the transport shell owned by the transport layer', async () => {
    const source = await readFile(join(serverSourceRoot, 'app.ts'), 'utf8')
    const transportSource = await readFile(
      join(serverSourceRoot, 'transport/app.ts'),
      'utf8',
    )

    expect(source).toContain('createTransportApp')
    expect(source).not.toContain('new Hono')
    for (const text of [
      'createRequestIdMiddleware',
      'createRequestLogger',
      'createPathNormalizationMiddleware',
      'createCorsMiddleware',
      'createRequestSizeLimitMiddleware',
      'createTransportErrorBoundary',
      'registryRoutePath',
    ]) {
      expect(source).not.toContain(text)
      expect(transportSource).toContain(text)
    }
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

  it('keeps storage readiness independent from local adapter and business implementations', async () => {
    await expectNoForbiddenImports('storage', [
      '@regesta/adapters',
      '@regesta/auth',
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
      '../trust/',
    ])
    await expectNoForbiddenSourcePatterns('storage', [
      { label: 'full registry adapter type', pattern: /\bRegistryAdapters\b/u },
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

  it('keeps full npm packument channels replayed while narrow routes use indexed state', async () => {
    const routeSource = await readFile(
      join(serverSourceRoot, 'npm/app.ts'),
      'utf8',
    )
    const projectionSource = await readFile(
      join(serverSourceRoot, 'npm/projection.ts'),
      'utf8',
    )

    expect(routeSource).toContain('readLocalNpmPackageProjection')
    expect(routeSource).not.toContain('replayPackageState')
    expect(routeSource).toContain('getPackageChannels')
    expect(projectionSource).toContain('replayPackageState')
    expect(projectionSource).not.toContain('getPackageChannels')
  })

  it('keeps local npm projection mechanics outside route handlers', async () => {
    const routeSource = await readFile(
      join(serverSourceRoot, 'npm/app.ts'),
      'utf8',
    )
    const projectionSource = await readFile(
      join(serverSourceRoot, 'npm/projection.ts'),
      'utf8',
    )

    expect(routeSource).toContain('readLocalNpmPackageProjection')
    for (const text of [
      'createNpmPackument',
      'npmInstallArtifact',
      'coreRegistryHostname',
      'coreObjectUrl',
    ]) {
      expect(routeSource).not.toContain(text)
      expect(projectionSource).toContain(text)
    }
  })

  it('keeps npm projection submodules on their own side of the boundary', async () => {
    await expectNoForbiddenImports('npm/app.ts', [
      '@regesta/adapters',
      '@regesta/core',
      '@regesta/npm',
      './projection-app',
    ])
    await expectNoForbiddenImports('npm/projection.ts', [
      '@regesta/adapters',
      '@regesta/auth',
      'hono',
      '../responses',
      './projection-app',
      './reader',
      './upstream',
    ])
    await expectNoForbiddenImports('npm/upstream.ts', [
      '@regesta/adapters',
      '@regesta/auth',
      '@regesta/core',
      '@regesta/npm',
      '@regesta/protocol',
      './projection',
      './projection-app',
      './reader',
    ])
    await expectNoForbiddenImports('npm/reader.ts', [
      '@regesta/adapters',
      '@regesta/auth',
      '@regesta/npm',
      'hono',
      '../responses',
      './app',
      './projection',
      './projection-app',
      './upstream',
    ])
    await expectNoForbiddenImports('npm/projection-app.ts', [
      '@regesta/adapters',
      '@regesta/auth',
      '@regesta/npm',
      '@regesta/protocol',
      '../responses',
      './projection',
      './upstream',
    ])
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

  it('keeps the generic artifact processor independent from ecosystem packages', async () => {
    await expectNoForbiddenImports('artifacts/process.ts', ['@regesta/npm'])
  })

  it('wires ecosystem artifact processors only through the artifact layer defaults', async () => {
    const violations: string[] = []
    const appSource = await readFile(join(serverSourceRoot, 'app.ts'), 'utf8')
    const artifactAppSource = await readFile(
      join(serverSourceRoot, 'artifacts/app.ts'),
      'utf8',
    )

    expect(appSource).toContain('createDefaultPublishArtifactProcessor')
    expect(appSource).not.toContain('processNpmArtifacts')
    expect(appSource).not.toContain('createPublishArtifactProcessor')
    expect(artifactAppSource).toContain('createPublishArtifactProcessor')
    expect(artifactAppSource).toContain('processNpmArtifacts')

    for (const file of await sourceFiles(serverSourceRoot)) {
      const relativePath = relative(serverSourceRoot, file)
      if (['artifacts/app.ts', 'artifacts/npm.ts'].includes(relativePath)) {
        continue
      }

      const source = await readFile(file, 'utf8')
      if (source.includes('processNpmArtifacts')) {
        violations.push(relativePath)
      }
    }

    expect(violations).toEqual([])
  })

  it('keeps server runtime from executing package-manager build processes', async () => {
    await expectNoForbiddenImports(serverSourceRoot, [
      'child_process',
      'node:child_process',
    ])
    await expectNoForbiddenImports(
      join(workspaceRoot, 'apps/server/server.ts'),
      ['child_process', 'node:child_process'],
    )
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

  it('keeps known business error mappings owned by their layers', async () => {
    const source = await readFile(join(serverSourceRoot, 'app.ts'), 'utf8')
    const coreErrorsSource = await readFile(
      join(serverSourceRoot, 'core/errors.ts'),
      'utf8',
    )
    const requestSource = await readFile(
      join(serverSourceRoot, 'request.ts'),
      'utf8',
    )
    const trustErrorsSource = await readFile(
      join(serverSourceRoot, 'trust/errors.ts'),
      'utf8',
    )

    expect(source).toContain('...requestKnownErrors')
    expect(source).toContain('...trustKnownErrors')
    expect(source).toContain('...coreRegistryKnownErrors')

    for (const text of [
      'ObjectCursorNotFoundError',
      'PackageChannelConflictError',
      'RegistryEventAlreadyExistsError',
      'RegistryEventCursorNotFoundError',
      'ReleaseAlreadyExistsError',
      'ReleaseNotFoundError',
      'WriteAuthorizationReplayError',
      'WriteAuthorizationError',
      'RequestValidationError',
    ]) {
      expect(source).not.toContain(text)
    }

    expect(requestSource).toContain('RequestValidationError')
    expect(requestSource).toContain('request_invalid')
    expect(coreErrorsSource).toContain('ReleaseNotFoundError')
    expect(coreErrorsSource).toContain('package_channel_conflict')
    expect(coreErrorsSource).toContain('write_authorization_replayed')
    expect(trustErrorsSource).toContain('WriteAuthorizationError')
    expect(trustErrorsSource).toContain('write_authorization_invalid')
  })

  it('keeps npm projection tarball routes as redirects instead of byte proxies', async () => {
    const source = await readFile(join(serverSourceRoot, 'npm/app.ts'), 'utf8')
    const tarballStart = source.indexOf('function serveNpmTarball')
    const tarballEnd = source.indexOf('function redirectToTarball')
    const tarballSource = source.slice(tarballStart, tarballEnd)

    expect(source).toContain('redirectToTarball')
    expect(source).not.toContain('getDescriptor')
    expect(source).not.toContain('objects.')
    expect(source).not.toContain('immutableBytesResponse')
    expect(source).not.toContain('assertObjectResponseIntegrity')
    expect(tarballStart).toBeGreaterThanOrEqual(0)
    expect(tarballEnd).toBeGreaterThan(tarballStart)
    expect(tarballSource).toContain('upstream.tarballUrl')
    expect(tarballSource).not.toContain('adapters')
    expect(tarballSource).not.toContain('database')
    expect(tarballSource).not.toContain('fetch')
    expect(tarballSource).not.toContain('localNpmPackageId')
  })

  it('keeps npm upstream fallback mechanics outside projection route handlers', async () => {
    const routeSource = await readFile(
      join(serverSourceRoot, 'npm/app.ts'),
      'utf8',
    )
    const upstreamSource = await readFile(
      join(serverSourceRoot, 'npm/upstream.ts'),
      'utf8',
    )

    expect(routeSource).toContain('createNpmUpstreamFallback')
    expect(routeSource).toContain('upstream.packument')
    expect(routeSource).toContain('upstream.packageManifest')
    expect(routeSource).toContain('upstream.distTags')
    for (const text of [
      'registry.npmjs.org',
      'createBoundedUpstreamNpmFetch',
      'upstream_npm_registry_unavailable',
      'isNpmPackumentProjection',
      'isNpmVersionManifestProjection',
    ]) {
      expect(routeSource).not.toContain(text)
      expect(upstreamSource).toContain(text)
    }
  })

  it('mounts npm projection behind a layer-owned narrow registry reader', async () => {
    const source = await readFile(join(serverSourceRoot, 'app.ts'), 'utf8')
    const routeSource = await readFile(
      join(serverSourceRoot, 'npm/app.ts'),
      'utf8',
    )
    const projectionAppSource = await readFile(
      join(serverSourceRoot, 'npm/projection-app.ts'),
      'utf8',
    )
    const readerSource = await readFile(
      join(serverSourceRoot, 'npm/reader.ts'),
      'utf8',
    )
    const projectionAppStart = projectionAppSource.indexOf(
      'export function createNpmProjectionApp',
    )

    expect(source).toContain('createNpmProjectionApp(adapters')
    expect(source).not.toContain('createNpmRegistryReader')
    expect(source).not.toContain('createNpmRegistryRoutes(adapters')
    expect(source).not.toContain('function createNpmRegistryReader')
    expect(source).not.toContain('listPackageEvents:')
    expect(source).not.toContain('listPackageReleases:')
    expect(routeSource).toContain('export function createNpmRegistryRoutes')
    expect(routeSource).not.toContain('RegistryAdapters')
    expect(routeSource).not.toContain('createNpmRegistryReader')
    expect(projectionAppStart).toBeGreaterThanOrEqual(0)
    expect(projectionAppSource).toContain('createNpmRegistryRoutes')
    expect(projectionAppSource).toContain('createNpmRegistryReader')
    expect(readerSource).toContain('getPackageChannels')
    expect(readerSource).toContain('getRelease')
    expect(readerSource).toContain('hasPackage')
    expect(readerSource).toContain('listPackageEvents')
    expect(readerSource).toContain('listPackageReleases')
    expect(readerSource).not.toContain('.objects')
    expect(readerSource).not.toContain('.queue')
    expect(readerSource).not.toContain('.signer')
  })

  it('keeps deployment statistics caching in the transport layer', async () => {
    const source = await readFile(join(serverSourceRoot, 'app.ts'), 'utf8')
    const transportSource = await readFile(
      join(serverSourceRoot, 'transport/app.ts'),
      'utf8',
    )

    expect(source).toContain('createDeploymentStatisticsRead')
    expect(source).toContain('adapters.database')
    expect(source).not.toContain('normalizeDeploymentStatistics')
    expect(source).not.toContain('countPackages()')
    expect(source).not.toContain('cacheTtlMs > 0')
    expect(transportSource).toContain(
      'export function createDeploymentStatisticsRead',
    )
    expect(transportSource).toContain('normalizeDeploymentStatistics')
    expect(transportSource).toContain('countPackages')
    expect(transportSource).toContain('cacheTtlMs > 0')
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

  it('keeps server runtime limits wired at the composition root', async () => {
    const source = await readFile(
      join(workspaceRoot, 'apps/server/server.ts'),
      'utf8',
    )
    const runtimeOptionsSource = await readFile(
      join(serverSourceRoot, 'runtime-options.ts'),
      'utf8',
    )

    expect(source).toContain('runtimeOptionsFromEnv(process.env)')

    for (const text of [
      'REGESTA_MAX_PUBLISH_ARTIFACT_BYTES',
      'REGESTA_MAX_PUBLISH_SOURCE_BYTES',
      'REGESTA_MAX_REQUEST_BYTES',
      'REGESTA_NPM_UPSTREAM_TIMEOUT_MS',
      'REGESTA_READINESS_TIMEOUT_MS',
      'REGESTA_STATISTICS_CACHE_TTL_MS',
    ]) {
      expect(runtimeOptionsSource).toContain(text)
    }
  })

  it('keeps runtime option parsing independent from route assembly and business layers', async () => {
    await expectNoForbiddenImports('runtime-options.ts', [
      '@regesta/adapters',
      '@regesta/auth',
      '@regesta/core',
      '@regesta/npm',
      '@regesta/protocol',
      './app.ts',
      './core/',
      './npm/',
      './transport/',
      './trust/',
      'hono',
      'node:process',
      'valibot',
    ])
    await expectNoForbiddenSourcePatterns('runtime-options.ts', [
      { label: 'direct process access', pattern: /\bprocess\./u },
    ])
  })

  it('keeps container deployment data on a persistent volume', async () => {
    const dockerfile = await readFile(join(workspaceRoot, 'Dockerfile'), 'utf8')
    const compose = await readFile(join(workspaceRoot, 'compose.yaml'), 'utf8')

    expect(dockerfile).toContain('ENV REGESTA_DATA_DIR=/data')
    expect(dockerfile).toContain('VOLUME ["/data"]')
    expect(compose).toContain('REGESTA_DATA_DIR: /data')
    expect(compose).toContain('regesta-data:/data')
  })

  it('keeps Docker deployment mode explicit and dev.localhost guarded', async () => {
    const dockerfile = await readFile(join(workspaceRoot, 'Dockerfile'), 'utf8')
    const compose = await readFile(join(workspaceRoot, 'compose.yaml'), 'utf8')
    const app = await readFile(join(serverSourceRoot, 'app.ts'), 'utf8')
    const devMount = await readFile(
      join(serverSourceRoot, 'dev/mount.ts'),
      'utf8',
    )
    const devBinding = await readFile(
      join(serverSourceRoot, 'dev/domain-binding.ts'),
      'utf8',
    )

    expect(dockerfile).toContain('ENV NITRO_PRESET=node_server')
    expect(compose).toContain('NITRO_PRESET: node_server')
    expect(compose).toContain('NODE_ENV: production')
    expect(app).toContain('mountDevLocalhostRoutes(app)')
    expect(app).not.toContain("process.env.NODE_ENV === 'development'")
    expect(app).not.toContain("app.all('/dev/*'")
    expect(devMount).toContain(
      "import.meta.dev || process.env.NODE_ENV === 'development'",
    )
    expect(devMount).toContain("app.all('/dev/*'")
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

  it('keeps package-manager process execution inside publisher clients', async () => {
    for (const sourceRoot of [
      'packages/protocol/src',
      'packages/core/src',
      'packages/auth/src',
      'packages/npm/src',
      'packages/adapters/src',
    ]) {
      await expectNoForbiddenImports(join(workspaceRoot, sourceRoot), [
        'child_process',
        'node:child_process',
      ])
    }
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

  it('keeps the core package free of ecosystem projection vocabulary', async () => {
    await expectNoForbiddenSourcePatterns(
      join(workspaceRoot, 'packages/core/src'),
      [
        { label: 'npm', pattern: /\bnpm\b/u },
        { label: 'pypi', pattern: /\bpypi\b/u },
        { label: 'cargo', pattern: /\bcargo\b/u },
        { label: 'oci', pattern: /\boci\b/u },
        { label: 'npm registry fallback', pattern: /registry\.npmjs\.org/u },
        { label: 'npm packument', pattern: /\bpackument\b/u },
        { label: 'npm dist-tags', pattern: /dist-tags/u },
        { label: 'package manager manifest', pattern: /package\.json/u },
        { label: 'npm media type', pattern: /application\/vnd\.npm/u },
      ],
    )
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
      [
        '@regesta/auth',
        '@regesta/npm',
        'hono',
        'valibot',
        '../auth/',
        '../npm/',
      ],
    )
  })

  it('keeps the auth package independent from registry, ecosystem, storage, and transport implementations', async () => {
    await expectNoForbiddenImports(join(workspaceRoot, 'packages/auth/src'), [
      '@regesta/adapters',
      '@regesta/core',
      '@regesta/npm',
      'hono',
      'node:fs',
      'node:fs/promises',
      'node:path',
      'node:sqlite',
      'valibot',
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
      'node:fs',
      'node:fs/promises',
      'node:http',
      'node:https',
      'node:path',
      'node:sqlite',
      'undici',
      'valibot',
      '../adapters/',
      '../auth/',
      '../core/',
    ])
  })

  it('keeps upstream fallback and byte storage side effects out of the npm package', async () => {
    await expectNoForbiddenSourcePatterns(
      join(workspaceRoot, 'packages/npm/src'),
      [
        { label: 'network request', pattern: /\bfetch\s*\(/u },
        { label: 'upstream npm registry', pattern: /registry\.npmjs\.org/u },
        {
          label: 'local filesystem access',
          pattern: /\b(read|write)File\s*\(/u,
        },
        { label: 'SQLite implementation', pattern: /\bDatabaseSync\b/u },
      ],
    )
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

async function expectNoForbiddenSourcePatterns(
  directory: string,
  forbiddenPatterns: Array<{ label: string; pattern: RegExp }>,
): Promise<void> {
  const violations: string[] = []
  const sourceRoot = isAbsolute(directory)
    ? directory
    : join(serverSourceRoot, directory)

  for (const file of await sourceFiles(sourceRoot)) {
    const source = await readFile(file, 'utf8')

    for (const { label, pattern } of forbiddenPatterns) {
      if (pattern.test(source)) {
        violations.push(`${relative(sourceRoot, file)} contains ${label}`)
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
