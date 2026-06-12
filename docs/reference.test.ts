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
  '/favicon.ico': ['get'],
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
    expect(index).toContain('Ecosystem-neutral core')
    expect(index).toContain(
      'npm, PyPI, Cargo, Go, OCI, and future protocols are projections over Regesta-native data',
    )

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

  it('documents ecosystem-neutral core data as the source for projections', async () => {
    const readme = await readWorkspaceText('README.md')
    const architecture = await readText('architecture.md')
    const projections = await readText('projections.md')
    const why = await readText('why-regesta.md')
    const normalizedArchitecture = architecture.replaceAll(/\s+/gu, ' ')
    const normalizedProjections = projections.replaceAll(/\s+/gu, ' ')
    const normalizedWhy = why.replaceAll(/\s+/gu, ' ')

    expect(readme).toContain(
      'npm, PyPI, Cargo, Go, OCI, and future ecosystems should be projections over a shared registry model',
    )
    expect(normalizedArchitecture).toContain(
      'The core model stores ecosystem-neutral facts',
    )
    expect(normalizedArchitecture).toContain(
      'core must not depend on projections',
    )
    expect(normalizedProjections).toContain(
      'Regesta core stores neutral registry facts. Ecosystem projections render those facts into package-manager-native protocols.',
    )
    expect(normalizedWhy).toContain(
      'Ecosystem APIs are projections over those facts.',
    )
  })

  it('documents community-driven governance without single-operator capture', async () => {
    const index = await readText('index.md')
    const readme = await readWorkspaceText('README.md')
    const why = await readText('why-regesta.md')
    const governance = await readText('governance.md')
    const normalizedIndex = index.replaceAll(/\s+/gu, ' ')
    const normalizedWhy = why.replaceAll(/\s+/gu, ' ')
    const normalizedGovernance = governance.replaceAll(/\s+/gu, ' ')

    expect(normalizedIndex).toContain(
      'the registry should not be controlled by one company, operator, or package ecosystem',
    )
    expect(readme).toContain(
      'community-driven and not controlled by any single company or operator',
    )
    expect(normalizedWhy).toContain(
      "not hidden inside one operator's private database",
    )
    expect(normalizedWhy).toContain(
      'no single operator can permanently capture the ecosystem',
    )
    expect(normalizedGovernance).toContain(
      'No single company, hosting provider, registry operator, or package ecosystem',
    )
    expect(normalizedGovernance).toContain(
      'the ecosystem should not depend on permanent trust in one company',
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
    const packageIdSchema = await schemaValueAtPointer('#/$defs/packageId')
    const openapiPackageIdParameterSchema = await openapiValueAtPointer(
      '#/components/parameters/PackageId/schema',
    )
    const openapiPackageIdSchema = await openapiValueAtPointer(
      '#/components/schemas/PackageId',
    )

    for (const ecosystem of [
      'npm',
      'pypi',
      'cargo',
      'go',
      'oci',
      'maven',
      'swift-pm',
    ]) {
      expect(packageId.test(`${ecosystem}:some.dev/sdk`)).toBe(true)
    }

    expect(member(packageIdSchema, 'description')).toContain(
      'ecosystem key is not a closed enum',
    )
    await expect(readText('api.md')).resolves.toContain(
      'Core API routes do not enumerate supported ecosystem keys',
    )
    expect(openapiPackageIdParameterSchema).toEqual({
      $ref: '#/components/schemas/PackageId',
    })
    expect(openapiPackageIdSchema).toEqual({
      $ref: '../schema/regesta-v0.schema.json#/$defs/packageId',
    })

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

    await expect(
      schemaValueAtPointer('#/$defs/writeIntentBase/description'),
    ).resolves.toContain(
      'The domain must exactly match the owner domain parsed from package',
    )
  })

  it('documents signed write authorization trust boundaries', async () => {
    const protocol = await readText('protocol.md')
    const normalizedProtocol = protocol.replaceAll(/\s+/gu, ' ')

    expect(normalizedProtocol).toContain(
      'The signature is over the canonical JSON form of `payload`.',
    )
    expect(normalizedProtocol).toContain(
      'The payload `domain` must exactly match the owner domain parsed from payload `package`.',
    )
    expect(normalizedProtocol).toContain(
      "The server verifies the signature against that owner domain's current domain binding at write time.",
    )
    expect(normalizedProtocol).toContain(
      'SSH signatures use the `regesta` namespace',
    )
    expect(normalizedProtocol).toContain(
      "cannot be replayed as Git signatures or another protocol's authorization",
    )
    expect(normalizedProtocol).toContain(
      'Accepted events snapshot `regesta.authorization-proof` material',
    )
    expect(normalizedProtocol).toContain('well-known binding digest')
    expect(normalizedProtocol).toContain(
      'V0 events do not publish the full signed intent payload.',
    )
  })

  it('documents signed write authorization trust boundaries in OpenAPI', async () => {
    for (const pointer of [
      '#/paths/~1releases/post/requestBody/content/multipart~1form-data/schema/properties/authorization/description',
      '#/paths/~1packages~1{packageId}~1channels~1{channel}/put/requestBody/content/application~1json/schema/properties/authorization/description',
      '#/paths/~1packages~1{packageId}~1channels~1{channel}/delete/requestBody/content/application~1json/schema/properties/authorization/description',
    ]) {
      await expect(openapiValueAtPointer(pointer), pointer).resolves.toContain(
        'The payload domain must match the owner domain parsed from payload package.',
      )
    }
  })

  it('documents write authorization failures in OpenAPI', async () => {
    for (const pointer of [
      '#/paths/~1releases/post/responses/401',
      '#/paths/~1packages~1{packageId}~1channels~1{channel}/put/responses/401',
      '#/paths/~1packages~1{packageId}~1channels~1{channel}/delete/responses/401',
    ]) {
      await expect(openapiValueAtPointer(pointer), pointer).resolves.toEqual({
        $ref: '#/components/responses/Error',
      })
    }
  })

  it('documents write authorization failure status codes in the API guide', async () => {
    const api = await readText('api.md')
    const normalizedApi = api.replaceAll(/\s+/gu, ' ')

    expect(normalizedApi).toContain(
      'Write authorization failures return `401` with code `write_authorization_invalid`.',
    )
    expect(normalizedApi).toContain(
      'Replayed write authorizations return `409` with code `write_authorization_replayed`.',
    )
  })

  it('keeps V0 provenance honest about source attachment', async () => {
    const readme = await readWorkspaceText('README.md')
    const protocol = await readText('protocol.md')
    const schema = await readText('schema.md')

    await expect(
      schemaPropertiesAtPointer(
        '#/$defs/regestaConfig/properties/provenance/properties',
      ),
    ).resolves.toEqual({
      level: { const: 'source-attached' },
    })
    await expect(
      schemaPropertiesAtPointer(
        '#/$defs/releaseManifest/properties/provenance/properties',
      ),
    ).resolves.toEqual({
      level: { const: 'source-attached' },
      verified: { const: false },
    })
    await expect(
      schemaValueAtPointer(
        '#/$defs/releaseManifest/properties/provenance/required',
      ),
    ).resolves.toEqual(['level', 'verified'])

    expect(readme).toContain(
      'v0 is source-attached, not trusted-builder verified',
    )
    expect(schema).toContain(
      'Those fields are inspection metadata, not safety claims.',
    )
    expect(schema).toMatch(/V0 does not prove that\s+source built an artifact/u)
    expect(protocol).toContain('the source built the artifact')
    expect(protocol).toContain('externally witnessed transparency checkpoints')
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

  it('keeps unresolved transparency and governance objects out of the current V0 protocol surface', async () => {
    const schema = await readText(schemaPath)
    const openapi = await readText(openapiPath)
    const protocolEvents = await readWorkspaceText(
      'packages/protocol/src/event.ts',
    )
    const roadmap = await readText('roadmap.md')
    const mirroring = await readText('mirroring.md')
    const governance = await readText('governance.md')
    const normalizedRoadmap = roadmap.replaceAll(/\s+/gu, ' ')
    const normalizedMirroring = mirroring.replaceAll(/\s+/gu, ' ')
    const normalizedGovernance = governance.replaceAll(/\s+/gu, ' ')

    await expect(
      schemaValueAtPointer('#/$defs/registryEvent/oneOf'),
    ).resolves.toEqual([
      { $ref: '#/$defs/publishReleaseEvent' },
      { $ref: '#/$defs/channelUpdatedEvent' },
      { $ref: '#/$defs/channelDeletedEvent' },
    ])
    expect(protocolEvents).toContain(
      'export type RegistryEvent =\n  | ChannelDeletedEvent\n  | ChannelUpdatedEvent\n  | PublishReleaseEvent',
    )
    for (const eventType of [
      'checkpoint.published',
      'freeze.created',
      'freeze.removed',
      'governance.action',
      'package.yanked',
      'takedown.created',
      'witness.signed',
    ]) {
      expect(schema, `${eventType} must not be in V0 schema`).not.toContain(
        eventType,
      )
      expect(openapi, `${eventType} must not be in V0 OpenAPI`).not.toContain(
        eventType,
      )
      expect(
        protocolEvents,
        `${eventType} must not be in current protocol event types`,
      ).not.toContain(eventType)
    }
    expect(await openapiPaths()).not.toEqual(
      expect.arrayContaining([
        '/checkpoints',
        '/governance/events',
        '/proofs/{eventId}',
        '/witnesses',
      ]),
    )
    expect(normalizedRoadmap).toContain(
      'The unchecked governance event item is intentionally unresolved protocol work.',
    )
    expect(normalizedMirroring).toContain(
      'Checkpoint, proof, and witness work should not start from implementation convenience.',
    )
    expect(normalizedGovernance).toContain(
      'Future governance events should be append-only public facts.',
    )
  })

  it('keeps operational smoke checks documented and script-backed', async () => {
    const dockerSmokeScript = await readWorkspaceText(
      'scripts/docker-smoke.mjs',
    )
    const loadSmokeScript = await readWorkspaceText('scripts/load-smoke.mjs')
    const gettingStarted = await readText('getting-started.md')
    const normalizedGettingStarted = gettingStarted.replaceAll(/\s+/gu, ' ')
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
    expect(dockerSmokeScript).toContain(
      'Docker smoke requires a running Docker daemon.',
    )
    expect(dockerSmokeScript).toContain(
      'Start Docker and retry `pnpm smoke:docker`.',
    )
    expect(dockerSmokeScript).toContain("object: 'regesta.deployment-info'")
    expect(dockerSmokeScript).toContain('packages: 1')
    expect(loadSmokeScript).toContain("object: 'regesta.deployment-info'")
    expect(loadSmokeScript).toContain('packages: published.length')

    for (const text of [
      'pnpm smoke:docker',
      'pnpm smoke:load',
      'REGESTA_LOAD_PROFILE=local pnpm smoke:load',
      'SQLite/filesystem',
      'reads root deployment statistics',
      'checks readiness',
      'reads core package state',
      'reads events',
      'lists object inventory',
      'reads objects',
      'reads the npm projection',
      'Runtime Configuration',
      'REGESTA_DATA_DIR',
      'REGESTA_DOMAIN_BINDING_TIMEOUT_MS',
      'REGESTA_MAX_REQUEST_BYTES',
      'REGESTA_MAX_PUBLISH_ARTIFACT_BYTES',
      'REGESTA_MAX_PUBLISH_SOURCE_BYTES',
      'readiness reads',
      'root deployment statistics',
      'object inventory reads',
      'redirected object downloads',
      'readiness checks are cheap, bounded, independent adapter probes',
      'REGESTA_READINESS_TIMEOUT_MS',
      'falling back to a 5s timeout',
      'REGESTA_NPM_UPSTREAM_TIMEOUT_MS',
      'falling back to a 10s timeout',
      'domain well-known binding discovery',
      'tarball routes, which remain redirect-only',
      'REGESTA_STATISTICS_CACHE_TTL_MS',
      'disable cross-request statistics caching',
      'In-flight statistics reads are still coalesced',
      'transport guard over declared',
      'Malformed `Content-Length` returns `400`',
      'declared body larger than the configured limit returns `413`',
      'CORS preflight requests are answered before this guard',
      'Numeric runtime values must be decimal safe integers',
      'without whitespace',
    ]) {
      expect(normalizedOperations).toContain(text)
    }
    expect(normalizedOperations).toContain('npm tarball redirects')
    expect(normalizedOperations).toContain(
      'requires an accessible Docker daemon',
    )
    expect(normalizedOperations).toContain('runs a real OCI image')
    expect(normalizedGettingStarted).toContain(
      'requires an accessible Docker daemon',
    )
    expect(normalizedGettingStarted).toContain(
      'reports the missing daemon prerequisite',
    )
    expect(normalizedGettingStarted).toContain('verifies deployment statistics')
    expect(normalizedGettingStarted).toContain(
      'reads root deployment statistics',
    )
  })

  it('documents npm metadata tarball URLs and projection redirects', async () => {
    const tarballSchema = await openapiValueAtPointer(
      '#/components/schemas/NpmVersionManifest/properties/dist/properties/tarball',
    )
    const versionManifestDescription = await openapiValueAtPointer(
      '#/components/schemas/NpmVersionManifest/description',
    )
    const redirectDescription = await openapiValueAtPointer(
      '#/components/responses/NpmTarballRedirect/description',
    )

    expect(versionManifestDescription).toContain(
      'projects only supported resolver fields',
    )
    expect(versionManifestDescription).toContain(
      'upstream fallback metadata preserves upstream fields',
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
        description: expect.stringContaining('npm projection tarball URL'),
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
      expect.stringContaining('Local releases redirect'),
    )
    expect(redirectDescription).toEqual(
      expect.stringContaining('missing packages and versions redirect'),
    )
    expect(redirectDescription).toEqual(
      expect.stringContaining('never serves or proxies tarball bytes'),
    )
  })

  it('documents npm tarball routes as redirect-only endpoints', async () => {
    await expect(
      openapiValueAtPointer(
        '#/components/responses/NpmTarballRedirect/headers/Cache-Control',
      ),
    ).resolves.toEqual({
      $ref: '#/components/headers/NoCacheControl',
    })

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
    await expect(
      openapiValueAtPointer(
        '#/components/headers/NpmMetadataCacheControl/description',
      ),
    ).resolves.toContain('Local mutable projections use no-cache')
    await expect(
      openapiValueAtPointer(
        '#/components/headers/NpmMetadataCacheControl/description',
      ),
    ).resolves.toContain('without forwarding upstream cookies')
    await expect(
      openapiValueAtPointer('#/components/headers/NpmMetadataEtag/description'),
    ).resolves.toContain('Local projections derive this from Regesta state')
    await expect(
      openapiValueAtPointer(
        '#/components/headers/NpmMetadataLastModified/description',
      ),
    ).resolves.toContain('upstream fallback metadata')
    await expect(
      openapiValueAtPointer(
        '#/components/headers/NpmMetadataLastModified/description',
      ),
    ).resolves.toContain('response metadata allowlist')
    await expect(
      openapiValueAtPointer(
        '#/components/parameters/NpmMetadataIfNoneMatch/description',
      ),
    ).resolves.toContain('upstream fallback forwards it')
    await expect(
      openapiValueAtPointer(
        '#/components/parameters/NpmMetadataIfNoneMatch/description',
      ),
    ).resolves.toContain('request header allowlist')
    await expect(
      openapiValueAtPointer(
        '#/components/parameters/NpmMetadataIfModifiedSince/description',
      ),
    ).resolves.toContain('If-None-Match is not present')
    await expect(
      openapiValueAtPointer(
        '#/components/parameters/NpmMetadataIfModifiedSince/description',
      ),
    ).resolves.toContain('request header allowlist')
    await expect(
      openapiValueAtPointer(
        '#/components/responses/NotModified/headers/Cache-Control',
      ),
    ).resolves.toEqual({
      $ref: '#/components/headers/NpmMetadataCacheControl',
    })
    await expect(
      openapiValueAtPointer('#/components/responses/NotModified/headers/ETag'),
    ).resolves.toEqual({
      $ref: '#/components/headers/NpmMetadataEtag',
    })
    await expect(
      openapiValueAtPointer(
        '#/components/responses/NotModified/headers/Last-Modified',
      ),
    ).resolves.toEqual({
      $ref: '#/components/headers/NpmMetadataLastModified',
    })

    const api = await readText('api.md')
    const projections = await readText('projections.md')
    const normalizedApi = api.replaceAll(/\s+/gu, ' ')
    const normalizedProjections = projections.replaceAll(/\s+/gu, ' ')
    expect(api).toContain('npm projection metadata uses projection-specific')
    expect(api).toContain('may include `Last-Modified`')
    expect(api).toContain('`If-Modified-Since` can produce')
    expect(normalizedApi).toContain('`If-None-Match` takes precedence')
    expect(api).toContain('explicit supported-field allowlist')
    expect(normalizedApi).toContain(
      'Unknown npm artifact metadata fields remain artifact inspection data',
    )
    expect(normalizedProjections).toContain(
      'emits only the supported npm resolver metadata fields',
    )
    expect(normalizedProjections).toContain(
      'Unknown artifact metadata fields stay inside the Regesta artifact metadata',
    )
    expect(api).toContain('upstream fallback metadata preserves upstream')
    expect(api).toContain('`ETag`, `Last-Modified`, and cache policy headers')
    expect(api).toContain(
      'Client metadata validators such as `If-None-Match` and `If-Modified-Since`',
    )
    expect(api).toContain('upstream `304` responses preserve')

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
            `#/paths/${escapeJsonPointer(path)}/${method}/responses/200/headers/Cache-Control`,
          ),
        ).resolves.toEqual({
          $ref: '#/components/headers/NpmMetadataCacheControl',
        })
        await expect(
          openapiValueAtPointer(
            `#/paths/${escapeJsonPointer(path)}/${method}/responses/200/headers/Content-Length`,
          ),
        ).resolves.toEqual({
          $ref: '#/components/headers/ContentLength',
        })
        await expect(
          openapiValueAtPointer(
            `#/paths/${escapeJsonPointer(path)}/${method}/responses/200/headers/ETag`,
          ),
        ).resolves.toEqual({
          $ref: '#/components/headers/NpmMetadataEtag',
        })
        await expect(
          openapiValueAtPointer(
            `#/paths/${escapeJsonPointer(path)}/${method}/responses/200/headers/Last-Modified`,
          ),
        ).resolves.toEqual({
          $ref: '#/components/headers/NpmMetadataLastModified',
        })
        await expect(
          openapiValueAtPointer(
            `#/paths/${escapeJsonPointer(path)}/${method}/responses/304`,
          ),
        ).resolves.toEqual({
          $ref: '#/components/responses/NotModified',
        })

        const parameters = await openapiValueAtPointer(
          `#/paths/${escapeJsonPointer(path)}/${method}/parameters`,
        )
        expect(parameters).toEqual(
          expect.arrayContaining([
            { $ref: '#/components/parameters/NpmMetadataIfNoneMatch' },
            { $ref: '#/components/parameters/NpmMetadataIfModifiedSince' },
          ]),
        )
      }
    }
  })

  it('documents npm utility routes as explicit no-cache JSON responses', async () => {
    for (const method of ['get', 'head']) {
      await expect(
        openapiValueAtPointer(
          `#/paths/~1-~1ping/${method}/responses/200/headers/Cache-Control`,
        ),
      ).resolves.toEqual({
        $ref: '#/components/headers/NoCacheControl',
      })
      await expect(
        openapiValueAtPointer(
          `#/paths/~1-~1ping/${method}/responses/200/headers/Content-Length`,
        ),
      ).resolves.toEqual({
        $ref: '#/components/headers/ContentLength',
      })
    }

    const api = await readText('api.md')

    expect(api).toContain('the root path returns an empty JSON object')
    expect(api).toContain('Root and ping utility responses include')
    expect(api).toContain('`Cache-Control: no-cache`')
    expect(api).toContain('and `Content-Length`')
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
    const openapi = await readJson(openapiPath)
    const tags = member(openapi, 'tags')
    const api = await readText('api.md')
    const normalizedApi = api.replaceAll(/\s+/gu, ' ')
    const projections = await readText('projections.md')
    const normalizedProjections = projections.replaceAll(/\s+/gu, ' ')

    if (!Array.isArray(tags)) {
      throw new TypeError('OpenAPI tags must be an array')
    }

    const npmProjectionTag = tags.find((tag) => {
      return isRecord(tag) && tag.name === 'npm Projection'
    })

    expect(npmProjectionTag).toMatchObject({
      description: expect.stringContaining(
        'Fallback metadata requests forward only metadata negotiation and cache validators',
      ),
    })
    expect(npmProjectionTag).toMatchObject({
      description: expect.stringContaining(
        'fallback metadata responses expose only cache and content metadata headers',
      ),
    })
    expect(normalizedApi).toContain('structured `502` error')
    expect(normalizedApi).toContain('`upstream_npm_registry_unavailable`')
    expect(normalizedApi).toContain(
      'does not create Regesta core package state',
    )
    expect(normalizedApi).toContain(
      'Client credentials, including `Authorization`, `Cookie`, and npm token headers, are not forwarded',
    )
    expect(normalizedApi).toContain(
      'Fallback responses preserve only cache and content metadata headers',
    )
    expect(normalizedProjections).toContain(
      'client credentials such as `Authorization`, `Cookie`, and npm token headers stay local',
    )
    expect(normalizedProjections).toContain(
      'upstream cookies, redirects, authentication challenges, and extension headers do not become Regesta projection response headers',
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

    for (const path of [
      'api.md',
      'protocol.md',
      'schema.md',
      schemaPath,
      openapiPath,
    ]) {
      await expect(readText(path), path).resolves.not.toMatch(
        /\bversioned(?:\s+[^\s.]+)*\s+endpoint\b/iu,
      )
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

    for (const path of [
      'api.md',
      'protocol.md',
      'schema.md',
      schemaPath,
      openapiPath,
    ]) {
      await expect(readText(path), path).resolves.not.toContain('API version')
    }
  })

  it('documents no-store caching for transport status routes', async () => {
    await expect(
      openapiValueAtPointer('#/components/headers/NoStoreCacheControl/schema'),
    ).resolves.toEqual({ const: 'no-store' })

    for (const pointer of [
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

  it('documents permissive CORS at the transport layer', async () => {
    await expect(
      openapiValueAtPointer('#/tags/0/description'),
    ).resolves.toContain('CORS')

    const api = await readText('api.md')
    const normalizedApi = api.replaceAll(/\s+/gu, ' ')

    expect(api).toContain(
      'The transport layer applies permissive CORS before mounted registry layers.',
    )
    expect(api).toContain('Access-Control-Allow-Origin: *')
    expect(api).toContain('`OPTIONS` preflight requests can target any')
    expect(api).toContain('Access-Control-Allow-Headers')
    expect(normalizedApi).toContain(
      'Preflight requests are answered before request-size limit enforcement',
    )
  })

  it('documents transport request-size errors for write bodies', async () => {
    for (const pointer of [
      '#/paths/~1releases/post/responses/413',
      '#/paths/~1packages~1{packageId}~1channels~1{channel}/put/responses/413',
      '#/paths/~1packages~1{packageId}~1channels~1{channel}/delete/responses/413',
    ]) {
      await expect(openapiValueAtPointer(pointer), pointer).resolves.toEqual({
        $ref: '#/components/responses/Error',
      })
    }

    const api = await readText('api.md')
    const normalizedApi = api.replaceAll(/\s+/gu, ' ')

    expect(normalizedApi).toContain(
      'When `Content-Length` is malformed, the transport layer rejects the request with `400` before mounted route handlers',
    )
    expect(normalizedApi).toContain(
      'rejects the request with `413` and the `request_too_large` error code',
    )
  })

  it('documents host-specific root responses', async () => {
    await expect(
      openapiValueAtPointer('#/components/headers/RootCacheControl/schema'),
    ).resolves.toEqual({ enum: ['no-store', 'no-cache'] })
    await expect(
      openapiValueAtPointer(
        '#/components/headers/RootCacheControl/description',
      ),
    ).resolves.toContain('npm projection root responses use no-cache')
    await expect(
      openapiValueAtPointer('#/components/schemas/NpmUtilityRoot'),
    ).resolves.toEqual({
      additionalProperties: false,
      description:
        'Empty JSON object returned by npm projection root routes for npm client compatibility.',
      properties: {},
      type: 'object',
    })

    for (const method of ['get', 'head']) {
      await expect(
        openapiValueAtPointer(`#/paths/~1/${method}/tags`),
      ).resolves.toEqual(['Transport', 'npm Projection'])
      await expect(
        openapiValueAtPointer(
          `#/paths/~1/${method}/responses/200/headers/Cache-Control`,
        ),
      ).resolves.toEqual({
        $ref: '#/components/headers/RootCacheControl',
      })
    }

    await expect(
      openapiValueAtPointer(
        '#/paths/~1/get/responses/200/content/application~1json/schema/oneOf',
      ),
    ).resolves.toEqual([
      { $ref: '#/components/schemas/DeploymentInfo' },
      { $ref: '#/components/schemas/NpmUtilityRoot' },
    ])
    await expect(
      openapiValueAtPointer('#/paths/~1/get/responses/200/description'),
    ).resolves.toContain('npm projection hosts')
    await expect(readText('api.md')).resolves.toContain(
      'On core registry hosts, the root route returns deployment information',
    )
    await expect(readText('api.md')).resolves.toContain(
      'selected by host routing',
    )
  })

  it('documents browser favicon probes as transport-only empty responses', async () => {
    await expect(
      openapiValueAtPointer(
        '#/paths/~1favicon.ico/get/responses/204/headers/Cache-Control',
      ),
    ).resolves.toEqual({
      $ref: '#/components/headers/FaviconCacheControl',
    })
    await expect(
      openapiValueAtPointer('#/components/headers/FaviconCacheControl/schema'),
    ).resolves.toEqual({ const: 'public, max-age=86400' })
    await expect(
      openapiValueAtPointer(
        '#/components/headers/FaviconCacheControl/description',
      ),
    ).resolves.toContain('favicon probe')
    await expect(readText('api.md')).resolves.toContain('GET  /favicon.ico')
    await expect(readText('api.md')).resolves.toContain(
      'browser favicon probes',
    )
  })

  it('documents release verification response cache headers and lengths', async () => {
    for (const status of ['200', '422']) {
      await expect(
        openapiValueAtPointer(
          `#/paths/~1packages~1{packageId}~1releases~1{version}~1verification/get/responses/${status}/headers/Cache-Control`,
        ),
      ).resolves.toEqual({
        $ref: '#/components/headers/NoCacheControl',
      })
      await expect(
        openapiValueAtPointer(
          `#/paths/~1packages~1{packageId}~1releases~1{version}~1verification/get/responses/${status}/headers/Content-Length`,
        ),
      ).resolves.toEqual({
        $ref: '#/components/headers/ContentLength',
      })
    }

    await expect(readText('api.md')).resolves.toContain(
      'Returns release verification results',
    )
  })

  it('documents no-cache caching for mutable core reads', async () => {
    await expect(
      openapiValueAtPointer('#/components/headers/NoCacheControl/schema'),
    ).resolves.toEqual({ const: 'no-cache' })
    await expect(
      openapiValueAtPointer('#/components/headers/NoCacheControl/description'),
    ).resolves.toContain('revalidated')

    for (const pointer of [
      '#/paths/~1events/get/responses/200/headers/Cache-Control',
      '#/paths/~1events/head/responses/200/headers/Cache-Control',
      '#/paths/~1objects/get/responses/200/headers/Cache-Control',
      '#/paths/~1objects/head/responses/200/headers/Cache-Control',
      '#/paths/~1packages~1{packageId}/get/responses/200/headers/Cache-Control',
      '#/paths/~1packages~1{packageId}/head/responses/200/headers/Cache-Control',
      '#/paths/~1packages~1{packageId}~1channels~1{channel}/get/responses/200/headers/Cache-Control',
      '#/paths/~1packages~1{packageId}~1channels~1{channel}/head/responses/200/headers/Cache-Control',
    ]) {
      await expect(openapiValueAtPointer(pointer), pointer).resolves.toEqual({
        $ref: '#/components/headers/NoCacheControl',
      })
    }

    for (const pointer of [
      '#/paths/~1events/get/responses/304',
      '#/paths/~1events/head/responses/304',
      '#/paths/~1objects/get/responses/304',
      '#/paths/~1objects/head/responses/304',
      '#/paths/~1packages~1{packageId}/get/responses/304',
      '#/paths/~1packages~1{packageId}/head/responses/304',
      '#/paths/~1packages~1{packageId}~1channels~1{channel}/get/responses/304',
      '#/paths/~1packages~1{packageId}~1channels~1{channel}/head/responses/304',
    ]) {
      await expect(openapiValueAtPointer(pointer), pointer).resolves.toEqual({
        $ref: '#/components/responses/MutableNotModified',
      })
    }

    await expect(
      openapiValueAtPointer('#/components/parameters/IfNoneMatch/description'),
    ).resolves.toContain('Routes with an ETag can return 304')

    for (const path of [
      '/events',
      '/objects',
      '/packages/{packageId}',
      '/packages/{packageId}/channels/{channel}',
    ]) {
      for (const method of ['get', 'head']) {
        await expect(
          openapiValueAtPointer(
            `#/paths/${escapeJsonPointer(path)}/${method}/parameters`,
          ),
        ).resolves.toEqual(
          expect.arrayContaining([
            { $ref: '#/components/parameters/IfNoneMatch' },
          ]),
        )
      }
    }

    await expect(readText('api.md')).resolves.toContain(
      'Package state responses include `Cache-Control: no-cache`.',
    )
    await expect(readText('api.md')).resolves.toContain(
      'Channel reads are mutable projections. They include `Cache-Control: no-cache`',
    )
  })

  it('documents immutable caching for immutable core reads', async () => {
    await expect(
      openapiValueAtPointer(
        '#/components/headers/ImmutableCacheControl/schema',
      ),
    ).resolves.toEqual({
      const: 'public, max-age=31536000, immutable',
    })
    await expect(
      openapiValueAtPointer(
        '#/components/headers/ImmutableCacheControl/description',
      ),
    ).resolves.toContain('cached long-term')
    await expect(
      openapiValueAtPointer(
        '#/components/responses/ImmutableNotModified/headers/Cache-Control',
      ),
    ).resolves.toEqual({
      $ref: '#/components/headers/ImmutableCacheControl',
    })

    for (const pointer of [
      '#/paths/~1events~1{algorithm}~1{hex}/get/responses/200/headers/Cache-Control',
      '#/paths/~1events~1{algorithm}~1{hex}/head/responses/200/headers/Cache-Control',
      '#/paths/~1objects~1{algorithm}~1{hex}/get/responses/200/headers/Cache-Control',
      '#/paths/~1objects~1{algorithm}~1{hex}/head/responses/200/headers/Cache-Control',
      '#/paths/~1objects~1{digest}/get/responses/200/headers/Cache-Control',
      '#/paths/~1objects~1{digest}/head/responses/200/headers/Cache-Control',
      '#/paths/~1packages~1{packageId}~1releases~1{version}/get/responses/200/headers/Cache-Control',
      '#/paths/~1packages~1{packageId}~1releases~1{version}/head/responses/200/headers/Cache-Control',
    ]) {
      await expect(openapiValueAtPointer(pointer), pointer).resolves.toEqual({
        $ref: '#/components/headers/ImmutableCacheControl',
      })
    }

    for (const pointer of [
      '#/paths/~1events~1{algorithm}~1{hex}/get/responses/304',
      '#/paths/~1events~1{algorithm}~1{hex}/head/responses/304',
      '#/paths/~1packages~1{packageId}~1releases~1{version}/get/responses/304',
      '#/paths/~1packages~1{packageId}~1releases~1{version}/head/responses/304',
    ]) {
      await expect(openapiValueAtPointer(pointer), pointer).resolves.toEqual({
        $ref: '#/components/responses/ImmutableNotModified',
      })
    }

    for (const path of [
      '/events/{algorithm}/{hex}',
      '/packages/{packageId}/releases/{version}',
    ]) {
      for (const method of ['get', 'head']) {
        await expect(
          openapiValueAtPointer(
            `#/paths/${escapeJsonPointer(path)}/${method}/parameters`,
          ),
        ).resolves.toEqual(
          expect.arrayContaining([
            { $ref: '#/components/parameters/IfNoneMatch' },
          ]),
        )
      }
    }

    const api = await readText('api.md')
    const normalizedApi = api.replaceAll(/\s+/gu, ' ')

    expect(normalizedApi).toContain('They use long-lived immutable caching')
    expect(api).toContain(
      'individual event reads are immutable public facts with long-lived immutable',
    )
  })

  it('documents byte-range headers for immutable object reads', async () => {
    await expect(
      openapiValueAtPointer('#/components/headers/AcceptRangesBytes/schema'),
    ).resolves.toEqual({ const: 'bytes' })
    await expect(
      openapiValueAtPointer('#/components/headers/ContentRange/description'),
    ).resolves.toContain('416')
    await expect(
      openapiValueAtPointer('#/components/headers/ContentLength/description'),
    ).resolves.toContain('Decimal byte length')
    await expect(
      openapiValueAtPointer('#/components/parameters/Range/description'),
    ).resolves.toContain('Single byte range')
    await expect(
      openapiValueAtPointer(
        '#/components/responses/ObjectRangeNotSatisfiable/headers/Accept-Ranges',
      ),
    ).resolves.toEqual({
      $ref: '#/components/headers/AcceptRangesBytes',
    })
    await expect(
      openapiValueAtPointer(
        '#/components/responses/ObjectRangeNotSatisfiable/headers/Content-Range',
      ),
    ).resolves.toEqual({
      $ref: '#/components/headers/ContentRange',
    })
    await expect(
      openapiValueAtPointer(
        '#/components/responses/ObjectNotModified/headers/Accept-Ranges',
      ),
    ).resolves.toEqual({
      $ref: '#/components/headers/AcceptRangesBytes',
    })

    for (const path of ['/objects/{algorithm}/{hex}', '/objects/{digest}']) {
      for (const method of ['get', 'head']) {
        await expect(
          openapiValueAtPointer(
            `#/paths/${escapeJsonPointer(path)}/${method}/responses/200/headers/Accept-Ranges`,
          ),
        ).resolves.toEqual({
          $ref: '#/components/headers/AcceptRangesBytes',
        })
        await expect(
          openapiValueAtPointer(
            `#/paths/${escapeJsonPointer(path)}/${method}/responses/200/headers/Content-Length`,
          ),
        ).resolves.toEqual({
          $ref: '#/components/headers/ContentLength',
        })
        if (method === 'get') {
          await expect(
            openapiValueAtPointer(
              `#/paths/${escapeJsonPointer(path)}/${method}/responses/200/content/${escapeJsonPointer('*/*')}/schema`,
            ),
          ).resolves.toEqual({
            format: 'binary',
            type: 'string',
          })
        }
        await expect(
          openapiValueAtPointer(
            `#/paths/${escapeJsonPointer(path)}/${method}/responses/304`,
          ),
        ).resolves.toEqual({
          $ref: '#/components/responses/ObjectNotModified',
        })
        await expect(
          openapiValueAtPointer(
            `#/paths/${escapeJsonPointer(path)}/${method}/parameters`,
          ),
        ).resolves.toEqual(
          expect.arrayContaining([
            { $ref: '#/components/parameters/IfNoneMatch' },
            { $ref: '#/components/parameters/Range' },
          ]),
        )
      }

      for (const method of ['get', 'head']) {
        await expect(
          openapiValueAtPointer(
            `#/paths/${escapeJsonPointer(path)}/${method}/responses/206/headers/Accept-Ranges`,
          ),
        ).resolves.toEqual({
          $ref: '#/components/headers/AcceptRangesBytes',
        })
        await expect(
          openapiValueAtPointer(
            `#/paths/${escapeJsonPointer(path)}/${method}/responses/206/headers/Content-Range`,
          ),
        ).resolves.toEqual({
          $ref: '#/components/headers/ContentRange',
        })
        await expect(
          openapiValueAtPointer(
            `#/paths/${escapeJsonPointer(path)}/${method}/responses/206/headers/Content-Length`,
          ),
        ).resolves.toEqual({
          $ref: '#/components/headers/ContentLength',
        })
      }

      for (const method of ['get', 'head']) {
        await expect(
          openapiValueAtPointer(
            `#/paths/${escapeJsonPointer(path)}/${method}/responses/416`,
          ),
        ).resolves.toEqual({
          $ref: '#/components/responses/ObjectRangeNotSatisfiable',
        })
      }
    }

    const api = await readText('api.md')
    expect(api).toContain('Accept-Ranges: bytes')
    expect(api).toContain('`Content-Type` from the object descriptor')
    expect(api).toContain('strong digest-based `ETag`')
    expect(api).toContain('Range requests return `206` with `Content-Range`')
    expect(api).toContain('`416` with `Content-Range: bytes */{size}`')
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
    expect(readinessDescription).toContain(
      'Optional checkpoint store readiness appears when configured',
    )
    expect(api).toContain(
      '`/ready` aggregates independent adapter readiness checks',
    )
    expect(api).toMatch(
      /Checkpoint\s+readiness appears only when a checkpoint store adapter is configured/u,
    )
    expect(api).toMatch(/must\s+not depend on probe ordering/u)
  })

  it('documents transport JSON response lengths', async () => {
    for (const path of ['/', '/health']) {
      for (const method of ['get', 'head']) {
        await expect(
          openapiValueAtPointer(
            `#/paths/${escapeJsonPointer(path)}/${method}/responses/200/headers/Content-Length`,
          ),
        ).resolves.toEqual({
          $ref: '#/components/headers/ContentLength',
        })
      }
    }

    for (const method of ['get', 'head']) {
      for (const status of ['200', '503']) {
        await expect(
          openapiValueAtPointer(
            `#/paths/~1ready/${method}/responses/${status}/headers/Content-Length`,
          ),
        ).resolves.toEqual({
          $ref: '#/components/headers/ContentLength',
        })
      }
    }

    await expect(readText('api.md')).resolves.toContain(
      'include `Content-Length` for the exact JSON response body',
    )
  })

  it('documents deployment statistics as advisory cached status data', async () => {
    await expect(
      openapiValueAtPointer(
        '#/components/schemas/DeploymentInfo/properties/statistics/description',
      ),
    ).resolves.toContain('Advisory deployment statistics')
    await expect(
      openapiValueAtPointer(
        '#/components/schemas/DeploymentInfo/properties/statistics/description',
      ),
    ).resolves.toContain('stale cached statistics')
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
    await expect(readText('api.md')).resolves.toMatch(
      /stale cached\s+statistics/u,
    )
    await expect(readText('api.md')).resolves.toContain(
      'not by replaying events or scanning',
    )
    await expect(readText('operations.md')).resolves.toContain(
      'package count is maintained in',
    )
  })

  it('documents V0 package-state verification as full-log based', async () => {
    const mirroring = await readText('mirroring.md')

    expect(mirroring).toContain(
      '`verify-package` intentionally reads event-log pages until it reaches the tail',
    )
    expect(mirroring).toContain(
      'hash the exact manifest object bytes, including the trailing newline',
    )
    expect(mirroring).toContain(
      'Mutable event-log and object-inventory pages should include',
    )
    expect(mirroring).toMatch(/`Cache-Control:\s+no-cache`/u)
    expect(mirroring).toContain('a page-cursor `ETag`')
    expect(mirroring).toContain(
      'Immutable event and release-envelope reads should include immutable caching',
    )
    expect(mirroring).toContain('`Content-Length` for the exact canonical JSON')
    expect(mirroring).toContain(
      'The V0 CLI verifier treats those metadata checks as part of public',
    )
    expect(mirroring).toContain(
      'should fail verification instead of being accepted as weak evidence',
    )
    expect(mirroring).toContain('proofs are future protocol work')
  })

  it('documents operational request and audit logging boundaries', async () => {
    const operations = await readText('operations.md')

    expect(operations).toContain('## Operational Logs')
    expect(operations).toContain('`regesta.request`')
    expect(operations).toContain('`regesta.core-audit`')
    expect(operations).toContain(
      '`regesta.deployment-statistics-refresh-failure`',
    )
    expect(operations).toMatch(/served a stale\s+cached value/u)
    expect(operations).toContain('excludes query strings')
    expect(operations).toContain('outside the request critical path')
    expect(operations).toContain('not public protocol objects')
    expect(operations).toMatch(/append-only\s+event log/u)
  })

  it('documents current hot-path scalability boundaries', async () => {
    const operations = await readText('operations.md')

    expect(operations).toContain('## Hot Path Cost Boundaries')
    expect(operations).toContain('health reads do not touch storage')
    expect(operations).toContain(
      'readiness reads call cheap, bounded adapter probes',
    )
    expect(operations).toContain(
      'root deployment statistics are cached and served from adapter counters or',
    )
    expect(operations).toContain(
      'root deployment info does not run readiness probes',
    )
    expect(operations).toContain('serves the stale cached statistics')
    expect(operations).toContain('schema-invalid statistics still fail closed')
    expect(operations).toContain(
      'core package-state reads use adapter-owned event indexes',
    )
    expect(operations).toContain(
      'domain well-known binding discovery for write authorization is bounded',
    )
    expect(operations).toContain(
      'event and object collection reads rely on adapter-owned cursor validation',
    )
    expect(operations).toContain(
      'npm tarball routes redirect to the canonical object or upstream URL',
    )
    expect(operations).toContain('`REGESTA_NPM_UPSTREAM_TIMEOUT_MS`')
    expect(operations).toMatch(/outside the committed\s+write path/u)
    expect(operations).toContain('not protocol guarantees')
    expect(operations).toContain('newline-delimited JSON entries')
    expect(operations).toContain('`topic`, `payload`,')
    expect(operations).toContain('`enqueuedAt` operational metadata')
  })

  it('documents architecture read-flow cost boundaries', async () => {
    const architecture = await readText('architecture.md')

    expect(architecture).toContain('## Read Flow')
    expect(architecture).toContain(
      'Performance-sensitive mutable reads should be backed by adapter-owned indexes',
    )
    expect(architecture).toMatch(
      /Package state reads\s+use event-derived state indexes/u,
    )
    expect(architecture).toContain(
      'deployment statistics use advisory counters',
    )
    expect(architecture).toContain(
      'paginated event or object collection reads let the storage adapter validate',
    )
    expect(architecture).toMatch(
      /HTTP routes should not add separate\s+cursor preflight reads/u,
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
