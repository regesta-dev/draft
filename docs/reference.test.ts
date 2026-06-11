import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

const docsRoot = new URL('./', import.meta.url)
const workspaceRoot = new URL('../', docsRoot)
const schemaPath = 'public/schema/regesta-v0.schema.json'
const openapiPath = 'public/openapi/regesta-v0.openapi.json'
const expectedOpenapiRouteMethods = {
  '/': ['get', 'head'],
  '/-/package/{encoded}/dist-tags': ['get', 'head'],
  '/-/package/{scope}/{name}/dist-tags': ['get', 'head'],
  '/-/ping': ['get', 'head'],
  '/events': ['get', 'head'],
  '/events/{algorithm}/{hex}': ['get', 'head'],
  '/health': ['get', 'head'],
  '/objects': ['get', 'head'],
  '/objects/{algorithm}/{hex}': ['get', 'head'],
  '/objects/{digest}': ['get', 'head'],
  '/packages/{packageId}': ['get', 'head'],
  '/packages/{packageId}/channels/{channel}': ['delete', 'get', 'head', 'put'],
  '/packages/{packageId}/releases/{version}': ['get', 'head'],
  '/packages/{packageId}/releases/{version}/verification': ['get'],
  '/ready': ['get', 'head'],
  '/releases': ['post'],
  '/{encoded}': ['get', 'head'],
  '/{name}/-/{file}': ['get', 'head'],
  '/{scope}/{name}': ['get', 'head'],
  '/{scope}/{name}/-/{file}': ['get', 'head'],
  '/{scope}/{name}/{tagOrVersion}': ['get', 'head'],
} satisfies Record<string, string[]>

