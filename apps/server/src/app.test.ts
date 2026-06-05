import { generateKeyPairSync } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { createMemoryRegistryAdapters } from '@regesta/adapters'
import {
  createReleasePublishIntent,
  createWriteAuthorization,
  type DomainBinding,
  type Ed25519PrivateKeyJwk,
  type Ed25519PublicKeyJwk,
  type WriteIntent,
} from '@regesta/auth'
import { configDigest, publishRelease } from '@regesta/core'
import { prepareNpmPublish } from '@regesta/npm'
import { parsePackageId, sha256, type RegestaConfig } from '@regesta/protocol'
import { describe, expect, it, vi } from 'vitest'
import { createRegestaApp } from './app.ts'
import {
  devLocalhostDomainBinding,
  devLocalhostKeyId,
  devLocalhostPrivateKeyFile,
} from './dev-keys.ts'

describe('createRegestaApp', () => {
  it('handles browser favicon requests outside package routes', async () => {
    const app = createRegestaApp(createMemoryRegistryAdapters())
    const response = await app.request('/favicon.ico')

    expect(response.status).toBe(204)
    expect(response.headers.get('cache-control')).toBe('public, max-age=86400')
    expect(await response.text()).toBe('')
  })

  it('serves fixed dev.localhost key material for local debugging', async () => {
    const app = createRegestaApp(createMemoryRegistryAdapters())
    const binding = await app.request(
      'http://dev.localhost/.well-known/regesta.json',
    )
    const privateKey = await app.request(
      'http://dev.localhost/regesta.private-key.json',
    )

    expect(binding.status).toBe(200)
    await expect(binding.json()).resolves.toEqual(devLocalhostDomainBinding)
    expect(privateKey.status).toBe(200)
    await expect(privateKey.json()).resolves.toMatchObject({
      kid: devLocalhostKeyId,
      privateKeyJwk: {
        crv: 'Ed25519',
        d: devLocalhostPrivateKeyFile.privateKeyJwk.d,
        kty: 'OKP',
      },
    })
  })

  it('returns 400 for invalid object digest requests', async () => {
    const app = createRegestaApp(createMemoryRegistryAdapters())
    const response = await app.request('/api/v0/objects/not-a-digest')

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      error: 'Invalid object digest',
    })
  })

  it('returns 400 for invalid publish multipart JSON', async () => {
    const app = createRegestaApp(createMemoryRegistryAdapters())
    const form = new FormData()
    form.set('config', '{')
    form.set('artifacts', '[]')
    form.set('source', new File(['source'], 'source.tgz'))
    const response = await app.request('/api/v0/releases', {
      body: form,
      method: 'POST',
    })

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      error: 'Invalid config JSON',
    })
  })

  it('returns 400 for invalid channel request bodies', async () => {
    const app = createRegestaApp(createMemoryRegistryAdapters())
    const packageId = encodeURIComponent('npm:example.com/hello-regesta')
    const response = await app.request(
      `/api/v0/packages/${packageId}/channels/latest`,
      {
        body: JSON.stringify({}),
        headers: {
          'content-type': 'application/json',
        },
        method: 'PUT',
      },
    )

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      error: 'Invalid channel request body',
    })
  })

  it('treats encoded package ids as one route segment', async () => {
    const app = createRegestaApp(createMemoryRegistryAdapters())
    const packageId = encodeURIComponent('go:some.dev/releases/pkg')
    const response = await app.request(`/api/v0/packages/${packageId}`)

    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toMatchObject({
      error: 'Package not found',
    })
  })

  it('reads package releases through channels', async () => {
    const adapters = createMemoryRegistryAdapters()
    const app = createRegestaApp(adapters)
    const packageId = 'npm:example.com/hello-regesta'

    await publishRelease(
      {
        artifacts: [
          {
            bytes: bytes('install artifact'),
            format: 'npm-tarball',
            mediaType: 'application/gzip',
            role: 'install',
          },
        ],
        config: {
          id: packageId,
          source: {
            include: ['regesta.json'],
          },
          version: '0.0.1',
        },
        createdAt: '2026-06-01T00:00:00.000Z',
        source: bytes('source archive'),
      },
      adapters,
    )

    const response = await app.request(
      `/api/v0/packages/${encodeURIComponent(packageId)}/channels/latest`,
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      manifest: {
        id: packageId,
        version: '0.0.1',
      },
    })
  })

  it('returns 404 for missing package channels', async () => {
    const app = createRegestaApp(createMemoryRegistryAdapters())
    const packageId = encodeURIComponent('npm:example.com/hello-regesta')
    const response = await app.request(
      `/api/v0/packages/${packageId}/channels/beta`,
    )

    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toMatchObject({
      error: 'Channel not found',
    })
  })

  it('accepts dev.localhost write signatures through the built-in dev binding', async () => {
    const app = createRegestaApp(createMemoryRegistryAdapters())
    const packageId = parsePackageId('demo:dev.localhost/hello-regesta').id
    const artifactBytes = bytes('install artifact')
    const sourceBytes = bytes('source archive')
    const config: RegestaConfig = {
      id: packageId,
      provenance: {
        level: 'source-attached',
      },
      source: {
        include: ['regesta.json'],
      },
      version: '0.0.1',
    }
    const form = new FormData()

    form.set('config', JSON.stringify(config))
    form.set(
      'authorization',
      JSON.stringify(
        createWriteAuthorization(
          createReleasePublishIntent({
            artifactDigests: [sha256(artifactBytes)],
            configDigest: configDigest(config),
            nonce: 'dev-localhost-nonce',
            packageId,
            sourceDigest: sha256(sourceBytes),
            timestamp: new Date().toISOString(),
            version: config.version,
          }),
          devLocalhostPrivateKeyFile,
        ),
      ),
    )
    form.set('source', new File([blobPart(sourceBytes)], 'source.tgz'))
    form.set(
      'artifacts',
      JSON.stringify([
        {
          format: 'demo',
          mediaType: 'application/octet-stream',
          part: 'artifact.install',
          role: 'install',
        },
      ]),
    )
    form.set(
      'artifact.install',
      new File([blobPart(artifactBytes)], 'artifact.bin', {
        type: 'application/octet-stream',
      }),
    )

    const response = await app.request('/api/v0/releases', {
      body: form,
      method: 'POST',
    })

    expect(response.status).toBe(201)
    await expect(response.json()).resolves.toMatchObject({
      manifest: {
        id: packageId,
      },
    })
  })

  it('serves npm projection APIs on npm subdomains', async () => {
    const adapters = createMemoryRegistryAdapters()
    const app = createRegestaApp(adapters)
    const prepared = await prepareNpmPublish(await createFixtureProject())
    const installArtifact = prepared.artifacts[0]
    const auth = createTestDomainAuth()

    if (!installArtifact) {
      throw new Error('Fixture publish did not produce an install artifact')
    }

    const publishForm = new FormData()
    publishForm.set('config', JSON.stringify(prepared.config))
    publishForm.set(
      'authorization',
      JSON.stringify(
        auth.sign(
          createReleasePublishIntent({
            artifactDigests: prepared.artifacts.map((artifact) =>
              sha256(artifact.bytes),
            ),
            configDigest: configDigest(prepared.config),
            nonce: 'release-nonce',
            packageId: prepared.config.id,
            sourceDigest: sha256(prepared.source),
            timestamp: new Date().toISOString(),
            version: prepared.config.version,
          }),
        ),
      ),
    )
    publishForm.set('createdAt', '2026-06-01T00:00:00.000Z')
    publishForm.set(
      'source',
      new File([blobPart(prepared.source)], 'source.tgz'),
    )
    publishForm.set(
      'artifacts',
      JSON.stringify([
        {
          filename: installArtifact.filename,
          format: installArtifact.format,
          mediaType: installArtifact.mediaType,
          part: 'artifact.install',
          role: installArtifact.role,
        },
      ]),
    )
    publishForm.set(
      'artifact.install',
      new File(
        [blobPart(installArtifact.bytes)],
        installArtifact.filename ?? 'pkg.tgz',
        {
          type: installArtifact.mediaType,
        },
      ),
    )

    vi.stubGlobal('fetch', auth.fetch)

    try {
      const publish = await app.request('/api/v0/releases', {
        body: publishForm,
        method: 'POST',
      })

      expect(publish.status).toBe(201)
      await expect(publish.json()).resolves.toMatchObject({
        channel: 'latest',
      })
    } finally {
      vi.unstubAllGlobals()
    }

    const rootHostPackument = await app.request(
      'http://registry.test/npm/@example.com/hello-regesta',
    )

    expect(rootHostPackument.status).toBe(404)

    const rootHostTarball = await app.request(
      'http://registry.test/npm/@example.com/hello-regesta/-/hello-regesta-0.0.1.tgz',
    )

    expect(rootHostTarball.status).toBe(404)

    const subdomainPackument = await app.request(
      'http://npm.registry.test/@example.com/hello-regesta',
    )

    expect(subdomainPackument.status).toBe(200)
    await expect(subdomainPackument.json()).resolves.toMatchObject({
      'dist-tags': {
        latest: '0.0.1',
      },
      name: '@example.com/hello-regesta',
      time: {
        '0.0.1': '2026-06-01T00:00:00.000Z',
        created: '2026-06-01T00:00:00.000Z',
        modified: '2026-06-01T00:00:00.000Z',
      },
      versions: {
        '0.0.1': {
          dependencies: {
            '@example.com/base': '^1.0.0',
          },
          dist: {
            tarball:
              'http://npm.registry.test/@example.com/hello-regesta/-/hello-regesta-0.0.1.tgz',
          },
        },
      },
    })

    const subdomainTarball = await app.request(
      'http://npm.registry.test/@example.com/hello-regesta/-/hello-regesta-0.0.1.tgz',
    )

    expect(subdomainTarball.status).toBe(200)
    const tarballBytes = new Uint8Array(await subdomainTarball.arrayBuffer())
    expect(tarballBytes).toEqual(new Uint8Array(installArtifact.bytes))
    expect(tarballBytes).not.toEqual(new Uint8Array(prepared.source))

    const rootPathOnMainHost = await app.request(
      'http://registry.test/@example.com/hello-regesta',
    )

    expect(rootPathOnMainHost.status).toBe(404)
  })

  it('falls back to npmjs packuments without proxying tarballs', async () => {
    const app = createRegestaApp(createMemoryRegistryAdapters())
    const fetchCalls: string[] = []
    const fetchMock: typeof fetch = (input) => {
      fetchCalls.push(String(input))

      return Promise.resolve(
        Response.json({
          'dist-tags': {
            latest: '1.0.0',
          },
          name: '@upstream/pkg',
          versions: {
            '1.0.0': {
              dist: {
                tarball:
                  'https://registry.npmjs.org/@upstream/pkg/-/pkg-1.0.0.tgz',
              },
              name: '@upstream/pkg',
              version: '1.0.0',
            },
          },
        }),
      )
    }

    vi.stubGlobal('fetch', fetchMock)

    try {
      const packument = await app.request(
        'http://npm.registry.test/@upstream/pkg',
      )

      expect(packument.status).toBe(200)
      expect(fetchCalls).toEqual([
        'https://registry.npmjs.org/%40upstream%2Fpkg',
      ])
      await expect(packument.json()).resolves.toMatchObject({
        name: '@upstream/pkg',
        versions: {
          '1.0.0': {
            dist: {
              tarball:
                'https://registry.npmjs.org/@upstream/pkg/-/pkg-1.0.0.tgz',
            },
          },
        },
      })

      const tarball = await app.request(
        'http://npm.registry.test/@upstream/pkg/-/pkg-1.0.0.tgz',
      )

      expect(tarball.status).toBe(404)
      expect(fetchCalls).toHaveLength(1)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

function blobPart(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const part = new Uint8Array(bytes.byteLength)
  part.set(bytes)
  return part
}

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value)
}

function createTestDomainAuth(): {
  binding: DomainBinding
  fetch: typeof fetch
  sign: (intent: WriteIntent) => ReturnType<typeof createWriteAuthorization>
} {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const privateKeyJwk = normalizePrivateKeyJwk(
    privateKey.export({ format: 'jwk' }),
  )
  const publicKeyJwk = normalizePublicKeyJwk(
    publicKey.export({ format: 'jwk' }),
  )
  const binding: DomainBinding = {
    domain: 'example.com',
    keys: [
      {
        alg: 'EdDSA',
        kid: 'ed25519:test',
        publicKeyJwk,
        use: 'regesta-write',
      },
    ],
    object: 'regesta.domain-binding',
    specVersion: 0,
  }

  return {
    binding,
    fetch: (input) => {
      if (String(input) !== 'https://example.com/.well-known/regesta.json') {
        return Promise.resolve(new Response(null, { status: 404 }))
      }

      return Promise.resolve(Response.json(binding))
    },
    sign: (intent) =>
      createWriteAuthorization(intent, {
        kid: 'ed25519:test',
        privateKeyJwk,
      }),
  }
}

function normalizePrivateKeyJwk(value: unknown): Ed25519PrivateKeyJwk {
  if (!isRecord(value)) {
    throw new Error('private key JWK must be an object')
  }

  if (
    value.kty !== 'OKP' ||
    value.crv !== 'Ed25519' ||
    typeof value.x !== 'string' ||
    typeof value.d !== 'string'
  ) {
    throw new Error('private key JWK must be Ed25519')
  }

  return {
    crv: value.crv,
    d: value.d,
    kty: value.kty,
    x: value.x,
  }
}

function normalizePublicKeyJwk(value: unknown): Ed25519PublicKeyJwk {
  if (!isRecord(value)) {
    throw new Error('public key JWK must be an object')
  }

  if (
    value.kty !== 'OKP' ||
    value.crv !== 'Ed25519' ||
    typeof value.x !== 'string'
  ) {
    throw new Error('public key JWK must be Ed25519')
  }

  return {
    crv: value.crv,
    kty: value.kty,
    x: value.x,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

async function createFixtureProject(): Promise<string> {
  const root = join(
    process.cwd(),
    'node_modules',
    '.tmp-regesta-server-test',
    `${Date.now()}-${Math.random().toString(16).slice(2)}`,
  )
  await mkdir(join(root, 'src'), { recursive: true })
  await writeFile(join(root, 'src', 'index.ts'), 'export const value = 1\n')
  await writeFile(
    join(root, 'package.json'),
    `${JSON.stringify(
      {
        dependencies: {
          '@example.com/base': '^1.0.0',
        },
        exports: {
          '.': './src/index.ts',
        },
        name: '@example.com/hello-regesta',
        packageManager: 'npm@11.5.0',
        version: '0.0.1',
      },
      null,
      2,
    )}\n`,
  )
  await writeFile(
    join(root, 'regesta.json'),
    `{
      id: 'npm:example.com/hello-regesta',
      provenance: {
        level: 'source-attached',
      },
      source: {
        include: ['regesta.json', 'package.json', 'src'],
      },
    }\n`,
  )

  return root
}
