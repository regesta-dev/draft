import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

const docsRoot = new URL('./', import.meta.url)
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
    const keyProperties = await schemaPropertiesAtPointer(
      '#/$defs/domainBinding/properties/keys/items/properties',
    )

    expect(keyProperties.createdAt).toEqual({
      $ref: '#/$defs/canonicalTimestamp',
    })
    expect(keyProperties.expiresAt).toEqual({
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
      '#/$defs/authorizationProof/properties',
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
    const authorizationProperties = await schemaPropertiesAtPointer(
      '#/$defs/writeAuthorization/properties',
    )

    expect(authorizationProperties.payload).toEqual({
      $ref: '#/$defs/writeIntent',
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

  it('covers implemented OpenAPI methods for documented routes', async () => {
    await expect(openapiRouteMethods()).resolves.toEqual(
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

async function readJson(path: string): Promise<unknown> {
  const text = await readText(path)
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

  return pathOnly
    .replaceAll('@scope', '{scope}')
    .replaceAll('/{scope}/name', '/{scope}/{name}')
    .replaceAll('{version-or-tag}', '{tagOrVersion}')
    .replaceAll('{tarball}', '{file}')
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