describe('documentation references', () => {
  it('links the public machine-readable references from the prose docs', async () => {
    await expect(readText('schema.md')).resolves.toContain(
      '/schema/regesta-v0.schema.json',
    )
    await expect(readText('protocol.md')).resolves.toContain(
      '/schema/regesta-v0.schema.json',
    )
    await expect(readText('api.md')).resolves.toContain(
      '/openapi/regesta-v0.openapi.json',
    )
  })

  it('keeps the landing page honest about project status and public demo endpoints', async () => {
    const index = await readText('index.md')

    expect(index).toContain(
      'Regesta is an early draft and experimental implementation, not a production',
    )
    expect(index).toContain('https://registry.regesta.dev/')
    expect(index).toContain('https://npm.regesta.dev/')
    expect(index).toContain('The demo is not a production registry')

    for (const principle of [
      'Transparent',
      'Secure',
      'Modern',
      'Scalable',
      'Community-driven',
    ]) {
      expect(index).toContain(`**${principle}:**`)
    }
  })

  it('publishes parseable JSON Schema and OpenAPI references', async () => {
    const schema = await readJson(schemaPath)
    const openapi = await readJson(openapiPath)

    expect(member(schema, '$schema')).toBe(
      'https://json-schema.org/draft/2020-12/schema',
    )
    expect(member(schema, '$id')).toBe(
      'https://regesta.dev/schema/regesta-v0.schema.json',
    )
    expect(member(openapi, 'openapi')).toBe('3.1.0')
  })

  it('documents structured public error responses in OpenAPI', async () => {
    const errorProperties = await openapiValueAtPointer(
      '#/components/schemas/ErrorResponse/properties',
    )
    const required = await openapiValueAtPointer(
      '#/components/schemas/ErrorResponse/required',
    )

    expect(errorProperties).toEqual({
      code: { type: 'string' },
      error: { type: 'string' },
      issues: {
        items: { type: 'string' },
        type: 'array',
      },
      message: { type: 'string' },
    })
    expect(required).toEqual(['code', 'error', 'message'])
  })

  it('keeps the package id schema aligned with domain-scoped ids', async () => {
    const packageId = new RegExp(await schemaDefPattern('packageId'), 'u')

    for (const ecosystem of ['npm', 'pypi', 'cargo', 'go', 'oci']) {
      expect(packageId.test(`${ecosystem}:some.dev/sdk`)).toBe(true)
    }

    for (const value of [
      'NPM:some.dev/sdk',
      'npm:@some.dev/sdk',
      'npm:some/sdk',
      'npm:some.dev/',
      'npm:some.dev//sdk',
      'npm:some..dev/sdk',
    ]) {
      expect(packageId.test(value), value).toBe(false)
    }
  })

  it('keeps the owner domain schema aligned with trust validation', async () => {
    const ownerDomain = new RegExp(await schemaDefPattern('ownerDomain'), 'u')

    for (const value of ['some.dev', 'registry.example.com']) {
      expect(ownerDomain.test(value), value).toBe(true)
    }

    for (const value of [
      'Some.dev',
      'some',
      'some .dev',
      '-some.dev',
      'some-.dev',
      'some..dev',
    ]) {
      expect(ownerDomain.test(value), value).toBe(false)
    }
  })

  it('documents domain binding key validity windows in the JSON Schema', async () => {
    const ed25519KeyProperties = await schemaPropertiesAtPointer(
      '#/$defs/ed25519DomainBindingKey/properties',
    )
    const sshKeyProperties = await schemaPropertiesAtPointer(
      '#/$defs/sshEd25519DomainBindingKey/properties',
    )

    expect(ed25519KeyProperties.createdAt).toEqual({
      $ref: '#/$defs/canonicalTimestamp',
    })
    expect(ed25519KeyProperties.expiresAt).toEqual({
      $ref: '#/$defs/canonicalTimestamp',
    })
    expect(sshKeyProperties.createdAt).toEqual({
      $ref: '#/$defs/canonicalTimestamp',
    })
    expect(sshKeyProperties.expiresAt).toEqual({
      $ref: '#/$defs/canonicalTimestamp',
    })
  })

  it('keeps Ed25519 schema fields aligned with fixed-size auth values', async () => {
    const publicKey = new RegExp(
      await schemaDefPattern('ed25519PublicKey'),
      'u',
    )
    const signature = new RegExp(
      await schemaDefPattern('ed25519Signature'),
      'u',
    )

    expect(publicKey.test('A'.repeat(43))).toBe(true)
    expect(publicKey.test('A'.repeat(42))).toBe(false)
    expect(publicKey.test(`${'A'.repeat(43)}=`)).toBe(false)
    expect(signature.test('A'.repeat(86))).toBe(true)
    expect(signature.test('A'.repeat(85))).toBe(false)
    expect(signature.test(`${'A'.repeat(86)}=`)).toBe(false)

    const authProperties = await schemaPropertiesAtPointer(
      '#/$defs/ed25519AuthorizationProof/properties',
    )
    expect(authProperties.signature).toEqual({
      $ref: '#/$defs/ed25519Signature',
    })

    const jwkProperties = await schemaPropertiesAtPointer(
      '#/$defs/ed25519PublicKeyJwk/properties',
    )
    expect(jwkProperties.x).toEqual({
      $ref: '#/$defs/ed25519PublicKey',
    })
  })

  it('documents current signed write authorization shapes', async () => {
    await expect(
      schemaValueAtPointer('#/$defs/writeAuthorization/oneOf'),
    ).resolves.toEqual([
      { $ref: '#/$defs/ed25519WriteAuthorization' },
      { $ref: '#/$defs/sshEd25519WriteAuthorization' },
    ])

    const ed25519AuthorizationProperties = await schemaPropertiesAtPointer(
      '#/$defs/ed25519WriteAuthorization/properties',
    )
    const sshAuthorizationProperties = await schemaPropertiesAtPointer(
      '#/$defs/sshEd25519WriteAuthorization/properties',
    )

    expect(ed25519AuthorizationProperties.payload).toEqual({
      $ref: '#/$defs/writeIntent',
    })
    expect(sshAuthorizationProperties.payload).toEqual({
      $ref: '#/$defs/writeIntent',
    })
    expect(sshAuthorizationProperties.signature).toEqual({
      $ref: '#/$defs/openSshSignature',
    })
    await expect(
      schemaValueAtPointer('#/$defs/writeIntent/oneOf'),
    ).resolves.toEqual([
      { $ref: '#/$defs/releasePublishWriteIntent' },
      { $ref: '#/$defs/channelUpdateWriteIntent' },
      { $ref: '#/$defs/channelDeleteWriteIntent' },
    ])
    await expect(
      schemaValueAtPointer(
        '#/$defs/releasePublishWriteIntent/allOf/1/required',
      ),
    ).resolves.toEqual([
      'artifactDescriptorDigest',
      'artifactDigests',
      'channel',
      'configDigest',
      'operation',
      'sourceDigest',
      'version',
    ])

    const channelUpdateProperties = await schemaPropertiesAtPointer(
      '#/$defs/channelUpdateWriteIntent/allOf/1/properties',
    )
    const channelDeleteProperties = await schemaPropertiesAtPointer(
      '#/$defs/channelDeleteWriteIntent/allOf/1/properties',
    )

    expect(channelUpdateProperties.operation).toEqual({
      const: 'channel.update',
    })
    expect(channelDeleteProperties.operation).toEqual({
      const: 'channel.delete',
    })
  })

  it('documents the public object inventory page shape', async () => {
    await expect(schemaValueAtPointer('#/oneOf')).resolves.toEqual(
      expect.arrayContaining([{ $ref: '#/$defs/objectInventory' }]),
    )
    const inventoryProperties = await schemaPropertiesAtPointer(
      '#/$defs/objectInventory/properties',
    )
    const inventoryRequired = await schemaValueAtPointer(
      '#/$defs/objectInventory/required',
    )

    expect(inventoryProperties.object).toEqual({
      const: 'regesta.object-inventory',
    })
    expect(inventoryProperties.objects).toEqual({
      items: { $ref: '#/$defs/objectDescriptor' },
      type: 'array',
    })
    expect(inventoryProperties.nextAfter).toEqual({
      $ref: '#/$defs/sha256Digest',
    })
    expect(inventoryRequired).toEqual(['object', 'objects'])
  })

  it('keeps local reference pointers resolvable', async () => {
    const documents = new Map<string, unknown>([
      [schemaPath, await readJson(schemaPath)],
      [openapiPath, await readJson(openapiPath)],
    ])

    for (const [documentPath, document] of documents) {
      for (const reference of collectReferences(document)) {
        const target = resolveReferenceDocument(documentPath, reference.ref)
        const targetDocument = documents.get(target.documentPath)

        expect(
          targetDocument,
          `${reference.path} references missing file ${target.documentPath}`,
        ).toBeDefined()
        resolveJsonPointer(
          requiredDocument(targetDocument),
          target.pointer,
          reference.path,
        )
      }
    }
  })

  it('covers implemented transport routes in the OpenAPI reference', async () => {
    expect(await openapiPaths()).toEqual(
      expect.arrayContaining(['/', '/health', '/ready']),
    )
  })

  it('covers implemented core registry routes in the OpenAPI reference', async () => {
    expect(await openapiPaths()).toEqual(
      expect.arrayContaining([
        '/events',
        '/events/{algorithm}/{hex}',
        '/objects',
        '/objects/{algorithm}/{hex}',
        '/objects/{digest}',
        '/packages/{packageId}',
        '/packages/{packageId}/channels/{channel}',
        '/packages/{packageId}/releases/{version}',
        '/packages/{packageId}/releases/{version}/verification',
        '/releases',
      ]),
    )
  })

  it('covers implemented npm projection routes in the OpenAPI reference', async () => {
    expect(await openapiPaths()).toEqual(
      expect.arrayContaining([
        '/-/package/{encoded}/dist-tags',
        '/-/package/{scope}/{name}/dist-tags',
        '/-/ping',
        '/{encoded}',
        '/{name}/-/{file}',
        '/{scope}/{name}',
        '/{scope}/{name}/-/{file}',
        '/{scope}/{name}/{tagOrVersion}',
      ]),
    )
  })

  it('documents unscoped npm fallback version routes on the shared npm path', async () => {
    await expect(readText('api.md')).resolves.toContain('GET /tinyexec/latest')
    await expect(
      openapiValueAtPointer('#/paths/~1{scope}~1{name}/get/description'),
    ).resolves.toContain('/tinyexec/latest')
    await expect(
      openapiValueAtPointer('#/components/parameters/NpmScope/description'),
    ).resolves.toContain('package name')
    await expect(
      openapiValueAtPointer('#/components/parameters/NpmName/description'),
    ).resolves.toContain('tag or version')
  })

  it('documents the manual fork bootstrap without claiming checkpointed forks', async () => {
    await expect(readText('roadmap.md')).resolves.toContain(
      'Document the V0 manual fork bootstrap workflow',
    )
    await expect(readText('mirroring.md')).resolves.toContain(
      '## Manual Fork Bootstrap',
    )
    await expect(readText('mirroring.md')).resolves.toContain(
      'V0 does not define a checkpoint-based fork procedure',
    )
  })

  it('keeps operational smoke checks documented and script-backed', async () => {
    const operations = await readText('operations.md')
    const normalizedOperations = operations.replaceAll(/\s+/gu, ' ')
    const packageJson = await readWorkspaceJson('package.json')
    const scripts = member(packageJson, 'scripts')

    if (!isRecord(scripts)) {
      throw new TypeError('workspace package.json scripts must be an object')
    }

    expect(scripts['smoke:docker']).toBe('node scripts/docker-smoke.mjs')
    expect(scripts['smoke:load']).toBe(
      'node --conditions=regesta-source scripts/load-smoke.mjs',
    )

    for (const text of [
      'pnpm smoke:docker',
      'pnpm smoke:load',
      'REGESTA_LOAD_PROFILE=local pnpm smoke:load',
      'SQLite/filesystem',
      'checks readiness',
      'reads core package state',
      'reads events',
      'lists object inventory',
      'reads objects',
      'reads the npm projection',
      'readiness reads',
      'object inventory reads',
      'redirected object downloads',
      'readiness checks are cheap, bounded, independent adapter probes',
      'REGESTA_READINESS_TIMEOUT_MS',
      'falling back to a 5s timeout',
    ]) {
      expect(normalizedOperations).toContain(text)
    }
    expect(normalizedOperations).toContain('npm tarball redirects')
  })

  it('documents npm metadata tarball URLs and projection redirects', async () => {
    const tarballSchema = await openapiValueAtPointer(
      '#/components/schemas/NpmVersionManifest/properties/dist/properties/tarball',
    )
    const redirectDescription = await openapiValueAtPointer(
      '#/components/responses/NpmTarballRedirect/description',
    )

    expect(tarballSchema).toEqual(
      expect.objectContaining({
        description: expect.stringContaining('core object URL'),
        format: 'uri',
        type: 'string',
      }),
    )
    expect(tarballSchema).toEqual(
      expect.objectContaining({
        description: expect.stringContaining('without rewriting'),
      }),
    )
    expect(redirectDescription).toEqual(
      expect.stringContaining('direct npm projection tarball requests'),
    )
    expect(redirectDescription).toEqual(
      expect.stringContaining('never serves or proxies tarball bytes'),
    )
  })

  it('documents npm tarball routes as redirect-only endpoints', async () => {
    for (const path of ['/{name}/-/{file}', '/{scope}/{name}/-/{file}']) {
      for (const method of ['get', 'head']) {
        await expect(
          openapiValueAtPointer(
            `#/paths/${escapeJsonPointer(path)}/${method}/responses`,
          ),
        ).resolves.toEqual({
          '302': {
            $ref: '#/components/responses/NpmTarballRedirect',
          },
        })
      }
    }
  })

  it('documents npm metadata routes as conditionally cacheable', async () => {
    for (const path of [
      '/-/package/{encoded}/dist-tags',
      '/-/package/{scope}/{name}/dist-tags',
      '/{encoded}',
      '/{scope}/{name}',
      '/{scope}/{name}/{tagOrVersion}',
    ]) {
      for (const method of ['get', 'head']) {
        await expect(
          openapiValueAtPointer(
            `#/paths/${escapeJsonPointer(path)}/${method}/responses/304`,
          ),
        ).resolves.toEqual({
          $ref: '#/components/responses/NotModified',
        })
      }
    }
  })

  it('documents npm metadata routes as upstream-fallback error surfaces', async () => {
    for (const path of [
      '/-/package/{encoded}/dist-tags',
      '/-/package/{scope}/{name}/dist-tags',
      '/{encoded}',
      '/{scope}/{name}',
      '/{scope}/{name}/{tagOrVersion}',
    ]) {
      for (const method of ['get', 'head']) {
        await expect(
          openapiValueAtPointer(
            `#/paths/${escapeJsonPointer(path)}/${method}/responses/502`,
          ),
        ).resolves.toEqual({
          $ref: '#/components/responses/Error',
        })
      }
    }
  })

  it('documents npm fallback failures as projection-only structured errors', async () => {
    const api = await readText('api.md')
    const normalizedApi = api.replaceAll(/\s+/gu, ' ')

    expect(normalizedApi).toContain('structured `502` error')
    expect(normalizedApi).toContain('`upstream_npm_registry_unavailable`')
    expect(normalizedApi).toContain(
      'does not create Regesta core package state',
    )
  })

  it('covers implemented OpenAPI methods for documented routes', async () => {
    await expect(openapiRouteMethods()).resolves.toEqual(
      expectedOpenapiRouteMethods,
    )
  })

  it('keeps API prose route lists aligned with the OpenAPI reference', async () => {
    await expect(apiProseRouteMethods()).resolves.toEqual(
      expectedOpenapiRouteMethods,
    )
  })

  it('keeps public HTTP routes free of API and path-version prefixes', async () => {
    for (const path of await openapiPaths()) {
      expect(path, `${path} must not use an /api prefix`).not.toMatch(
        /^\/api(?:\/|$)/u,
      )
      expect(path, `${path} must not use a path version prefix`).not.toMatch(
        /^\/v\d+(?:\/|$)/u,
      )
    }

    for (const operation of await apiProseOperations()) {
      expect(
        operation.sourcePath,
        `${operation.method.toUpperCase()} ${operation.sourcePath} must not use an /api prefix`,
      ).not.toMatch(/^\/api(?:\/|$)/u)
      expect(
        operation.sourcePath,
        `${operation.method.toUpperCase()} ${operation.sourcePath} must not use a path version prefix`,
      ).not.toMatch(/^\/v\d+(?:\/|$)/u)
    }
  })

  it('keeps current public references free of per-object version fields', async () => {
    const fieldName = ['spec', 'Version'].join('')

    for (const path of [
      'api.md',
      'protocol.md',
      'schema.md',
      schemaPath,
      openapiPath,
    ]) {
      await expect(readText(path), path).resolves.not.toMatch(
        new RegExp(String.raw`\b${fieldName}\b`, 'u'),
      )
    }
  })

  it('keeps deployment info free of HTTP API version metadata', async () => {
    const openapi = await readJson(openapiPath)
    const info = member(openapi, 'info')
    const properties = await openapiValueAtPointer(
      '#/components/schemas/DeploymentInfo/properties',
    )
    const required = await openapiValueAtPointer(
      '#/components/schemas/DeploymentInfo/required',
    )
    const packageStatistics = await openapiValueAtPointer(
      '#/components/schemas/DeploymentInfo/properties/statistics/properties/packages',
    )

    if (!isRecord(properties)) {
      throw new TypeError('DeploymentInfo properties must be an object')
    }

    if (!Array.isArray(required)) {
      throw new TypeError('DeploymentInfo required fields must be an array')
    }

    if (!isRecord(info)) {
      throw new TypeError('OpenAPI info must be an object')
    }

    if (!isRecord(packageStatistics)) {
      throw new TypeError('DeploymentInfo package statistics must be an object')
    }

    const deploymentInfoFields = [
      'build',
      'git',
      'object',
      'runtime',
      'service',
      'statistics',
      'version',
    ]

    expect(properties).not.toHaveProperty('api')
    expect(Object.keys(properties).toSorted()).toEqual(deploymentInfoFields)
    expect(required).not.toContain('api')
    expect(required.toSorted()).toEqual(deploymentInfoFields)
    expect(packageStatistics).toMatchObject({
      maximum: Number.MAX_SAFE_INTEGER,
      minimum: 0,
      type: 'integer',
    })

    for (const key of ['title', 'summary', 'description']) {
      const value = member(info, key)
      if (typeof value === 'string') {
        expect(value).not.toContain('V0 HTTP API')
      }
    }

    await expect(readText('api.md')).resolves.not.toContain('API version')
  })

  it('documents no-store caching for transport status routes', async () => {
    await expect(
      openapiValueAtPointer('#/components/headers/NoStoreCacheControl/schema'),
    ).resolves.toEqual({ const: 'no-store' })

    for (const pointer of [
      '#/paths/~1/get/responses/200/headers/Cache-Control',
      '#/paths/~1/head/responses/200/headers/Cache-Control',
      '#/paths/~1health/get/responses/200/headers/Cache-Control',
      '#/paths/~1health/head/responses/200/headers/Cache-Control',
      '#/paths/~1ready/get/responses/200/headers/Cache-Control',
      '#/paths/~1ready/get/responses/503/headers/Cache-Control',
      '#/paths/~1ready/head/responses/200/headers/Cache-Control',
      '#/paths/~1ready/head/responses/503/headers/Cache-Control',
    ]) {
      await expect(openapiValueAtPointer(pointer), pointer).resolves.toEqual({
        $ref: '#/components/headers/NoStoreCacheControl',
      })
    }
  })

  it('documents readiness as named independent adapter checks', async () => {
    const api = await readText('api.md')
    const readinessDescription = await openapiValueAtPointer(
      '#/components/schemas/ReadinessStatus/description',
    )

    expect(readinessDescription).toContain('Aggregate adapter readiness status')
    expect(readinessDescription).toContain(
      'bounded by deployment timeout policy',
    )
    expect(api).toContain(
      '`/ready` aggregates independent adapter readiness checks',
    )
    expect(api).toMatch(/must\s+not depend on probe ordering/u)
  })

  it('documents deployment statistics as advisory cached status data', async () => {
    await expect(
      openapiValueAtPointer(
        '#/components/schemas/DeploymentInfo/properties/statistics/description',
      ),
    ).resolves.toContain('Advisory deployment statistics')
    await expect(
      openapiValueAtPointer(
        '#/components/schemas/DeploymentInfo/properties/statistics/properties/packages/description',
      ),
    ).resolves.toContain('not a consistency boundary')
    await expect(readText('api.md')).resolves.toContain(
      'Registry statistics are advisory status data.',
    )
    await expect(readText('api.md')).resolves.toContain(
      'briefly to keep status checks cheap under load.',
    )
  })

  it('keeps the machine-readable core schema free of ecosystem projection terms', async () => {
    const schema = await readText(schemaPath)

    for (const { label, pattern } of [
      { label: 'npm ecosystem', pattern: /\bnpm\b/u },
      { label: 'PyPI ecosystem', pattern: /\bpypi\b/u },
      { label: 'Cargo ecosystem', pattern: /\bcargo\b/u },
      { label: 'OCI ecosystem', pattern: /\boci\b/u },
      { label: 'npm packument', pattern: /\bpackument\b/u },
      { label: 'npm dist-tags', pattern: /dist-tags/u },
      { label: 'npm registry fallback', pattern: /registry\.npmjs\.org/u },
      { label: 'npm media type', pattern: /application\/vnd\.npm/u },
      { label: 'package manager manifest', pattern: /package\.json/u },
      { label: 'Python manifest', pattern: /pyproject\.toml/u },
      { label: 'Cargo manifest', pattern: /Cargo\.toml/u },
      { label: 'Go manifest', pattern: /go\.mod/u },
    ]) {
      expect(schema, `schema must not include ${label}`).not.toMatch(pattern)
    }
  })

  it('keeps API prose route examples backed by the OpenAPI reference', async () => {
    const routeMethods = await openapiRouteMethods()

    for (const operation of await apiProseOperations()) {
      expect(
        routeMethods[operation.path] ?? [],
        `${operation.method.toUpperCase()} ${operation.sourcePath} is missing from OpenAPI`,
      ).toContain(operation.method)
    }
  })
})

interface Reference {
  path: string
  ref: string
}

interface ReferenceTarget {
  documentPath: string
  pointer: string
}

function readText(path: string): Promise<string> {
  return readFile(new URL(path, docsRoot), 'utf8')
}

function readWorkspaceText(path: string): Promise<string> {
  return readFile(new URL(path, workspaceRoot), 'utf8')
}

async function readJson(path: string): Promise<unknown> {
  const text = await readText(path)
  const parsed: unknown = JSON.parse(text)

  return parsed
}

async function readWorkspaceJson(path: string): Promise<unknown> {
  const text = await readWorkspaceText(path)
  const parsed: unknown = JSON.parse(text)

  return parsed
}

async function openapiPaths(): Promise<string[]> {
  const openapi = await readJson(openapiPath)
  const paths = member(openapi, 'paths')

  if (!isRecord(paths)) {
    throw new TypeError('OpenAPI paths must be an object')
  }

  return Object.keys(paths).toSorted()
}

async function schemaDefPattern(name: string): Promise<string> {
  const schema = await readJson(schemaPath)
  const defs = member(schema, '$defs')

  if (!isRecord(defs)) {
    throw new TypeError('JSON Schema $defs must be an object')
  }

  const definition = member(defs, name)
  const pattern = member(definition, 'pattern')

  if (typeof pattern !== 'string') {
    throw new TypeError(`JSON Schema ${name} pattern must be a string`)
  }

  return pattern
}

async function schemaPropertiesAtPointer(
  pointer: string,
): Promise<Record<string, unknown>> {
  const properties = await schemaValueAtPointer(pointer)

  if (!isRecord(properties)) {
    throw new TypeError(`JSON Schema properties missing at ${pointer}`)
  }

  return properties
}

async function schemaValueAtPointer(pointer: string): Promise<unknown> {
  return resolveJsonPointer(await readJson(schemaPath), pointer, pointer)
}

async function openapiValueAtPointer(pointer: string): Promise<unknown> {
  return resolveJsonPointer(await readJson(openapiPath), pointer, pointer)
}

async function openapiRouteMethods(): Promise<Record<string, string[]>> {
  const openapi = await readJson(openapiPath)
  const paths = member(openapi, 'paths')

  if (!isRecord(paths)) {
    throw new TypeError('OpenAPI paths must be an object')
  }

  return Object.fromEntries(
    Object.entries(paths).map(([path, operations]) => {
      if (!isRecord(operations)) {
        throw new TypeError(`OpenAPI path must be an object: ${path}`)
      }

      return [path, Object.keys(operations).toSorted()]
    }),
  )
}

async function apiProseRouteMethods(): Promise<Record<string, string[]>> {
  const routeMethods: Record<string, string[]> = {}

  for (const operation of await apiProseOperations()) {
    routeMethods[operation.path] ??= []
    routeMethods[operation.path].push(operation.method)
  }

  return Object.fromEntries(
    Object.entries(routeMethods)
      .map(([path, methods]) => [path, methods.toSorted()])
      .toSorted(([left], [right]) => left.localeCompare(right)),
  )
}

async function apiProseOperations(): Promise<
  Array<{
    method: string
    path: string
    sourcePath: string
  }>
> {
  const source = await readText('api.md')
  const operations: Array<{
    method: string
    path: string
    sourcePath: string
  }> = []
  let inHttpBlock = false

  for (const line of source.split('\n')) {
    if (line === '```http') {
      inHttpBlock = true
      continue
    }

    if (inHttpBlock && line === '```') {
      inHttpBlock = false
      continue
    }

    if (!inHttpBlock) {
      continue
    }

    const match = /^(GET|HEAD|POST|PUT|DELETE)\s+(\S+)/u.exec(line)
    if (!match) {
      continue
    }

    const [, rawMethod, rawPath] = match
    operations.push({
      method: rawMethod.toLowerCase(),
      path: normalizeApiProsePath(rawPath),
      sourcePath: rawPath,
    })
  }

  return operations
}

function normalizeApiProsePath(path: string): string {
  const pathOnly = path.split('?', 1)[0]!

  if (pathOnly === '/{name}') {
    return '/{encoded}'
  }

  if (pathOnly === '/-/package/{name}/dist-tags') {
    return '/-/package/{encoded}/dist-tags'
  }

  return pathOnly
    .replaceAll('@scope', '{scope}')
    .replaceAll('/{scope}/name', '/{scope}/{name}')
    .replaceAll('{version-or-tag}', '{tagOrVersion}')
    .replaceAll('{tarball}', '{file}')
}

function escapeJsonPointer(segment: string): string {
  return segment.replaceAll('~', '~0').replaceAll('/', '~1')
}

function collectReferences(value: unknown): Reference[] {
  const references: Reference[] = []

  visitReferenceValue(value, '#', references)

  return references
}

function visitReferenceValue(
  value: unknown,
  path: string,
  references: Reference[],
): void {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      visitReferenceValue(item, `${path}/${index}`, references)
    }
    return
  }

  if (!isRecord(value)) {
    return
  }

  const ref = value.$ref
  if (typeof ref === 'string') {
    references.push({ path: `${path}/$ref`, ref })
  }

  for (const [key, item] of Object.entries(value)) {
    visitReferenceValue(
      item,
      `${path}/${escapeJsonPointerSegment(key)}`,
      references,
    )
  }
}

function resolveReferenceDocument(
  currentDocumentPath: string,
  ref: string,
): ReferenceTarget {
  const [path = '', pointer = ''] = ref.split('#', 2)

  if (path.length === 0) {
    return {
      documentPath: currentDocumentPath,
      pointer: `#${pointer}`,
    }
  }

  if (path === '../schema/regesta-v0.schema.json') {
    return {
      documentPath: schemaPath,
      pointer: `#${pointer}`,
    }
  }

  throw new Error(`Unsupported reference target: ${ref}`)
}

function resolveJsonPointer(
  document: unknown,
  pointer: string,
  referencePath: string,
): unknown {
  if (pointer === '#') {
    return document
  }

  if (!pointer.startsWith('#/')) {
    throw new Error(`${referencePath} has unsupported JSON pointer: ${pointer}`)
  }

  let current = document
  for (const rawSegment of pointer.slice(2).split('/')) {
    const segment = unescapeJsonPointerSegment(rawSegment)

    if (Array.isArray(current)) {
      const index = Number(segment)
      if (!Number.isInteger(index) || index < 0 || index >= current.length) {
        throw new Error(`${referencePath} points to missing array item`)
      }
      current = current[index]
      continue
    }

    if (!isRecord(current) || !(segment in current)) {
      throw new Error(`${referencePath} points to missing member: ${segment}`)
    }

    current = current[segment]
  }

  return current
}

function member(value: unknown, key: string): unknown {
  if (!isRecord(value)) {
    throw new TypeError('Expected a JSON object')
  }

  return value[key]
}

function requiredDocument(value: unknown): unknown {
  if (value === undefined) {
    throw new Error('Expected referenced document to exist')
  }

  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function escapeJsonPointerSegment(value: string): string {
  return value.replaceAll('~', '~0').replaceAll('/', '~1')
}

function unescapeJsonPointerSegment(value: string): string {
  return value.replaceAll('~1', '/').replaceAll('~0', '~')
}
