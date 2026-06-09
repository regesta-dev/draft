import { Buffer } from 'node:buffer'
import { execFile } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { createServer, type IncomingHttpHeaders } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'
import { gzipSync } from 'node:zlib'
import {
  createLocalRegistryAdapters,
  createMemoryRegistryAdapters,
} from '@regesta/adapters'
import {
  createChannelUpdateIntent,
  createReleasePublishIntent,
  createWriteAuthorization,
  releasePublishArtifactDescriptorDigest,
  type DomainBinding,
  type Ed25519PrivateKeyJwk,
  type Ed25519PublicKeyJwk,
  type WriteIntent,
} from '@regesta/auth'
import {
  configDigest,
  normalizeRegestaConfig,
  PackageChannelConflictError,
  publishRelease,
  RegistryEventAlreadyExistsError,
  updatePackageChannel,
} from '@regesta/core'
import { parsePackageId, sha256, type RegestaConfig } from '@regesta/protocol'
import { describe, expect, it, vi } from 'vitest'
import { createRegestaApp } from './app.ts'
import {
  devLocalhostDomainBinding,
  devLocalhostKeyId,
  devLocalhostPrivateKeyFile,
} from './dev/keys.ts'
import type { CoreRegistryAuditEntry } from './core/app.ts'

const execFileAsync = promisify(execFile)

describe('createRegestaApp', () => {
  it('serves deployment info at the root path', async () => {
    const app = createRegestaApp(createMemoryRegistryAdapters())
    const response = await app.request('/')
    const head = await app.request('/', {
      method: 'HEAD',
    })
    const health = await app.request('/health')
    const healthHead = await app.request('/health', {
      method: 'HEAD',
    })
    const ready = await app.request('/ready')
    const readyHead = await app.request('/ready', {
      method: 'HEAD',
    })

    expect(response.status).toBe(200)
    expect(response.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/u)
    await expect(response.json()).resolves.toMatchObject({
      api: {
        version: 'v0',
      },
      build: {
        time: '2026-06-08T00:00:00.000Z',
      },
      git: {
        dirty: false,
        sha: 'test-git-sha',
      },
      object: 'regesta.deployment-info',
      runtime: {
        name: 'node',
        version: process.versions.node,
      },
      service: '@regesta/server',
      version: '0.0.0',
    })
    expect(head.status).toBe(200)
    expect(head.headers.get('content-type')).toBe(
      'application/json; charset=UTF-8',
    )
    expect(await head.text()).toBe('')
    expect(health.status).toBe(200)
    expect(health.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/u)
    await expect(health.json()).resolves.toEqual({ ok: true })
    expect(healthHead.status).toBe(200)
    expect(healthHead.headers.get('content-type')).toBe(
      'application/json; charset=UTF-8',
    )
    expect(await healthHead.text()).toBe('')
    expect(ready.status).toBe(200)
    expect(ready.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/u)
    expect(ready.headers.get('cache-control')).toBe('no-store')
    await expect(ready.json()).resolves.toEqual({
      checks: {
        database: true,
        objects: true,
        queue: true,
        signer: true,
      },
      kind: 'regesta.readiness',
      ok: true,
    })
    expect(readyHead.status).toBe(200)
    expect(readyHead.headers.get('cache-control')).toBe('no-store')
    expect(readyHead.headers.get('content-type')).toBe(
      'application/json; charset=UTF-8',
    )
    expect(await readyHead.text()).toBe('')
  })

  it('returns 503 when persistent storage is not ready', async () => {
    const adapters = createMemoryRegistryAdapters()
    adapters.database.checkReadiness = () => {
      throw new Error('database unavailable')
    }
    const app = createRegestaApp(adapters)

    const ready = await app.request('/ready')
    const readyHead = await app.request('/ready', {
      method: 'HEAD',
    })

    expect(ready.status).toBe(503)
    expect(ready.headers.get('cache-control')).toBe('no-store')
    await expect(ready.json()).resolves.toEqual({
      checks: {
        database: false,
        objects: true,
        queue: true,
        signer: true,
      },
      kind: 'regesta.readiness',
      ok: false,
    })
    expect(readyHead.status).toBe(503)
    expect(readyHead.headers.get('cache-control')).toBe('no-store')
    expect(await readyHead.text()).toBe('')
  })

  it('checks database readiness without scanning the event log', async () => {
    const adapters = createMemoryRegistryAdapters()
    adapters.database.listEvents = () => {
      throw new Error('readiness should use database readiness probe')
    }
    const app = createRegestaApp(adapters)

    const ready = await app.request('/ready')

    expect(ready.status).toBe(200)
    await expect(ready.json()).resolves.toEqual({
      checks: {
        database: true,
        objects: true,
        queue: true,
        signer: true,
      },
      kind: 'regesta.readiness',
      ok: true,
    })
  })

  it('returns 503 when object storage is not ready', async () => {
    const adapters = createMemoryRegistryAdapters()
    adapters.objects.checkReadiness = () => {
      throw new Error('object storage unavailable')
    }
    const app = createRegestaApp(adapters)

    const ready = await app.request('/ready')
    const readyHead = await app.request('/ready', {
      method: 'HEAD',
    })

    expect(ready.status).toBe(503)
    expect(ready.headers.get('cache-control')).toBe('no-store')
    await expect(ready.json()).resolves.toEqual({
      checks: {
        database: true,
        objects: false,
        queue: true,
        signer: true,
      },
      kind: 'regesta.readiness',
      ok: false,
    })
    expect(readyHead.status).toBe(503)
    expect(readyHead.headers.get('cache-control')).toBe('no-store')
    expect(await readyHead.text()).toBe('')
  })

  it('returns 503 when queue storage is not ready', async () => {
    const adapters = createMemoryRegistryAdapters()
    adapters.queue.checkReadiness = () => {
      throw new Error('queue unavailable')
    }
    const app = createRegestaApp(adapters)

    const ready = await app.request('/ready')
    const readyHead = await app.request('/ready', {
      method: 'HEAD',
    })

    expect(ready.status).toBe(503)
    expect(ready.headers.get('cache-control')).toBe('no-store')
    await expect(ready.json()).resolves.toEqual({
      checks: {
        database: true,
        objects: true,
        queue: false,
        signer: true,
      },
      kind: 'regesta.readiness',
      ok: false,
    })
    expect(readyHead.status).toBe(503)
    expect(readyHead.headers.get('cache-control')).toBe('no-store')
    expect(await readyHead.text()).toBe('')
  })

  it('returns 503 when signer service is not ready', async () => {
    const adapters = createMemoryRegistryAdapters()
    adapters.signer.checkReadiness = () => {
      throw new Error('signer unavailable')
    }
    const app = createRegestaApp(adapters)

    const ready = await app.request('/ready')
    const readyHead = await app.request('/ready', {
      method: 'HEAD',
    })

    expect(ready.status).toBe(503)
    expect(ready.headers.get('cache-control')).toBe('no-store')
    await expect(ready.json()).resolves.toEqual({
      checks: {
        database: true,
        objects: true,
        queue: true,
        signer: false,
      },
      kind: 'regesta.readiness',
      ok: false,
    })
    expect(readyHead.status).toBe(503)
    expect(readyHead.headers.get('cache-control')).toBe('no-store')
    expect(await readyHead.text()).toBe('')
  })

  it('keeps future ecosystem projection hosts out of core routes', async () => {
    const app = createRegestaApp(createMemoryRegistryAdapters())

    for (const host of [
      'cargo.registry.test',
      'go.registry.test',
      'oci.registry.test',
      'pypi.registry.test',
    ]) {
      const response = await app.request(`http://${host}/`)

      expect(response.status).toBe(404)
    }
  })

  it('supports CORS for arbitrary origins and hosts', async () => {
    const app = createRegestaApp(createMemoryRegistryAdapters())
    const response = await app.request('http://any.registry.test/', {
      headers: {
        origin: 'https://client.example',
      },
    })

    expect(response.status).toBe(200)
    expect(response.headers.get('access-control-allow-origin')).toBe('*')

    const preflight = await app.request(
      'http://random.registry.test/api/v0/releases',
      {
        headers: {
          'access-control-request-headers': 'content-type,x-regesta-test',
          'access-control-request-method': 'POST',
          origin: 'https://another-client.example',
        },
        method: 'OPTIONS',
      },
    )

    expect(preflight.status).toBe(204)
    expect(preflight.headers.get('access-control-allow-origin')).toBe('*')
    expect(preflight.headers.get('access-control-allow-methods')).toContain(
      'POST',
    )
    expect(preflight.headers.get('access-control-allow-methods')).toContain(
      'OPTIONS',
    )
    expect(preflight.headers.get('access-control-allow-headers')).toBe(
      'content-type,x-regesta-test',
    )
  })

  it('logs requests at the transport layer when configured', async () => {
    const entries: Array<{
      durationMs: number
      host: string
      kind: 'regesta.request'
      method: string
      path: string
      requestId: string
      status: number
    }> = []
    const app = createRegestaApp(createMemoryRegistryAdapters(), {
      requestLog: (entry) => {
        entries.push(entry)
      },
    })

    const response = await app.request('http://registry.test/health', {
      headers: {
        'x-request-id': 'health-check-001',
      },
    })

    expect(response.status).toBe(200)
    expect(response.headers.get('x-request-id')).toBe('health-check-001')
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      host: 'registry.test',
      kind: 'regesta.request',
      method: 'GET',
      path: '/health',
      requestId: 'health-check-001',
      status: 200,
    })
    expect(entries[0]!.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('logs accepted publish events to the operator audit sink when configured', async () => {
    const entries: CoreRegistryAuditEntry[] = []
    const app = createRegestaApp(createMemoryRegistryAdapters(), {
      auditLog: (entry) => {
        entries.push(entry)
      },
    })
    const auth = createTestDomainAuth()
    const timestamp = new Date().toISOString()
    const source = bytes('source archive')
    const artifacts = [
      {
        bytes: bytes('install artifact'),
        format: 'generic-archive',
        mediaType: 'application/gzip',
        role: 'install',
      },
    ]
    const config: RegestaConfig = {
      id: 'demo:example.com/audit-regesta',
      provenance: {
        level: 'source-attached',
      },
      source: {
        include: ['regesta.json'],
      },
      version: '0.0.1',
    }
    const normalizedConfig = normalizeRegestaConfig(config)
    const form = new FormData()

    form.set('config', JSON.stringify(config))
    form.set(
      'authorization',
      JSON.stringify(
        auth.sign(
          createReleasePublishIntent({
            artifactDescriptorDigest:
              publishArtifactDescriptorDigest(artifacts),
            artifactDigests: artifacts.map((artifact) =>
              sha256(artifact.bytes),
            ),
            configDigest: configDigest(normalizedConfig),
            nonce: 'publish-audit-nonce',
            packageId: normalizedConfig.id,
            sourceDigest: sha256(source),
            timestamp,
            version: normalizedConfig.version,
          }),
        ),
      ),
    )
    form.set('createdAt', timestamp)
    form.set('source', new File([blobPart(source)], 'source.tgz'))
    form.set(
      'artifacts',
      JSON.stringify([
        {
          format: 'generic-archive',
          mediaType: 'application/gzip',
          part: 'artifact.install',
          role: 'install',
        },
      ]),
    )
    form.set(
      'artifact.install',
      new File([blobPart(artifacts[0]!.bytes)], 'install.tgz', {
        type: 'application/gzip',
      }),
    )

    vi.stubGlobal('fetch', auth.fetch)

    try {
      const response = await app.request('/api/v0/releases', {
        body: form,
        headers: {
          'x-request-id': 'publish-audit-001',
        },
        method: 'POST',
      })

      expect(response.status).toBe(201)
      expect(entries).toHaveLength(1)
      const entry = entries[0]!
      expect(entry).toMatchObject({
        action: 'release.publish',
        channel: 'latest',
        eventType: 'release.published',
        kind: 'regesta.core-audit',
        outcome: 'accepted',
        package: normalizedConfig.id,
        requestId: 'publish-audit-001',
        timestamp,
        version: normalizedConfig.version,
      })
      if (entry.outcome !== 'accepted') {
        throw new Error('Expected accepted audit entry')
      }
      expect(entry.eventId).toMatch(/^sha256:[a-f0-9]{64}$/u)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('logs accepted channel update events to the operator audit sink when configured', async () => {
    const entries: CoreRegistryAuditEntry[] = []
    const adapters = createMemoryRegistryAdapters()
    const app = createRegestaApp(adapters, {
      auditLog: (entry) => {
        entries.push(entry)
      },
    })
    const auth = createTestDomainAuth()
    const packageId = 'npm:example.com/channel-audit'
    const timestamp = new Date().toISOString()

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

    vi.stubGlobal('fetch', auth.fetch)

    try {
      const response = await app.request(
        `/api/v0/packages/${encodeURIComponent(packageId)}/channels/latest`,
        {
          body: JSON.stringify({
            authorization: auth.sign(
              createChannelUpdateIntent({
                channel: 'latest',
                nonce: 'channel-audit-nonce',
                packageId,
                previousVersion: '0.0.1',
                timestamp,
                version: '0.0.1',
              }),
            ),
            version: '0.0.1',
          }),
          headers: {
            'content-type': 'application/json',
            'x-request-id': 'channel-audit-001',
          },
          method: 'PUT',
        },
      )

      expect(response.status).toBe(200)
      expect(entries).toHaveLength(1)
      const entry = entries[0]!
      expect(entry).toMatchObject({
        action: 'channel.update',
        channel: 'latest',
        eventType: 'channel.updated',
        kind: 'regesta.core-audit',
        outcome: 'accepted',
        package: packageId,
        previousVersion: '0.0.1',
        requestId: 'channel-audit-001',
        timestamp,
        version: '0.0.1',
      })
      if (entry.outcome !== 'accepted') {
        throw new Error('Expected accepted audit entry')
      }
      expect(entry.eventId).toMatch(/^sha256:[a-f0-9]{64}$/u)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('logs rejected signed channel write attempts to the operator audit sink when configured', async () => {
    const entries: CoreRegistryAuditEntry[] = []
    const adapters = createMemoryRegistryAdapters()
    const app = createRegestaApp(adapters, {
      auditLog: (entry) => {
        entries.push(entry)
      },
    })
    const auth = createTestDomainAuth()
    const packageId = 'npm:example.com/channel-reject-audit'
    const timestamp = new Date().toISOString()

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
      {
        body: JSON.stringify({
          authorization: auth.sign(
            createChannelUpdateIntent({
              channel: 'latest',
              nonce: 'channel-reject-audit-nonce',
              packageId,
              previousVersion: '0.0.1',
              timestamp,
              version: '0.0.2',
            }),
          ),
          version: '0.0.1',
        }),
        headers: {
          'content-type': 'application/json',
          'x-request-id': 'channel-reject-audit-001',
        },
        method: 'PUT',
      },
    )

    expect(response.status).toBe(401)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      action: 'channel.update',
      channel: 'latest',
      kind: 'regesta.core-audit',
      outcome: 'rejected',
      package: packageId,
      previousVersion: '0.0.1',
      reason: 'Write authorization payload mismatch',
      requestId: 'channel-reject-audit-001',
      version: '0.0.1',
    })
    expect(entries[0]).toHaveProperty('observedAt')
  })

  it('rejects oversized requests before route handlers parse the body', async () => {
    const entries: Array<{
      requestId: string
      status: number
    }> = []
    const app = createRegestaApp(createMemoryRegistryAdapters(), {
      requestLog: (entry) => {
        entries.push({
          requestId: entry.requestId,
          status: entry.status,
        })
      },
      requestSizeLimit: {
        maxBytes: 5,
      },
    })

    const response = await app.request('http://registry.test/api/v0/releases', {
      body: 'upload',
      headers: {
        'content-length': '6',
        origin: 'https://client.example',
        'x-request-id': 'oversized-publish-001',
      },
      method: 'POST',
    })

    expect(response.status).toBe(413)
    expect(response.headers.get('access-control-allow-origin')).toBe('*')
    expect(response.headers.get('x-request-id')).toBe('oversized-publish-001')
    await expect(response.json()).resolves.toMatchObject({
      code: 'request_too_large',
      error: 'Request body too large',
      message: 'Request body too large',
    })
    expect(entries).toEqual([
      {
        requestId: 'oversized-publish-001',
        status: 413,
      },
    ])
  })

  it('normalizes trailing slashes at the transport layer', async () => {
    const app = createRegestaApp(createMemoryRegistryAdapters())
    const response = await app.request('/health/')

    expect(response.status).toBe(301)
    expect(new URL(response.headers.get('location')!).pathname).toBe('/health')
  })

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

  it('supports object HEAD requests without downloading bytes', async () => {
    const adapters = createMemoryRegistryAdapters()
    const app = createRegestaApp(adapters)
    const descriptor = await adapters.objects.put(
      bytes('object bytes'),
      'application/octet-stream',
    )
    const [algorithm, hex] = descriptor.digest.split(':')
    const digestGet = await app.request(`/api/v0/objects/${descriptor.digest}`)

    const digestHead = await app.request(
      `/api/v0/objects/${descriptor.digest}`,
      {
        method: 'HEAD',
      },
    )
    const partsHead = await app.request(`/api/v0/objects/${algorithm}/${hex}`, {
      method: 'HEAD',
    })
    const conditionalGet = await app.request(
      `/api/v0/objects/${descriptor.digest}`,
      {
        headers: {
          'if-none-match': `W/"${descriptor.digest}"`,
        },
      },
    )
    const conditionalHead = await app.request(
      `/api/v0/objects/${descriptor.digest}`,
      {
        headers: {
          'if-none-match': `"${descriptor.digest}"`,
        },
        method: 'HEAD',
      },
    )
    const rangeGet = await app.request(`/api/v0/objects/${descriptor.digest}`, {
      headers: {
        range: 'bytes=0-5',
      },
    })
    const invalidRange = await app.request(
      `/api/v0/objects/${descriptor.digest}`,
      {
        headers: {
          range: 'bytes=100-200',
        },
      },
    )

    expect(digestGet.status).toBe(200)
    expect(digestGet.headers.get('accept-ranges')).toBe('bytes')
    expect(digestGet.headers.get('content-length')).toBe(
      String(descriptor.size),
    )
    expect(digestGet.headers.get('content-type')).toBe(descriptor.mediaType)
    expect(digestGet.headers.get('cache-control')).toBe(
      'public, max-age=31536000, immutable',
    )
    expect(digestGet.headers.get('etag')).toBe(`"${descriptor.digest}"`)
    expect(await digestGet.text()).toBe('object bytes')
    expect(digestHead.status).toBe(200)
    expect(digestHead.headers.get('content-length')).toBe(
      String(descriptor.size),
    )
    expect(digestHead.headers.get('content-type')).toBe(descriptor.mediaType)
    expect(digestHead.headers.get('cache-control')).toBe(
      'public, max-age=31536000, immutable',
    )
    expect(digestHead.headers.get('etag')).toBe(`"${descriptor.digest}"`)
    expect(await digestHead.text()).toBe('')
    expect(partsHead.status).toBe(200)
    expect(partsHead.headers.get('content-length')).toBe(
      String(descriptor.size),
    )
    expect(partsHead.headers.get('content-type')).toBe(descriptor.mediaType)
    expect(partsHead.headers.get('cache-control')).toBe(
      'public, max-age=31536000, immutable',
    )
    expect(partsHead.headers.get('etag')).toBe(`"${descriptor.digest}"`)
    expect(await partsHead.text()).toBe('')
    expect(conditionalGet.status).toBe(304)
    expect(conditionalGet.headers.get('cache-control')).toBe(
      'public, max-age=31536000, immutable',
    )
    expect(conditionalGet.headers.get('etag')).toBe(`"${descriptor.digest}"`)
    expect(await conditionalGet.text()).toBe('')
    expect(conditionalHead.status).toBe(304)
    expect(conditionalHead.headers.get('cache-control')).toBe(
      'public, max-age=31536000, immutable',
    )
    expect(conditionalHead.headers.get('etag')).toBe(`"${descriptor.digest}"`)
    expect(await conditionalHead.text()).toBe('')
    expect(rangeGet.status).toBe(206)
    expect(rangeGet.headers.get('accept-ranges')).toBe('bytes')
    expect(rangeGet.headers.get('content-range')).toBe(
      `bytes 0-5/${descriptor.size}`,
    )
    expect(rangeGet.headers.get('content-length')).toBe('6')
    expect(await rangeGet.text()).toBe('object')
    expect(invalidRange.status).toBe(416)
    expect(invalidRange.headers.get('accept-ranges')).toBe('bytes')
    expect(invalidRange.headers.get('content-range')).toBe(
      `bytes */${descriptor.size}`,
    )
    expect(await invalidRange.text()).toBe('')
  })

  it('serves object HEAD and conditional reads without loading object bytes', async () => {
    const adapters = createMemoryRegistryAdapters()
    const descriptor = await adapters.objects.put(
      bytes('large object bytes'),
      'application/octet-stream',
    )
    const getObject = adapters.objects.get.bind(adapters.objects)
    let objectGetCalls = 0
    adapters.objects.get = (digest) => {
      objectGetCalls += 1
      return getObject(digest)
    }
    const app = createRegestaApp(adapters)

    const head = await app.request(`/api/v0/objects/${descriptor.digest}`, {
      method: 'HEAD',
    })
    const rangeHead = await app.request(
      `/api/v0/objects/${descriptor.digest}`,
      {
        headers: {
          range: 'bytes=6-11',
        },
        method: 'HEAD',
      },
    )
    const invalidRangeHead = await app.request(
      `/api/v0/objects/${descriptor.digest}`,
      {
        headers: {
          range: 'bytes=100-200',
        },
        method: 'HEAD',
      },
    )
    const conditional = await app.request(
      `/api/v0/objects/${descriptor.digest}`,
      {
        headers: {
          'if-none-match': `"${descriptor.digest}"`,
        },
      },
    )
    const invalidRangeGet = await app.request(
      `/api/v0/objects/${descriptor.digest}`,
      {
        headers: {
          range: 'bytes=100-200',
        },
      },
    )

    expect(head.status).toBe(200)
    expect(head.headers.get('content-length')).toBe(String(descriptor.size))
    expect(await head.text()).toBe('')
    expect(rangeHead.status).toBe(206)
    expect(rangeHead.headers.get('content-length')).toBe('6')
    expect(rangeHead.headers.get('content-range')).toBe(
      `bytes 6-11/${descriptor.size}`,
    )
    expect(await rangeHead.text()).toBe('')
    expect(invalidRangeHead.status).toBe(416)
    expect(invalidRangeHead.headers.get('content-range')).toBe(
      `bytes */${descriptor.size}`,
    )
    expect(await invalidRangeHead.text()).toBe('')
    expect(conditional.status).toBe(304)
    expect(await conditional.text()).toBe('')
    expect(invalidRangeGet.status).toBe(416)
    expect(invalidRangeGet.headers.get('content-range')).toBe(
      `bytes */${descriptor.size}`,
    )
    expect(await invalidRangeGet.text()).toBe('')
    expect(objectGetCalls).toBe(0)

    const get = await app.request(`/api/v0/objects/${descriptor.digest}`)

    expect(get.status).toBe(200)
    expect(await get.text()).toBe('large object bytes')
    expect(objectGetCalls).toBe(1)
  })

  it('reads events by digest', async () => {
    const adapters = createMemoryRegistryAdapters()
    const app = createRegestaApp(adapters)
    const packageId = 'npm:example.com/event-regesta'
    const publish = await publishRelease(
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
    const [algorithm, hex] = publish.event.id.split(':')

    const response = await app.request(`/api/v0/events/${algorithm}/${hex}`)
    const head = await app.request(`/api/v0/events/${algorithm}/${hex}`, {
      method: 'HEAD',
    })
    const conditional = await app.request(
      `/api/v0/events/${algorithm}/${hex}`,
      {
        headers: {
          'if-none-match': `"${publish.event.id}"`,
        },
      },
    )
    const conditionalHead = await app.request(
      `/api/v0/events/${algorithm}/${hex}`,
      {
        headers: {
          'if-none-match': `W/"${publish.event.id}"`,
        },
        method: 'HEAD',
      },
    )
    const missing = await app.request(`/api/v0/events/sha256/${'0'.repeat(64)}`)
    const invalid = await app.request(`/api/v0/events/sha512/${hex}`)

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe(
      'public, max-age=31536000, immutable',
    )
    expect(response.headers.get('content-type')).toBe(
      'application/json; charset=utf-8',
    )
    expect(response.headers.get('etag')).toBe(`W/"${publish.event.id}"`)
    await expect(response.json()).resolves.toMatchObject({
      eventType: 'release.published',
      id: publish.event.id,
      release: {
        id: packageId,
        version: '0.0.1',
      },
    })
    expect(head.status).toBe(200)
    expect(head.headers.get('cache-control')).toBe(
      'public, max-age=31536000, immutable',
    )
    expect(head.headers.get('content-type')).toBe(
      'application/json; charset=utf-8',
    )
    expect(head.headers.get('etag')).toBe(`W/"${publish.event.id}"`)
    expect(await head.text()).toBe('')
    expect(conditional.status).toBe(304)
    expect(conditional.headers.get('cache-control')).toBe(
      'public, max-age=31536000, immutable',
    )
    expect(conditional.headers.get('etag')).toBe(`W/"${publish.event.id}"`)
    expect(await conditional.text()).toBe('')
    expect(conditionalHead.status).toBe(304)
    expect(conditionalHead.headers.get('cache-control')).toBe(
      'public, max-age=31536000, immutable',
    )
    expect(conditionalHead.headers.get('etag')).toBe(`W/"${publish.event.id}"`)
    expect(await conditionalHead.text()).toBe('')
    expect(missing.status).toBe(404)
    await expect(missing.json()).resolves.toMatchObject({
      code: 'event_not_found',
      error: 'Event not found',
      message: 'Event not found',
    })
    expect(invalid.status).toBe(400)
    await expect(invalid.json()).resolves.toMatchObject({
      error: 'Invalid event digest',
    })
  })

  it('reads event log pages by event cursor', async () => {
    const adapters = createMemoryRegistryAdapters()
    const app = createRegestaApp(adapters)
    const first = await publishRelease(
      {
        artifacts: [
          {
            bytes: bytes('first install artifact'),
            format: 'npm-tarball',
            mediaType: 'application/gzip',
            role: 'install',
          },
        ],
        config: {
          id: 'npm:example.com/event-pages',
          source: {
            include: ['regesta.json'],
          },
          version: '0.0.1',
        },
        createdAt: '2026-06-01T00:00:00.000Z',
        source: bytes('first source archive'),
      },
      adapters,
    )
    const second = await publishRelease(
      {
        artifacts: [
          {
            bytes: bytes('second install artifact'),
            format: 'npm-tarball',
            mediaType: 'application/gzip',
            role: 'install',
          },
        ],
        config: {
          id: 'npm:example.com/event-pages',
          source: {
            include: ['regesta.json'],
          },
          version: '0.0.2',
        },
        createdAt: '2026-06-01T00:01:00.000Z',
        source: bytes('second source archive'),
      },
      adapters,
    )
    adapters.database.getEventLog = () => {
      throw new Error(
        'paginated event reads should not scan the full event log',
      )
    }

    const fullPage = await app.request('/api/v0/events')
    const firstPage = await app.request('/api/v0/events?limit=1')
    const firstPageHead = await app.request('/api/v0/events?limit=1', {
      method: 'HEAD',
    })
    const conditionalFirstPage = await app.request('/api/v0/events?limit=1', {
      headers: {
        'if-none-match': `"regesta.event-log.v0:${first.event.id}:1"`,
      },
    })
    const conditionalFirstPageHead = await app.request(
      '/api/v0/events?limit=1',
      {
        headers: {
          'if-none-match': `W/"regesta.event-log.v0:${first.event.id}:1"`,
        },
        method: 'HEAD',
      },
    )
    const secondPage = await app.request(
      `/api/v0/events?after=${encodeURIComponent(first.event.id)}&limit=1`,
    )
    const emptyPage = await app.request(
      `/api/v0/events?after=${encodeURIComponent(second.event.id)}&limit=1`,
    )
    const conditionalEmptyPage = await app.request(
      `/api/v0/events?after=${encodeURIComponent(second.event.id)}&limit=1`,
      {
        headers: {
          'if-none-match': `W/"regesta.event-log.v0:${second.event.id}:0"`,
        },
      },
    )
    const conditionalEmptyPageHead = await app.request(
      `/api/v0/events?after=${encodeURIComponent(second.event.id)}&limit=1`,
      {
        headers: {
          'if-none-match': `"regesta.event-log.v0:${second.event.id}:0"`,
        },
        method: 'HEAD',
      },
    )
    const missingCursor = await app.request(
      `/api/v0/events?after=${encodeURIComponent(
        sha256(bytes('missing event cursor')),
      )}&limit=1`,
    )
    const invalid = await app.request('/api/v0/events?limit=0')

    expect(fullPage.status).toBe(200)
    await expect(fullPage.json()).resolves.toMatchObject({
      events: [
        {
          id: first.event.id,
        },
        {
          id: second.event.id,
        },
      ],
      nextAfter: second.event.id,
      schema: 'regesta.event-log.v0',
    })
    expect(firstPage.status).toBe(200)
    expect(firstPage.headers.get('cache-control')).toBe('no-cache')
    expect(firstPage.headers.get('etag')).toBe(
      `W/"regesta.event-log.v0:${first.event.id}:1"`,
    )
    await expect(firstPage.json()).resolves.toMatchObject({
      events: [
        {
          id: first.event.id,
        },
      ],
      nextAfter: first.event.id,
      schema: 'regesta.event-log.v0',
    })
    expect(firstPageHead.status).toBe(200)
    expect(firstPageHead.headers.get('cache-control')).toBe('no-cache')
    expect(firstPageHead.headers.get('etag')).toBe(
      `W/"regesta.event-log.v0:${first.event.id}:1"`,
    )
    expect(await firstPageHead.text()).toBe('')
    expect(conditionalFirstPage.status).toBe(304)
    expect(conditionalFirstPage.headers.get('cache-control')).toBe('no-cache')
    expect(conditionalFirstPage.headers.get('etag')).toBe(
      `W/"regesta.event-log.v0:${first.event.id}:1"`,
    )
    expect(await conditionalFirstPage.text()).toBe('')
    expect(conditionalFirstPageHead.status).toBe(304)
    expect(conditionalFirstPageHead.headers.get('cache-control')).toBe(
      'no-cache',
    )
    expect(conditionalFirstPageHead.headers.get('etag')).toBe(
      `W/"regesta.event-log.v0:${first.event.id}:1"`,
    )
    expect(await conditionalFirstPageHead.text()).toBe('')
    expect(secondPage.status).toBe(200)
    await expect(secondPage.json()).resolves.toMatchObject({
      events: [
        {
          id: second.event.id,
        },
      ],
      nextAfter: second.event.id,
      schema: 'regesta.event-log.v0',
    })
    expect(emptyPage.status).toBe(200)
    await expect(emptyPage.json()).resolves.toEqual({
      events: [],
      schema: 'regesta.event-log.v0',
    })
    expect(emptyPage.headers.get('cache-control')).toBe('no-cache')
    expect(emptyPage.headers.get('etag')).toBe(
      `W/"regesta.event-log.v0:${second.event.id}:0"`,
    )
    expect(conditionalEmptyPage.status).toBe(304)
    expect(conditionalEmptyPage.headers.get('cache-control')).toBe('no-cache')
    expect(conditionalEmptyPage.headers.get('etag')).toBe(
      `W/"regesta.event-log.v0:${second.event.id}:0"`,
    )
    expect(await conditionalEmptyPage.text()).toBe('')
    expect(conditionalEmptyPageHead.status).toBe(304)
    expect(conditionalEmptyPageHead.headers.get('cache-control')).toBe(
      'no-cache',
    )
    expect(conditionalEmptyPageHead.headers.get('etag')).toBe(
      `W/"regesta.event-log.v0:${second.event.id}:0"`,
    )
    expect(await conditionalEmptyPageHead.text()).toBe('')
    expect(missingCursor.status).toBe(404)
    await expect(missingCursor.json()).resolves.toMatchObject({
      code: 'event_cursor_not_found',
      error: 'Event cursor not found',
      message: 'Event cursor not found',
    })
    expect(invalid.status).toBe(400)
    await expect(invalid.json()).resolves.toMatchObject({
      error: 'Invalid event log query',
    })
  })

  it('bounds event log reads when clients omit page limits', async () => {
    const adapters = createMemoryRegistryAdapters()
    let listOptions: unknown
    adapters.database.listEvents = (options = {}) => {
      listOptions = options
      return Promise.resolve([])
    }
    const app = createRegestaApp(adapters)
    const response = await app.request('/api/v0/events')

    expect(response.status).toBe(200)
    expect(listOptions).toEqual({
      after: undefined,
      limit: 999,
    })
    await expect(response.json()).resolves.toEqual({
      events: [],
      schema: 'regesta.event-log.v0',
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

  it('returns 400 for malformed publish multipart bodies', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const app = createRegestaApp(createMemoryRegistryAdapters())

    try {
      const response = await app.request('/api/v0/releases', {
        body: '--not-the-declared-boundary\r\n',
        headers: {
          'content-type': 'multipart/form-data; boundary=regesta-boundary',
        },
        method: 'POST',
      })

      expect(response.status).toBe(400)
      await expect(response.json()).resolves.toMatchObject({
        code: 'request_invalid',
        error: 'Invalid form request body',
        message: 'Invalid form request body',
      })
      expect(consoleError).not.toHaveBeenCalled()
    } finally {
      consoleError.mockRestore()
    }
  })

  it('rejects publish source files over the configured byte limit', async () => {
    const app = createRegestaApp(createMemoryRegistryAdapters(), {
      publishUploadLimits: {
        sourceBytes: 3,
      },
    })
    const form = new FormData()

    form.set(
      'config',
      JSON.stringify({
        id: 'demo:dev.localhost/source-too-large',
        source: {
          include: ['regesta.json'],
        },
        version: '0.0.1',
      }),
    )
    form.set(
      'artifacts',
      JSON.stringify([
        {
          mediaType: 'application/octet-stream',
          part: 'artifact.install',
          role: 'install',
        },
      ]),
    )
    form.set('artifact.install', new File(['ok'], 'artifact.bin'))
    form.set('source', new File(['source'], 'source.tgz'))

    const response = await app.request('/api/v0/releases', {
      body: form,
      method: 'POST',
    })

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      code: 'request_invalid',
      error: 'Publish request field source is too large',
      issues: ['source: Must be at most 3 bytes'],
    })
  })

  it('rejects publish artifacts over the configured byte limit', async () => {
    const app = createRegestaApp(createMemoryRegistryAdapters(), {
      publishUploadLimits: {
        artifactBytes: 3,
      },
    })
    const form = new FormData()

    form.set(
      'config',
      JSON.stringify({
        id: 'demo:dev.localhost/artifact-too-large',
        source: {
          include: ['regesta.json'],
        },
        version: '0.0.1',
      }),
    )
    form.set(
      'artifacts',
      JSON.stringify([
        {
          mediaType: 'application/octet-stream',
          part: 'artifact.install',
          role: 'install',
        },
      ]),
    )
    form.set('artifact.install', new File(['artifact'], 'artifact.bin'))
    form.set('source', new File(['source'], 'source.tgz'))

    const response = await app.request('/api/v0/releases', {
      body: form,
      method: 'POST',
    })

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      code: 'request_invalid',
      error: 'Publish request field artifact.install is too large',
      issues: ['artifact.install: Must be at most 3 bytes'],
    })
  })

  it('returns 400 for invalid artifact compatibility metadata', async () => {
    const app = createRegestaApp(createMemoryRegistryAdapters())
    const form = new FormData()

    form.set(
      'config',
      JSON.stringify({
        id: 'demo:dev.localhost/invalid-compatibility',
        source: {
          include: ['regesta.json'],
        },
        version: '0.0.1',
      }),
    )
    form.set(
      'artifacts',
      JSON.stringify([
        {
          compatibility: {
            runtimes: [1],
          },
          mediaType: 'application/octet-stream',
          part: 'artifact.install',
          role: 'install',
        },
      ]),
    )
    form.set('artifact.install', new File(['artifact'], 'artifact.bin'))

    const response = await app.request('/api/v0/releases', {
      body: form,
      method: 'POST',
    })

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      error: 'Invalid artifacts',
    })
  })

  it('returns 400 when publish artifact mediaType is missing', async () => {
    const app = createRegestaApp(createMemoryRegistryAdapters())
    const form = new FormData()

    form.set(
      'config',
      JSON.stringify({
        id: 'demo:dev.localhost/missing-artifact-media-type',
        source: {
          include: ['regesta.json'],
        },
        version: '0.0.1',
      }),
    )
    form.set(
      'artifacts',
      JSON.stringify([
        {
          part: 'artifact.install',
          role: 'install',
        },
      ]),
    )
    form.set('artifact.install', new File(['artifact'], 'artifact.bin'))

    const response = await app.request('/api/v0/releases', {
      body: form,
      method: 'POST',
    })

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      error: 'Invalid artifacts',
      issues: [
        '0.mediaType: Invalid key: Expected "mediaType" but received undefined',
      ],
    })
  })

  it('rejects unsafe publish artifact descriptor strings', async () => {
    const app = createRegestaApp(createMemoryRegistryAdapters())
    const form = new FormData()

    form.set(
      'config',
      JSON.stringify({
        id: 'demo:dev.localhost/unsafe-artifact-descriptor',
        source: {
          include: ['regesta.json'],
        },
        version: '0.0.1',
      }),
    )
    form.set(
      'artifacts',
      JSON.stringify([
        {
          filename: 'artifact.bin',
          format: 'demo',
          mediaType: 'application/octet-stream',
          part: 'artifact.install',
          role: 'install\r\nx',
        },
      ]),
    )
    form.set('artifact.install', new File(['artifact'], 'artifact.bin'))

    const response = await app.request('/api/v0/releases', {
      body: form,
      method: 'POST',
    })

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      error: 'Invalid artifacts',
      issues: ['artifact role must not include control characters'],
    })
  })

  it('rejects unknown artifact compatibility fields', async () => {
    const app = createRegestaApp(createMemoryRegistryAdapters())
    const form = new FormData()

    form.set(
      'config',
      JSON.stringify({
        id: 'demo:dev.localhost/unknown-compatibility',
        source: {
          include: ['regesta.json'],
        },
        version: '0.0.1',
      }),
    )
    form.set(
      'artifacts',
      JSON.stringify([
        {
          compatibility: {
            ecosystems: ['npm'],
          },
          mediaType: 'application/octet-stream',
          part: 'artifact.install',
          role: 'install',
        },
      ]),
    )
    form.set('artifact.install', new File(['artifact'], 'artifact.bin'))

    const response = await app.request('/api/v0/releases', {
      body: form,
      method: 'POST',
    })

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      error: 'Invalid artifacts',
      issues: [
        '0.compatibility.ecosystems: Invalid key: Expected never but received "ecosystems"',
      ],
    })
  })

  it('rejects client-supplied ecosystem metadata in publish artifact descriptors', async () => {
    const app = createRegestaApp(createMemoryRegistryAdapters())
    const form = new FormData()

    form.set(
      'config',
      JSON.stringify({
        id: 'npm:dev.localhost/client-metadata',
        source: {
          include: ['regesta.json'],
        },
        version: '0.0.1',
      }),
    )
    form.set(
      'artifacts',
      JSON.stringify([
        {
          ecosystemMetadata: {
            npm: {
              dependencies: {
                leftpad: '*',
              },
            },
          },
          mediaType: 'application/octet-stream',
          part: 'artifact.install',
          role: 'install',
        },
      ]),
    )
    form.set('artifact.install', new File(['artifact'], 'artifact.bin'))

    const response = await app.request('/api/v0/releases', {
      body: form,
      method: 'POST',
    })

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      error: 'Invalid artifacts',
      issues: [
        '0.ecosystemMetadata: Invalid key: Expected never but received "ecosystemMetadata"',
      ],
    })
  })

  it('returns 400 for malformed npm install artifacts', async () => {
    const app = createRegestaApp(createMemoryRegistryAdapters())
    const form = new FormData()
    const brokenGzip = new Uint8Array([0x1f, 0x8b, 0x08, 0x00])

    form.set(
      'config',
      JSON.stringify({
        id: 'npm:example.com/malformed-artifact',
        source: {
          include: ['regesta.json'],
        },
        version: '0.0.1',
      }),
    )
    form.set('authorization', JSON.stringify({}))
    form.set('source', new File(['source'], 'source.tgz'))
    form.set(
      'artifacts',
      JSON.stringify([
        {
          format: 'npm-tarball',
          mediaType: 'application/gzip',
          part: 'artifact.install',
          role: 'install',
        },
      ]),
    )
    form.set('artifact.install', new File([brokenGzip], 'package.tgz'))

    const response = await app.request('/api/v0/releases', {
      body: form,
      method: 'POST',
    })

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      error: 'npm install artifact must be a readable tarball',
    })
  })

  it('returns 400 for invalid npm package manifests inside install artifacts', async () => {
    const app = createRegestaApp(createMemoryRegistryAdapters())
    const form = new FormData()

    form.set(
      'config',
      JSON.stringify({
        id: 'npm:example.com/invalid-artifact-manifest',
        source: {
          include: ['regesta.json'],
        },
        version: '0.0.1',
      }),
    )
    form.set('authorization', JSON.stringify({}))
    form.set('source', new File(['source'], 'source.tgz'))
    form.set(
      'artifacts',
      JSON.stringify([
        {
          format: 'npm-tarball',
          mediaType: 'application/gzip',
          part: 'artifact.install',
          role: 'install',
        },
      ]),
    )
    form.set(
      'artifact.install',
      new File([blobPart(invalidPackageManifestTarball())], 'package.tgz'),
    )

    const response = await app.request('/api/v0/releases', {
      body: form,
      method: 'POST',
    })

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      error: 'npm package.json must be valid JSON',
    })
  })

  it('returns 400 for invalid npm resolver metadata inside install artifacts', async () => {
    const app = createRegestaApp(createMemoryRegistryAdapters())
    const form = new FormData()

    form.set(
      'config',
      JSON.stringify({
        id: 'npm:example.com/invalid-resolver-metadata',
        source: {
          include: ['regesta.json'],
        },
        version: '0.0.1',
      }),
    )
    form.set('authorization', JSON.stringify({}))
    form.set('source', new File(['source'], 'source.tgz'))
    form.set(
      'artifacts',
      JSON.stringify([
        {
          format: 'npm-tarball',
          mediaType: 'application/gzip',
          part: 'artifact.install',
          role: 'install',
        },
      ]),
    )
    form.set(
      'artifact.install',
      new File(
        [
          blobPart(
            packageManifestTarball({
              dependencies: {
                '@example.com/base': 1,
              },
              name: '@example.com/invalid-resolver-metadata',
              version: '0.0.1',
            }),
          ),
        ],
        'package.tgz',
      ),
    )

    const response = await app.request('/api/v0/releases', {
      body: form,
      method: 'POST',
    })

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      error: 'npm package.json dependencies.@example.com/base must be a string',
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

  it('returns 400 for malformed channel JSON bodies', async () => {
    const app = createRegestaApp(createMemoryRegistryAdapters())
    const packageId = encodeURIComponent('npm:example.com/hello-regesta')

    const update = await app.request(
      `/api/v0/packages/${packageId}/channels/latest`,
      {
        body: '{',
        headers: {
          'content-type': 'application/json',
        },
        method: 'PUT',
      },
    )
    const deletion = await app.request(
      `/api/v0/packages/${packageId}/channels/latest`,
      {
        body: '{',
        headers: {
          'content-type': 'application/json',
        },
        method: 'DELETE',
      },
    )

    expect(update.status).toBe(400)
    await expect(update.json()).resolves.toMatchObject({
      error: 'Invalid JSON request body',
    })
    expect(deletion.status).toBe(400)
    await expect(deletion.json()).resolves.toMatchObject({
      error: 'Invalid JSON request body',
    })
  })

  it('rejects unknown channel request body fields', async () => {
    const app = createRegestaApp(createMemoryRegistryAdapters())
    const packageId = encodeURIComponent('npm:example.com/hello-regesta')

    const update = await app.request(
      `/api/v0/packages/${packageId}/channels/latest`,
      {
        body: JSON.stringify({
          authorization: {},
          package: 'npm:example.com/other',
          version: '0.0.1',
        }),
        headers: {
          'content-type': 'application/json',
        },
        method: 'PUT',
      },
    )
    const deletion = await app.request(
      `/api/v0/packages/${packageId}/channels/latest`,
      {
        body: JSON.stringify({
          authorization: {},
          version: '0.0.1',
        }),
        headers: {
          'content-type': 'application/json',
        },
        method: 'DELETE',
      },
    )

    expect(update.status).toBe(400)
    await expect(update.json()).resolves.toMatchObject({
      error: 'Invalid channel request body',
      issues: ['package: Invalid key: Expected never but received "package"'],
    })
    expect(deletion.status).toBe(400)
    await expect(deletion.json()).resolves.toMatchObject({
      error: 'Invalid channel request body',
      issues: ['version: Invalid key: Expected never but received "version"'],
    })
  })

  it('treats encoded package ids as one route segment across core package routes', async () => {
    const adapters = createMemoryRegistryAdapters()
    const app = createRegestaApp(adapters)
    const packageId = 'go:some.dev/releases/pkg'
    const encodedPackageId = encodeURIComponent(packageId)

    const published = await publishRelease(
      {
        artifacts: [
          {
            bytes: bytes('install artifact'),
            format: 'go-module-archive',
            mediaType: 'application/gzip',
            role: 'install',
          },
        ],
        config: {
          id: packageId,
          source: {
            include: ['go.mod'],
          },
          version: '0.0.1',
        },
        createdAt: '2026-06-01T00:00:00.000Z',
        source: bytes('source archive'),
      },
      adapters,
    )

    const state = await app.request(`/api/v0/packages/${encodedPackageId}`)
    const stateHead = await app.request(
      `/api/v0/packages/${encodedPackageId}`,
      {
        method: 'HEAD',
      },
    )
    const conditionalState = await app.request(
      `/api/v0/packages/${encodedPackageId}`,
      {
        headers: {
          'if-none-match': `"${published.event.id}"`,
        },
      },
    )
    const release = await app.request(
      `/api/v0/packages/${encodedPackageId}/releases/0.0.1`,
    )
    const releaseHead = await app.request(
      `/api/v0/packages/${encodedPackageId}/releases/0.0.1`,
      {
        method: 'HEAD',
      },
    )
    const conditionalRelease = await app.request(
      `/api/v0/packages/${encodedPackageId}/releases/0.0.1`,
      {
        headers: {
          'if-none-match': `"${published.event.id}"`,
        },
      },
    )
    const channel = await app.request(
      `/api/v0/packages/${encodedPackageId}/channels/latest`,
    )
    const channelHead = await app.request(
      `/api/v0/packages/${encodedPackageId}/channels/latest`,
      {
        method: 'HEAD',
      },
    )
    const verification = await app.request(
      `/api/v0/packages/${encodedPackageId}/releases/0.0.1/verification`,
    )

    expect(state.status).toBe(200)
    expect(state.headers.get('cache-control')).toBe('no-cache')
    expect(state.headers.get('etag')).toBe(`W/"${published.event.id}"`)
    await expect(state.json()).resolves.toMatchObject({
      channels: {
        latest: '0.0.1',
      },
      id: packageId,
      releases: [
        {
          version: '0.0.1',
        },
      ],
    })
    expect(stateHead.status).toBe(200)
    expect(stateHead.headers.get('cache-control')).toBe('no-cache')
    expect(stateHead.headers.get('etag')).toBe(`W/"${published.event.id}"`)
    expect(await stateHead.text()).toBe('')
    expect(conditionalState.status).toBe(304)
    expect(conditionalState.headers.get('cache-control')).toBe('no-cache')
    expect(conditionalState.headers.get('etag')).toBe(
      `W/"${published.event.id}"`,
    )
    expect(await conditionalState.text()).toBe('')
    expect(release.status).toBe(200)
    expect(release.headers.get('cache-control')).toBe(
      'public, max-age=31536000, immutable',
    )
    expect(release.headers.get('content-type')).toBe(
      'application/json; charset=UTF-8',
    )
    expect(release.headers.get('etag')).toBe(`W/"${published.event.id}"`)
    await expect(release.json()).resolves.toMatchObject({
      event: {
        id: published.event.id,
      },
      manifest: {
        id: packageId,
        version: '0.0.1',
      },
      manifestDescriptor: {
        digest: published.manifestDescriptor.digest,
      },
    })
    expect(releaseHead.status).toBe(200)
    expect(releaseHead.headers.get('cache-control')).toBe(
      'public, max-age=31536000, immutable',
    )
    expect(releaseHead.headers.get('content-type')).toBe(
      'application/json; charset=UTF-8',
    )
    expect(releaseHead.headers.get('etag')).toBe(`W/"${published.event.id}"`)
    expect(await releaseHead.text()).toBe('')
    expect(conditionalRelease.status).toBe(304)
    expect(conditionalRelease.headers.get('cache-control')).toBe(
      'public, max-age=31536000, immutable',
    )
    expect(conditionalRelease.headers.get('etag')).toBe(
      `W/"${published.event.id}"`,
    )
    expect(await conditionalRelease.text()).toBe('')
    expect(channel.status).toBe(200)
    expect(channel.headers.get('cache-control')).toBe('no-cache')
    expect(channel.headers.get('etag')).toBe(`W/"${published.event.id}"`)
    await expect(channel.json()).resolves.toMatchObject({
      manifest: {
        id: packageId,
        version: '0.0.1',
      },
    })
    expect(channelHead.status).toBe(200)
    expect(channelHead.headers.get('cache-control')).toBe('no-cache')
    expect(channelHead.headers.get('etag')).toBe(`W/"${published.event.id}"`)
    expect(await channelHead.text()).toBe('')
    expect(verification.status).toBe(200)
    await expect(verification.json()).resolves.toMatchObject({
      manifest: {
        id: packageId,
        version: '0.0.1',
      },
      ok: true,
    })
  })

  it('reads package releases through channels', async () => {
    const adapters = createMemoryRegistryAdapters()
    const app = createRegestaApp(adapters)
    const packageId = 'npm:example.com/hello-regesta'

    const publish = await publishRelease(
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
    expect(response.headers.get('cache-control')).toBe('no-cache')
    expect(response.headers.get('etag')).toBe(`W/"${publish.event.id}"`)
    await expect(response.json()).resolves.toMatchObject({
      manifest: {
        id: packageId,
        version: '0.0.1',
      },
    })

    const conditional = await app.request(
      `/api/v0/packages/${encodeURIComponent(packageId)}/channels/latest`,
      {
        headers: {
          'if-none-match': `"${publish.event.id}"`,
        },
      },
    )

    expect(conditional.status).toBe(304)
    expect(conditional.headers.get('cache-control')).toBe('no-cache')
    expect(conditional.headers.get('etag')).toBe(`W/"${publish.event.id}"`)
    expect(await conditional.text()).toBe('')
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

  it('rejects invalid package channel route parameters', async () => {
    const app = createRegestaApp(createMemoryRegistryAdapters())
    const packageId = encodeURIComponent('npm:example.com/hello-regesta')
    const response = await app.request(
      `/api/v0/packages/${packageId}/channels/${encodeURIComponent('latest\r\nx')}`,
    )

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      code: 'request_invalid',
      issues: ['Package channel must not include control characters'],
    })
  })

  it('rejects invalid package version route parameters', async () => {
    const app = createRegestaApp(createMemoryRegistryAdapters())
    const packageId = encodeURIComponent('npm:example.com/hello-regesta')
    const response = await app.request(
      `/api/v0/packages/${packageId}/releases/${encodeURIComponent('0.0.1\r\nx')}`,
    )

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      code: 'request_invalid',
      issues: ['Package version must not include control characters'],
    })
  })

  it('rejects invalid channel update target versions', async () => {
    const app = createRegestaApp(createMemoryRegistryAdapters())
    const packageId = encodeURIComponent('npm:example.com/hello-regesta')
    const response = await app.request(
      `/api/v0/packages/${packageId}/channels/latest`,
      {
        body: JSON.stringify({
          authorization: {},
          version: '0.0.1\r\nx',
        }),
        headers: {
          'content-type': 'application/json',
        },
        method: 'PUT',
      },
    )

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      code: 'request_invalid',
      issues: ['Package version must not include control characters'],
    })
  })

  it('rejects replayed write authorizations for channel updates', async () => {
    const adapters = createMemoryRegistryAdapters()
    const app = createRegestaApp(adapters)
    const auth = createTestDomainAuth()
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
    const authorization = auth.sign(
      createChannelUpdateIntent({
        channel: 'latest',
        nonce: 'channel-replay-nonce',
        packageId,
        previousVersion: '0.0.1',
        timestamp: new Date().toISOString(),
        version: '0.0.1',
      }),
    )
    const body = JSON.stringify({
      authorization,
      version: '0.0.1',
    })

    vi.stubGlobal('fetch', auth.fetch)

    try {
      const first = await app.request(
        `/api/v0/packages/${encodeURIComponent(packageId)}/channels/latest`,
        {
          body,
          headers: {
            'content-type': 'application/json',
          },
          method: 'PUT',
        },
      )
      const replayed = await app.request(
        `/api/v0/packages/${encodeURIComponent(packageId)}/channels/latest`,
        {
          body,
          headers: {
            'content-type': 'application/json',
          },
          method: 'PUT',
        },
      )

      expect(first.status).toBe(200)
      expect(replayed.status).toBe(409)
      await expect(replayed.json()).resolves.toMatchObject({
        error: expect.stringContaining('Write authorization already used'),
      })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('maps package channel conflicts to conflict responses', async () => {
    const adapters = createMemoryRegistryAdapters()
    const app = createRegestaApp(adapters)
    const auth = createTestDomainAuth()
    const packageId = 'npm:example.com/channel-conflict'
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
    const authorization = auth.sign(
      createChannelUpdateIntent({
        channel: 'latest',
        nonce: 'channel-conflict-nonce',
        packageId,
        previousVersion: '0.0.1',
        timestamp: new Date().toISOString(),
        version: '0.0.1',
      }),
    )
    adapters.database.commitPackageChannelUpdate = () => {
      throw new PackageChannelConflictError(
        packageId,
        'latest',
        '0.0.1',
        '0.0.2',
      )
    }

    vi.stubGlobal('fetch', auth.fetch)

    try {
      const response = await app.request(
        `/api/v0/packages/${encodeURIComponent(packageId)}/channels/latest`,
        {
          body: JSON.stringify({
            authorization,
            version: '0.0.1',
          }),
          headers: {
            'content-type': 'application/json',
          },
          method: 'PUT',
        },
      )

      expect(response.status).toBe(409)
      await expect(response.json()).resolves.toMatchObject({
        error: expect.stringContaining('Package channel changed before commit'),
      })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('maps missing channel update releases to not found responses', async () => {
    const app = createRegestaApp(createMemoryRegistryAdapters())
    const auth = createTestDomainAuth()
    const packageId = 'npm:example.com/missing-channel-release'
    const authorization = auth.sign(
      createChannelUpdateIntent({
        channel: 'latest',
        nonce: 'missing-channel-release-nonce',
        packageId,
        timestamp: new Date().toISOString(),
        version: '0.0.1',
      }),
    )

    vi.stubGlobal('fetch', auth.fetch)

    try {
      const response = await app.request(
        `/api/v0/packages/${encodeURIComponent(packageId)}/channels/latest`,
        {
          body: JSON.stringify({
            authorization,
            version: '0.0.1',
          }),
          headers: {
            'content-type': 'application/json',
          },
          method: 'PUT',
        },
      )

      expect(response.status).toBe(404)
      await expect(response.json()).resolves.toMatchObject({
        error: expect.stringContaining('Release not found'),
      })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('maps duplicate registry event ids to conflict responses', async () => {
    const adapters = createMemoryRegistryAdapters()
    const app = createRegestaApp(adapters)
    const packageId = parsePackageId('demo:dev.localhost/event-conflict').id
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

    adapters.database.commitPublishedRelease = () => {
      throw new RegistryEventAlreadyExistsError(sha256(bytes('event')))
    }
    form.set('config', JSON.stringify(config))
    form.set(
      'authorization',
      JSON.stringify(
        createWriteAuthorization(
          createReleasePublishIntent({
            artifactDescriptorDigest: publishArtifactDescriptorDigest([
              {
                bytes: artifactBytes,
                format: 'demo',
                mediaType: 'application/octet-stream',
                role: 'install',
              },
            ]),
            artifactDigests: [sha256(artifactBytes)],
            configDigest: configDigest(config),
            nonce: 'event-conflict-nonce',
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

    vi.stubGlobal('fetch', devLocalhostFetch)

    try {
      const response = await app.request(
        'http://localhost:4321/api/v0/releases',
        {
          body: form,
          method: 'POST',
        },
      )

      expect(response.status).toBe(409)
      await expect(response.json()).resolves.toMatchObject({
        error: expect.stringContaining('Registry event already exists'),
      })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('maps duplicate releases to conflict responses', async () => {
    const adapters = createMemoryRegistryAdapters()
    const app = createRegestaApp(adapters)
    const packageId = parsePackageId('demo:dev.localhost/duplicate-release').id
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

    await publishRelease(
      {
        artifacts: [
          {
            bytes: artifactBytes,
            mediaType: 'application/octet-stream',
            role: 'install',
          },
        ],
        config,
        createdAt: '2026-06-01T00:00:00.000Z',
        source: sourceBytes,
      },
      adapters,
    )
    form.set('config', JSON.stringify(config))
    form.set(
      'authorization',
      JSON.stringify(
        createWriteAuthorization(
          createReleasePublishIntent({
            artifactDescriptorDigest: publishArtifactDescriptorDigest([
              {
                bytes: artifactBytes,
                mediaType: 'application/octet-stream',
                role: 'install',
              },
            ]),
            artifactDigests: [sha256(artifactBytes)],
            configDigest: configDigest(config),
            nonce: 'duplicate-release-nonce',
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

    vi.stubGlobal('fetch', devLocalhostFetch)

    try {
      const response = await app.request(
        'http://localhost:4321/api/v0/releases',
        {
          body: form,
          method: 'POST',
        },
      )

      expect(response.status).toBe(409)
      await expect(response.json()).resolves.toMatchObject({
        error: expect.stringContaining('Release already exists'),
      })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('accepts dev.localhost write signatures through domain binding lookup', async () => {
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
            artifactDescriptorDigest: publishArtifactDescriptorDigest([
              {
                bytes: artifactBytes,
                format: 'demo',
                mediaType: 'application/octet-stream',
                role: 'install',
              },
            ]),
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

    vi.stubGlobal('fetch', devLocalhostFetch)

    try {
      const response = await app.request(
        'http://localhost:4321/api/v0/releases',
        {
          body: form,
          method: 'POST',
        },
      )

      expect(response.status).toBe(201)
      await expect(response.json()).resolves.toMatchObject({
        manifest: {
          id: packageId,
        },
      })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('publishes artifact-level compatibility from multipart metadata', async () => {
    const app = createRegestaApp(createMemoryRegistryAdapters())
    const packageId = parsePackageId('demo:dev.localhost/artifact-compat').id
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
            artifactDescriptorDigest: publishArtifactDescriptorDigest([
              {
                bytes: artifactBytes,
                compatibility: {
                  modules: ['esm'],
                  platforms: [
                    {
                      arch: ['x64', 'arm64'],
                      os: ['linux', 'darwin'],
                    },
                  ],
                  runtimes: [
                    'node',
                    {
                      conditions: ['node', 'import'],
                      name: 'bun',
                      versions: '>=1.2',
                    },
                  ],
                },
                format: 'demo',
                mediaType: 'application/octet-stream',
                role: 'install',
              },
            ]),
            artifactDigests: [sha256(artifactBytes)],
            configDigest: configDigest(config),
            nonce: 'artifact-compatibility-nonce',
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
          compatibility: {
            modules: ['esm'],
            platforms: [
              {
                arch: ['x64', 'arm64'],
                os: ['linux', 'darwin'],
              },
            ],
            runtimes: [
              'node',
              {
                conditions: ['node', 'import'],
                name: 'bun',
                versions: '>=1.2',
              },
            ],
          },
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

    vi.stubGlobal('fetch', devLocalhostFetch)

    try {
      const response = await app.request(
        'http://localhost:4321/api/v0/releases',
        {
          body: form,
          method: 'POST',
        },
      )

      expect(response.status).toBe(201)
      await expect(response.json()).resolves.toMatchObject({
        manifest: {
          artifacts: [
            {
              compatibility: {
                modules: ['esm'],
                platforms: [
                  {
                    arch: ['x64', 'arm64'],
                    os: ['linux', 'darwin'],
                  },
                ],
                runtimes: [
                  'node',
                  {
                    conditions: ['node', 'import'],
                    name: 'bun',
                    versions: '>=1.2',
                  },
                ],
              },
            },
          ],
        },
      })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('rejects publish signatures that do not bind client artifact descriptor metadata', async () => {
    const app = createRegestaApp(createMemoryRegistryAdapters())
    const packageId = parsePackageId('demo:dev.localhost/signed-filename').id
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
            artifactDescriptorDigest: publishArtifactDescriptorDigest([
              {
                bytes: artifactBytes,
                format: 'demo',
                mediaType: 'application/octet-stream',
                role: 'install',
              },
            ]),
            artifactDigests: [sha256(artifactBytes)],
            configDigest: configDigest(config),
            nonce: 'unsigned-artifact-filename-nonce',
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
          filename: 'artifact.bin',
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

    vi.stubGlobal('fetch', devLocalhostFetch)

    try {
      const response = await app.request(
        'http://localhost:4321/api/v0/releases',
        {
          body: form,
          method: 'POST',
        },
      )

      expect(response.status).toBe(401)
      await expect(response.json()).resolves.toMatchObject({
        code: 'write_authorization_invalid',
        message: 'Write authorization payload mismatch',
      })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('infers core release description from npm install artifacts before verifying publish signatures', async () => {
    const app = createRegestaApp(createMemoryRegistryAdapters())
    const prepared = await prepareFixtureNpmPublish(
      await createFixtureProject(),
    )
    const installArtifact = prepared.artifacts[0]
    const publishConfig = withoutDescription(prepared.config)
    const auth = createTestDomainAuth()

    if (!installArtifact) {
      throw new Error('Fixture publish did not produce an install artifact')
    }

    const publishForm = new FormData()
    publishForm.set('config', JSON.stringify(publishConfig))
    publishForm.set(
      'authorization',
      JSON.stringify(
        auth.sign(
          createReleasePublishIntent({
            artifactDescriptorDigest: publishArtifactDescriptorDigest(
              prepared.artifacts.map((artifact) => ({
                bytes: artifact.bytes,
                filename: artifact.filename,
                format: artifact.format,
                mediaType: artifact.mediaType,
                role: artifact.role,
              })),
            ),
            artifactDigests: prepared.artifacts.map((artifact) =>
              sha256(artifact.bytes),
            ),
            configDigest: configDigest(prepared.config),
            nonce: 'inferred-description-nonce',
            packageId: prepared.config.id,
            sourceDigest: sha256(prepared.source),
            timestamp: new Date().toISOString(),
            version: prepared.config.version,
          }),
        ),
      ),
    )
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
      const response = await app.request('/api/v0/releases', {
        body: publishForm,
        method: 'POST',
      })

      expect(response.status).toBe(201)
      await expect(response.json()).resolves.toMatchObject({
        manifest: {
          metadata: {
            description: 'Fixture package',
          },
        },
      })

      const latest = await app.request(
        `/api/v0/packages/${encodeURIComponent(prepared.config.id)}/channels/latest`,
      )

      expect(latest.status).toBe(200)
      await expect(latest.json()).resolves.toMatchObject({
        manifest: {
          metadata: {
            description: 'Fixture package',
          },
        },
      })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('rejects publish signatures that do not include inferred release description', async () => {
    const app = createRegestaApp(createMemoryRegistryAdapters())
    const prepared = await prepareFixtureNpmPublish(
      await createFixtureProject(),
    )
    const installArtifact = prepared.artifacts[0]
    const publishConfig = withoutDescription(prepared.config)
    const auth = createTestDomainAuth()

    if (!installArtifact) {
      throw new Error('Fixture publish did not produce an install artifact')
    }

    const publishForm = new FormData()
    publishForm.set('config', JSON.stringify(publishConfig))
    publishForm.set(
      'authorization',
      JSON.stringify(
        auth.sign(
          createReleasePublishIntent({
            artifactDescriptorDigest: publishArtifactDescriptorDigest(
              prepared.artifacts.map((artifact) => ({
                bytes: artifact.bytes,
                filename: artifact.filename,
                format: artifact.format,
                mediaType: artifact.mediaType,
                role: artifact.role,
              })),
            ),
            artifactDigests: prepared.artifacts.map((artifact) =>
              sha256(artifact.bytes),
            ),
            configDigest: configDigest(publishConfig),
            nonce: 'unsigned-inferred-description-nonce',
            packageId: prepared.config.id,
            sourceDigest: sha256(prepared.source),
            timestamp: new Date().toISOString(),
            version: prepared.config.version,
          }),
        ),
      ),
    )
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
      const response = await app.request('/api/v0/releases', {
        body: publishForm,
        method: 'POST',
      })

      expect(response.status).toBe(401)
      await expect(response.json()).resolves.toMatchObject({
        code: 'write_authorization_invalid',
        message: 'Write authorization payload mismatch',
      })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('serves npm projection APIs on npm subdomains', async () => {
    const adapters = createMemoryRegistryAdapters()
    const app = createRegestaApp(adapters)
    const prepared = await prepareFixtureNpmPublish(
      await createFixtureProject(),
    )
    const installArtifact = prepared.artifacts[0]
    const auth = createTestDomainAuth()

    if (!installArtifact) {
      throw new Error('Fixture publish did not produce an install artifact')
    }

    const publishForm = new FormData()
    const publishTimestamp = new Date().toISOString()
    publishForm.set('config', JSON.stringify(prepared.config))
    publishForm.set(
      'authorization',
      JSON.stringify(
        auth.sign(
          createReleasePublishIntent({
            artifactDescriptorDigest: publishArtifactDescriptorDigest(
              prepared.artifacts.map((artifact) => ({
                bytes: artifact.bytes,
                filename: artifact.filename,
                format: artifact.format,
                mediaType: artifact.mediaType,
                role: artifact.role,
              })),
            ),
            artifactDigests: prepared.artifacts.map((artifact) =>
              sha256(artifact.bytes),
            ),
            configDigest: configDigest(prepared.config),
            nonce: 'release-nonce',
            packageId: prepared.config.id,
            sourceDigest: sha256(prepared.source),
            timestamp: publishTimestamp,
            version: prepared.config.version,
          }),
        ),
      ),
    )
    publishForm.set('createdAt', publishTimestamp)
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

    let npmProjectionEtag: string | undefined

    try {
      const publish = await app.request('/api/v0/releases', {
        body: publishForm,
        method: 'POST',
      })

      expect(publish.status).toBe(201)
      const publishBody = await publish.json()
      expect(publishBody).toMatchObject({
        channel: 'latest',
      })
      if (
        !isRecord(publishBody) ||
        !isRecord(publishBody.event) ||
        typeof publishBody.event.id !== 'string'
      ) {
        throw new Error('publish response event id must be a string')
      }
      npmProjectionEtag = `W/"regesta.npm-projection:${publishBody.event.id}"`
    } finally {
      vi.unstubAllGlobals()
    }

    if (!npmProjectionEtag) {
      throw new Error('npm projection etag was not computed')
    }
    const npmVersionManifestEtag = npmProjectionEtag.replace(
      'regesta.npm-projection',
      'regesta.npm-version',
    )

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
    expect(subdomainPackument.headers.get('cache-control')).toBe('no-cache')
    expect(subdomainPackument.headers.get('etag')).toBe(npmProjectionEtag)
    await expect(subdomainPackument.json()).resolves.toMatchObject({
      'dist-tags': {
        latest: '0.0.1',
      },
      description: 'Fixture package',
      name: '@example.com/hello-regesta',
      time: {
        '0.0.1': publishTimestamp,
        created: publishTimestamp,
        modified: publishTimestamp,
      },
      versions: {
        '0.0.1': {
          dependencies: {
            '@example.com/base': '^1.0.0',
          },
          description: 'Fixture package',
          dist: {
            tarball:
              'http://npm.registry.test/@example.com/hello-regesta/-/hello-regesta-0.0.1.tgz',
          },
        },
      },
    })

    const conditionalPackument = await app.request(
      'http://npm.registry.test/@example.com/hello-regesta',
      {
        headers: {
          'if-none-match': npmProjectionEtag.replace('W/', ''),
        },
      },
    )

    expect(conditionalPackument.status).toBe(304)
    expect(conditionalPackument.headers.get('cache-control')).toBe('no-cache')
    expect(conditionalPackument.headers.get('etag')).toBe(npmProjectionEtag)
    expect(await conditionalPackument.text()).toBe('')

    const headPackument = await app.request(
      'http://npm.registry.test/@example.com/hello-regesta',
      {
        method: 'HEAD',
      },
    )

    expect(headPackument.status).toBe(200)
    expect(headPackument.headers.get('cache-control')).toBe('no-cache')
    expect(headPackument.headers.get('content-type')).toBe(
      'application/json; charset=UTF-8',
    )
    expect(headPackument.headers.get('etag')).toBe(npmProjectionEtag)
    expect(await headPackument.text()).toBe('')

    const conditionalHeadPackument = await app.request(
      'http://npm.registry.test/@example.com/hello-regesta',
      {
        headers: {
          'if-none-match': npmProjectionEtag,
        },
        method: 'HEAD',
      },
    )

    expect(conditionalHeadPackument.status).toBe(304)
    expect(conditionalHeadPackument.headers.get('cache-control')).toBe(
      'no-cache',
    )
    expect(conditionalHeadPackument.headers.get('etag')).toBe(npmProjectionEtag)
    expect(await conditionalHeadPackument.text()).toBe('')

    const subdomainLatestManifest = await app.request(
      'http://npm.registry.test/@example.com/hello-regesta/latest',
    )

    expect(subdomainLatestManifest.status).toBe(200)
    expect(subdomainLatestManifest.headers.get('cache-control')).toBe(
      'no-cache',
    )
    expect(subdomainLatestManifest.headers.get('etag')).toBe(npmProjectionEtag)
    await expect(subdomainLatestManifest.json()).resolves.toMatchObject({
      dependencies: {
        '@example.com/base': '^1.0.0',
      },
      description: 'Fixture package',
      dist: {
        tarball:
          'http://npm.registry.test/@example.com/hello-regesta/-/hello-regesta-0.0.1.tgz',
      },
      name: '@example.com/hello-regesta',
      version: '0.0.1',
    })

    const subdomainVersionManifest = await app.request(
      'http://npm.registry.test/@example.com/hello-regesta/0.0.1',
    )

    expect(subdomainVersionManifest.status).toBe(200)
    expect(subdomainVersionManifest.headers.get('cache-control')).toBe(
      'public, max-age=31536000, immutable',
    )
    expect(subdomainVersionManifest.headers.get('etag')).toBe(
      npmVersionManifestEtag,
    )
    await expect(subdomainVersionManifest.json()).resolves.toMatchObject({
      name: '@example.com/hello-regesta',
      version: '0.0.1',
    })

    const conditionalVersionManifest = await app.request(
      'http://npm.registry.test/@example.com/hello-regesta/0.0.1',
      {
        headers: {
          'if-none-match': npmVersionManifestEtag.replace('W/', ''),
        },
      },
    )

    expect(conditionalVersionManifest.status).toBe(304)
    expect(conditionalVersionManifest.headers.get('cache-control')).toBe(
      'public, max-age=31536000, immutable',
    )
    expect(conditionalVersionManifest.headers.get('etag')).toBe(
      npmVersionManifestEtag,
    )
    expect(await conditionalVersionManifest.text()).toBe('')

    const headVersionManifest = await app.request(
      'http://npm.registry.test/@example.com/hello-regesta/0.0.1',
      {
        method: 'HEAD',
      },
    )

    expect(headVersionManifest.status).toBe(200)
    expect(headVersionManifest.headers.get('cache-control')).toBe(
      'public, max-age=31536000, immutable',
    )
    expect(headVersionManifest.headers.get('etag')).toBe(npmVersionManifestEtag)
    expect(await headVersionManifest.text()).toBe('')

    const conditionalHeadVersionManifest = await app.request(
      'http://npm.registry.test/@example.com/hello-regesta/0.0.1',
      {
        headers: {
          'if-none-match': npmVersionManifestEtag,
        },
        method: 'HEAD',
      },
    )

    expect(conditionalHeadVersionManifest.status).toBe(304)
    expect(conditionalHeadVersionManifest.headers.get('cache-control')).toBe(
      'public, max-age=31536000, immutable',
    )
    expect(conditionalHeadVersionManifest.headers.get('etag')).toBe(
      npmVersionManifestEtag,
    )
    expect(await conditionalHeadVersionManifest.text()).toBe('')

    const subdomainDistTags = await app.request(
      'http://npm.registry.test/-/package/@example.com/hello-regesta/dist-tags',
    )

    expect(subdomainDistTags.status).toBe(200)
    expect(subdomainDistTags.headers.get('cache-control')).toBe('no-cache')
    expect(subdomainDistTags.headers.get('etag')).toBe(npmProjectionEtag)
    await expect(subdomainDistTags.json()).resolves.toEqual({
      latest: '0.0.1',
    })

    const conditionalDistTags = await app.request(
      'http://npm.registry.test/-/package/@example.com/hello-regesta/dist-tags',
      {
        headers: {
          'if-none-match': npmProjectionEtag,
        },
      },
    )

    expect(conditionalDistTags.status).toBe(304)
    expect(conditionalDistTags.headers.get('cache-control')).toBe('no-cache')
    expect(conditionalDistTags.headers.get('etag')).toBe(npmProjectionEtag)
    expect(await conditionalDistTags.text()).toBe('')

    const headDistTags = await app.request(
      'http://npm.registry.test/-/package/@example.com/hello-regesta/dist-tags',
      {
        method: 'HEAD',
      },
    )

    expect(headDistTags.status).toBe(200)
    expect(headDistTags.headers.get('cache-control')).toBe('no-cache')
    expect(headDistTags.headers.get('etag')).toBe(npmProjectionEtag)
    expect(await headDistTags.text()).toBe('')

    const conditionalHeadDistTags = await app.request(
      'http://npm.registry.test/-/package/@example.com/hello-regesta/dist-tags',
      {
        headers: {
          'if-none-match': npmProjectionEtag,
        },
        method: 'HEAD',
      },
    )

    expect(conditionalHeadDistTags.status).toBe(304)
    expect(conditionalHeadDistTags.headers.get('cache-control')).toBe(
      'no-cache',
    )
    expect(conditionalHeadDistTags.headers.get('etag')).toBe(npmProjectionEtag)
    expect(await conditionalHeadDistTags.text()).toBe('')

    const subdomainPing = await app.request('http://npm.registry.test/-/ping')

    expect(subdomainPing.status).toBe(200)
    await expect(subdomainPing.json()).resolves.toEqual({ ping: 'pong' })

    const headPing = await app.request('http://npm.registry.test/-/ping', {
      method: 'HEAD',
    })

    expect(headPing.status).toBe(200)
    expect(await headPing.text()).toBe('')

    const subdomainTarball = await app.request(
      'http://npm.registry.test/@example.com/hello-regesta/-/hello-regesta-0.0.1.tgz',
    )

    expect(subdomainTarball.status).toBe(200)
    expect(subdomainTarball.headers.get('cache-control')).toBe(
      'public, max-age=31536000, immutable',
    )
    expect(subdomainTarball.headers.get('accept-ranges')).toBe('bytes')
    expect(subdomainTarball.headers.get('content-type')).toBe(
      'application/gzip',
    )
    expect(subdomainTarball.headers.get('etag')).toBe(
      `"${sha256(installArtifact.bytes)}"`,
    )
    const tarballBytes = new Uint8Array(await subdomainTarball.arrayBuffer())
    expect(tarballBytes).toEqual(new Uint8Array(installArtifact.bytes))
    expect(tarballBytes).not.toEqual(new Uint8Array(prepared.source))

    const rangeTarball = await app.request(
      'http://npm.registry.test/@example.com/hello-regesta/-/hello-regesta-0.0.1.tgz',
      {
        headers: {
          range: 'bytes=1-3',
        },
      },
    )
    const invalidRangeTarball = await app.request(
      'http://npm.registry.test/@example.com/hello-regesta/-/hello-regesta-0.0.1.tgz',
      {
        headers: {
          range: `bytes=${installArtifact.bytes.byteLength}-`,
        },
      },
    )

    expect(rangeTarball.status).toBe(206)
    expect(rangeTarball.headers.get('accept-ranges')).toBe('bytes')
    expect(rangeTarball.headers.get('content-range')).toBe(
      `bytes 1-3/${installArtifact.bytes.byteLength}`,
    )
    expect(rangeTarball.headers.get('content-length')).toBe('3')
    expect(new Uint8Array(await rangeTarball.arrayBuffer())).toEqual(
      new Uint8Array(installArtifact.bytes).subarray(1, 4),
    )
    expect(invalidRangeTarball.status).toBe(416)
    expect(invalidRangeTarball.headers.get('accept-ranges')).toBe('bytes')
    expect(invalidRangeTarball.headers.get('content-range')).toBe(
      `bytes */${installArtifact.bytes.byteLength}`,
    )
    expect(await invalidRangeTarball.text()).toBe('')

    const conditionalTarball = await app.request(
      'http://npm.registry.test/@example.com/hello-regesta/-/hello-regesta-0.0.1.tgz',
      {
        headers: {
          'if-none-match': `"sha256:${'0'.repeat(64)}", W/"${sha256(
            installArtifact.bytes,
          )}"`,
        },
      },
    )

    expect(conditionalTarball.status).toBe(304)
    expect(conditionalTarball.headers.get('cache-control')).toBe(
      'public, max-age=31536000, immutable',
    )
    expect(conditionalTarball.headers.get('etag')).toBe(
      `"${sha256(installArtifact.bytes)}"`,
    )
    expect(await conditionalTarball.text()).toBe('')

    const headTarball = await app.request(
      'http://npm.registry.test/@example.com/hello-regesta/-/hello-regesta-0.0.1.tgz',
      {
        method: 'HEAD',
      },
    )

    expect(headTarball.status).toBe(200)
    expect(headTarball.headers.get('content-length')).toBe(
      String(installArtifact.bytes.byteLength),
    )
    expect(headTarball.headers.get('etag')).toBe(
      `"${sha256(installArtifact.bytes)}"`,
    )
    expect(await headTarball.text()).toBe('')

    const conditionalHeadTarball = await app.request(
      'http://npm.registry.test/@example.com/hello-regesta/-/hello-regesta-0.0.1.tgz',
      {
        headers: {
          'if-none-match': `"${sha256(installArtifact.bytes)}"`,
        },
        method: 'HEAD',
      },
    )

    expect(conditionalHeadTarball.status).toBe(304)
    expect(conditionalHeadTarball.headers.get('cache-control')).toBe(
      'public, max-age=31536000, immutable',
    )
    expect(conditionalHeadTarball.headers.get('etag')).toBe(
      `"${sha256(installArtifact.bytes)}"`,
    )
    expect(await conditionalHeadTarball.text()).toBe('')

    const rootPathOnMainHost = await app.request(
      'http://registry.test/@example.com/hello-regesta',
    )

    expect(rootPathOnMainHost.status).toBe(404)
  })

  it('serves locally persisted publish data after app restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'regesta-server-local-'))
    const projectDir = await createFixtureProject({
      dependencies: false,
    })
    const prepared = await prepareFixtureNpmPublish(projectDir)
    const installArtifact = prepared.artifacts[0]
    const auth = createTestDomainAuth()
    const publishTimestamp = new Date().toISOString()
    const publishForm = createSignedPublishForm({
      auth,
      nonce: 'local-persistence-nonce',
      prepared,
      timestamp: publishTimestamp,
    })

    if (!installArtifact) {
      throw new Error('Fixture publish did not produce an install artifact')
    }

    try {
      const firstApp = createRegestaApp(createLocalRegistryAdapters(root))

      vi.stubGlobal('fetch', auth.fetch)

      try {
        const publish = await firstApp.request('/api/v0/releases', {
          body: publishForm,
          method: 'POST',
        })

        expect(publish.status).toBe(201)
        await expect(publish.json()).resolves.toMatchObject({
          channel: 'latest',
          manifest: {
            id: prepared.config.id,
            metadata: {
              description: 'Fixture package',
            },
            version: prepared.config.version,
          },
        })
      } finally {
        vi.unstubAllGlobals()
      }

      const restartedApp = createRegestaApp(createLocalRegistryAdapters(root))
      const packageId = encodeURIComponent(prepared.config.id)
      const packageState = await restartedApp.request(
        `/api/v0/packages/${packageId}`,
      )

      expect(packageState.status).toBe(200)
      await expect(packageState.json()).resolves.toMatchObject({
        channels: {
          latest: prepared.config.version,
        },
        id: prepared.config.id,
        releases: [
          {
            createdAt: publishTimestamp,
            version: prepared.config.version,
          },
        ],
      })

      const verification = await restartedApp.request(
        `/api/v0/packages/${packageId}/releases/${prepared.config.version}/verification`,
      )

      expect(verification.status).toBe(200)
      await expect(verification.json()).resolves.toMatchObject({
        ok: true,
        problems: [],
      })

      const packument = await restartedApp.request(
        'http://npm.registry.test/@example.com/hello-regesta',
      )

      expect(packument.status).toBe(200)
      await expect(packument.json()).resolves.toMatchObject({
        'dist-tags': {
          latest: prepared.config.version,
        },
        description: 'Fixture package',
        name: '@example.com/hello-regesta',
        versions: {
          [prepared.config.version]: {
            description: 'Fixture package',
            version: prepared.config.version,
          },
        },
      })

      const tarball = await restartedApp.request(
        'http://npm.registry.test/@example.com/hello-regesta/-/hello-regesta-0.0.1.tgz',
      )

      expect(tarball.status).toBe(200)
      expect(new Uint8Array(await tarball.arrayBuffer())).toEqual(
        new Uint8Array(installArtifact.bytes),
      )
    } finally {
      await rm(projectDir, { force: true, recursive: true })
      await rm(root, { force: true, recursive: true })
    }
  })

  it('serves npm tarball HEAD and conditional reads without loading artifact bytes', async () => {
    const adapters = createMemoryRegistryAdapters()
    const artifactBytes = bytes('install artifact bytes')
    const artifactDigest = sha256(artifactBytes)

    await publishRelease(
      {
        artifacts: [
          {
            bytes: artifactBytes,
            format: 'npm-tarball',
            mediaType: 'application/gzip',
            role: 'install',
          },
        ],
        config: {
          id: 'npm:example.com/descriptor-tarball',
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

    const getObject = adapters.objects.get.bind(adapters.objects)
    let objectGetCalls = 0
    adapters.objects.get = (digest) => {
      objectGetCalls += 1
      return getObject(digest)
    }
    const app = createRegestaApp(adapters)
    const tarballUrl =
      'http://npm.registry.test/@example.com/descriptor-tarball/-/descriptor-tarball-0.0.1.tgz'
    const head = await app.request(tarballUrl, {
      method: 'HEAD',
    })
    const rangeHead = await app.request(tarballUrl, {
      headers: {
        range: 'bytes=1-7',
      },
      method: 'HEAD',
    })
    const invalidRangeHead = await app.request(tarballUrl, {
      headers: {
        range: `bytes=${artifactBytes.byteLength}-`,
      },
      method: 'HEAD',
    })
    const conditional = await app.request(tarballUrl, {
      headers: {
        'if-none-match': `"${artifactDigest}"`,
      },
    })
    const invalidRangeGet = await app.request(tarballUrl, {
      headers: {
        range: `bytes=${artifactBytes.byteLength}-`,
      },
    })

    expect(head.status).toBe(200)
    expect(head.headers.get('content-length')).toBe(
      String(artifactBytes.byteLength),
    )
    expect(head.headers.get('etag')).toBe(`"${artifactDigest}"`)
    expect(await head.text()).toBe('')
    expect(rangeHead.status).toBe(206)
    expect(rangeHead.headers.get('content-length')).toBe('7')
    expect(rangeHead.headers.get('content-range')).toBe(
      `bytes 1-7/${artifactBytes.byteLength}`,
    )
    expect(await rangeHead.text()).toBe('')
    expect(invalidRangeHead.status).toBe(416)
    expect(invalidRangeHead.headers.get('content-range')).toBe(
      `bytes */${artifactBytes.byteLength}`,
    )
    expect(await invalidRangeHead.text()).toBe('')
    expect(conditional.status).toBe(304)
    expect(await conditional.text()).toBe('')
    expect(invalidRangeGet.status).toBe(416)
    expect(invalidRangeGet.headers.get('content-range')).toBe(
      `bytes */${artifactBytes.byteLength}`,
    )
    expect(await invalidRangeGet.text()).toBe('')
    expect(objectGetCalls).toBe(0)

    const get = await app.request(tarballUrl)

    expect(get.status).toBe(200)
    expect(await get.text()).toBe('install artifact bytes')
    expect(objectGetCalls).toBe(1)
  })

  it('supports real npm installs through the npm projection host', async () => {
    const adapters = createMemoryRegistryAdapters()
    const app = createRegestaApp(adapters)
    const projectDir = await createFixtureProject({
      dependencies: false,
    })
    const installDir = await mkdtemp(join(tmpdir(), 'regesta-npm-install-'))
    const server = await listenForNpmInstall(app)

    try {
      const prepared = await prepareFixtureNpmPublish(projectDir)
      await publishRelease(
        {
          artifacts: prepared.artifacts,
          config: prepared.config,
          createdAt: '2026-06-01T00:00:00.000Z',
          source: prepared.source,
        },
        adapters,
      )
      await writeFile(
        join(installDir, 'package.json'),
        '{"private":true,"type":"module"}\n',
      )
      await execFileAsync(
        'npm',
        [
          'install',
          '--audit=false',
          '--fund=false',
          '--ignore-scripts',
          '--package-lock=false',
          '--registry',
          server.origin,
          '--cache',
          join(installDir, '.npm-cache'),
          '@example.com/hello-regesta@latest',
        ],
        {
          cwd: installDir,
          env: {
            ...process.env,
            npm_config_update_notifier: 'false',
          },
        },
      )

      const installedPackageJson = JSON.parse(
        await readFile(
          join(
            installDir,
            'node_modules',
            '@example.com',
            'hello-regesta',
            'package.json',
          ),
          'utf8',
        ),
      )
      const installedSource = await readFile(
        join(
          installDir,
          'node_modules',
          '@example.com',
          'hello-regesta',
          'src',
          'index.ts',
        ),
        'utf8',
      )

      expect(installedPackageJson).toMatchObject({
        name: '@example.com/hello-regesta',
        version: '0.0.1',
      })
      expect(installedSource).toBe('export const value = 1\n')
    } finally {
      await server.close()
      await rm(projectDir, { force: true, recursive: true })
      await rm(installDir, { force: true, recursive: true })
    }
  })

  it('falls back to npmjs packuments without proxying tarballs', async () => {
    const fetchCalls: Array<{ headers: Headers; method: string; url: string }> =
      []
    const fetchMock: typeof fetch = (input, init) => {
      const request = {
        headers: new Headers(init?.headers),
        method: init?.method ?? 'GET',
        url: String(input),
      }
      fetchCalls.push(request)

      if (request.headers.get('if-none-match') === '"upstream-etag"') {
        return Promise.resolve(
          new Response(null, {
            headers: {
              'cache-control': 'public, max-age=300',
              etag: '"upstream-etag"',
            },
            status: 304,
          }),
        )
      }

      return Promise.resolve(
        Response.json(
          {
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
          },
          {
            headers: {
              'cache-control': 'public, max-age=300',
              etag: '"upstream-etag"',
            },
          },
        ),
      )
    }
    const app = createRegestaApp(createMemoryRegistryAdapters(), {
      npmUpstreamFetch: fetchMock,
    })

    const packument = await app.request(
      'http://npm.registry.test/@upstream/pkg',
    )

    expect(packument.status).toBe(200)
    expect(packument.headers.get('cache-control')).toBe('public, max-age=300')
    expect(packument.headers.get('etag')).toBe('"upstream-etag"')
    expect(fetchCalls.map((request) => request.url)).toEqual([
      'https://registry.npmjs.org/%40upstream%2Fpkg',
    ])
    expect(fetchCalls[0]!.headers.get('accept')).toBe('application/json')
    expect(fetchCalls[0]!.method).toBe('GET')
    await expect(packument.json()).resolves.toMatchObject({
      name: '@upstream/pkg',
      versions: {
        '1.0.0': {
          dist: {
            tarball: 'https://registry.npmjs.org/@upstream/pkg/-/pkg-1.0.0.tgz',
          },
        },
      },
    })

    const conditionalPackument = await app.request(
      'http://npm.registry.test/@upstream/pkg',
      {
        headers: {
          'if-modified-since': 'Tue, 09 Jun 2026 00:00:00 GMT',
          'if-none-match': '"upstream-etag"',
        },
      },
    )

    expect(conditionalPackument.status).toBe(304)
    expect(conditionalPackument.headers.get('cache-control')).toBe(
      'public, max-age=300',
    )
    expect(conditionalPackument.headers.get('etag')).toBe('"upstream-etag"')
    expect(fetchCalls.at(-1)?.headers.get('if-modified-since')).toBe(
      'Tue, 09 Jun 2026 00:00:00 GMT',
    )
    expect(fetchCalls.at(-1)?.headers.get('if-none-match')).toBe(
      '"upstream-etag"',
    )

    const headPackument = await app.request(
      'http://npm.registry.test/@upstream/pkg',
      {
        method: 'HEAD',
      },
    )

    expect(headPackument.status).toBe(200)
    expect(headPackument.headers.get('etag')).toBe('"upstream-etag"')
    expect(await headPackument.text()).toBe('')
    expect(fetchCalls.at(-1)?.method).toBe('HEAD')

    const manifest = await app.request(
      'http://npm.registry.test/@upstream/pkg/latest',
    )

    expect(manifest.status).toBe(200)
    expect(fetchCalls.at(-1)?.url).toBe(
      'https://registry.npmjs.org/%40upstream%2Fpkg/latest',
    )

    const unscopedManifest = await app.request(
      'http://npm.registry.test/tinyexec/latest',
    )

    expect(unscopedManifest.status).toBe(200)
    expect(fetchCalls.at(-1)?.url).toBe(
      'https://registry.npmjs.org/tinyexec/latest',
    )

    const distTags = await app.request(
      'http://npm.registry.test/-/package/@upstream/pkg/dist-tags',
    )

    expect(distTags.status).toBe(200)
    expect(fetchCalls.at(-1)?.url).toBe(
      'https://registry.npmjs.org/-/package/%40upstream%2Fpkg/dist-tags',
    )

    const tarball = await app.request(
      'http://npm.registry.test/@upstream/pkg/-/pkg-1.0.0.tgz',
    )

    expect(tarball.status).toBe(404)
    await expect(tarball.json()).resolves.toMatchObject({
      code: 'tarball_not_found',
      error: 'Tarball not found',
      message: 'Tarball not found',
    })
    expect(fetchCalls).toHaveLength(6)
  })

  it('logs upstream npm fallback failures while returning structured errors', async () => {
    const upstreamError = new Error('upstream timeout')
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const fetchMock: typeof fetch = () => Promise.reject(upstreamError)
    const app = createRegestaApp(createMemoryRegistryAdapters(), {
      npmUpstreamFetch: fetchMock,
    })

    try {
      const response = await app.request(
        'http://npm.registry.test/@upstream/pkg',
        {
          headers: {
            'x-request-id': 'upstream-fallback-001',
          },
        },
      )

      expect(response.status).toBe(502)
      expect(response.headers.get('x-request-id')).toBe('upstream-fallback-001')
      await expect(response.json()).resolves.toMatchObject({
        code: 'upstream_npm_registry_unavailable',
        error: 'Upstream npm registry unavailable',
        message: 'Upstream npm registry unavailable',
      })
      expect(consoleError).toHaveBeenCalledWith(
        'Upstream npm registry request failed',
        expect.objectContaining({
          error: upstreamError,
          kind: 'regesta.npm-upstream-failure',
          requestId: 'upstream-fallback-001',
          url: 'https://registry.npmjs.org/%40upstream%2Fpkg',
        }),
      )
    } finally {
      consoleError.mockRestore()
    }
  })

  it('resolves npm tag endpoints through event-replayed projected dist-tags', async () => {
    const adapters = createMemoryRegistryAdapters()
    const app = createRegestaApp(adapters)
    const packageId = 'npm:example.com/stale-channel'

    await publishRelease(
      {
        artifacts: [
          {
            bytes: bytes('install artifact'),
            mediaType: 'application/gzip',
            role: 'install',
          },
        ],
        config: {
          id: packageId,
          source: {
            include: ['regesta.json'],
          },
          version: '1.0.0',
        },
        createdAt: '2026-06-01T00:00:00.000Z',
        source: bytes('source archive'),
      },
      adapters,
    )
    adapters.database.getPackageChannels = () =>
      Promise.reject(new Error('npm projection should not read channel views'))

    const distTags = await app.request(
      'http://npm.registry.test/-/package/@example.com/stale-channel/dist-tags',
    )
    const manifest = await app.request(
      'http://npm.registry.test/@example.com/stale-channel/latest',
    )

    expect(distTags.status).toBe(200)
    await expect(distTags.json()).resolves.toEqual({
      latest: '1.0.0',
    })
    expect(manifest.status).toBe(200)
    await expect(manifest.json()).resolves.toMatchObject({
      name: '@example.com/stale-channel',
      version: '1.0.0',
    })
  })

  it('derives npm packument modified time from channel events without changing version times', async () => {
    const adapters = createMemoryRegistryAdapters()
    const app = createRegestaApp(adapters)
    const packageId = 'npm:example.com/channel-time'

    await publishRelease(
      {
        artifacts: [
          {
            bytes: bytes('install artifact 1.0.0'),
            mediaType: 'application/gzip',
            role: 'install',
          },
        ],
        config: {
          id: packageId,
          source: {
            include: ['regesta.json'],
          },
          version: '1.0.0',
        },
        createdAt: '2026-06-01T00:00:00.000Z',
        source: bytes('source archive 1.0.0'),
      },
      adapters,
    )
    await publishRelease(
      {
        artifacts: [
          {
            bytes: bytes('install artifact 1.1.0'),
            mediaType: 'application/gzip',
            role: 'install',
          },
        ],
        config: {
          id: packageId,
          source: {
            include: ['regesta.json'],
          },
          version: '1.1.0',
        },
        createdAt: '2026-06-02T00:00:00.000Z',
        source: bytes('source archive 1.1.0'),
      },
      adapters,
    )
    await updatePackageChannel(adapters, {
      channel: 'latest',
      packageId,
      timestamp: '2026-06-03T00:00:00.000Z',
      version: '1.0.0',
    })

    const response = await app.request(
      'http://npm.registry.test/@example.com/channel-time',
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      'dist-tags': {
        latest: '1.0.0',
      },
      time: {
        '1.0.0': '2026-06-01T00:00:00.000Z',
        '1.1.0': '2026-06-02T00:00:00.000Z',
        created: '2026-06-01T00:00:00.000Z',
        modified: '2026-06-03T00:00:00.000Z',
      },
    })
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

function publishArtifactDescriptorDigest(
  artifacts: Array<{
    bytes: Uint8Array
    compatibility?: unknown
    filename?: string
    format?: string
    mediaType: string
    role: string
  }>,
) {
  return releasePublishArtifactDescriptorDigest(
    artifacts.map((artifact) => ({
      ...(artifact.compatibility === undefined
        ? {}
        : { compatibility: artifact.compatibility }),
      digest: sha256(artifact.bytes),
      ...(artifact.filename === undefined
        ? {}
        : { filename: artifact.filename }),
      ...(artifact.format === undefined ? {} : { format: artifact.format }),
      mediaType: artifact.mediaType,
      role: artifact.role,
    })),
  )
}

function createSignedPublishForm(input: {
  auth: ReturnType<typeof createTestDomainAuth>
  nonce: string
  prepared: Awaited<ReturnType<typeof prepareFixtureNpmPublish>>
  timestamp: string
}): FormData {
  const form = new FormData()
  const artifacts = input.prepared.artifacts.map((artifact, index) => ({
    filename: artifact.filename,
    format: artifact.format,
    mediaType: artifact.mediaType,
    part: `artifact.${index}`,
    role: artifact.role,
  }))

  form.set('config', JSON.stringify(input.prepared.config))
  form.set(
    'authorization',
    JSON.stringify(
      input.auth.sign(
        createReleasePublishIntent({
          artifactDescriptorDigest: publishArtifactDescriptorDigest(
            input.prepared.artifacts,
          ),
          artifactDigests: input.prepared.artifacts.map((artifact) =>
            sha256(artifact.bytes),
          ),
          configDigest: configDigest(input.prepared.config),
          nonce: input.nonce,
          packageId: input.prepared.config.id,
          sourceDigest: sha256(input.prepared.source),
          timestamp: input.timestamp,
          version: input.prepared.config.version,
        }),
      ),
    ),
  )
  form.set('createdAt', input.timestamp)
  form.set('source', new File([blobPart(input.prepared.source)], 'source.tgz'))
  form.set('artifacts', JSON.stringify(artifacts))

  input.prepared.artifacts.forEach((artifact, index) => {
    form.set(
      `artifact.${index}`,
      new File([blobPart(artifact.bytes)], artifact.filename, {
        type: artifact.mediaType,
      }),
    )
  })

  return form
}

function invalidPackageManifestTarball(): Uint8Array {
  return gzipSync(tarArchiveFile('package/package.json', bytes('{')))
}

function packageManifestTarball(value: Record<string, unknown>): Uint8Array {
  return gzipSync(
    tarArchiveFile('package/package.json', bytes(`${JSON.stringify(value)}\n`)),
  )
}

function tarArchiveFile(path: string, content: Uint8Array): Uint8Array {
  const header = new Uint8Array(512)

  writeTarString(header, 0, 100, path)
  writeTarOctal(header, 100, 8, 0o644)
  writeTarOctal(header, 108, 8, 0)
  writeTarOctal(header, 116, 8, 0)
  writeTarOctal(header, 124, 12, content.byteLength)
  writeTarOctal(header, 136, 12, 0)
  header.fill(0x20, 148, 156)
  header[156] = 0x30
  writeTarString(header, 257, 6, 'ustar')
  writeTarString(header, 263, 2, '00')
  writeTarChecksum(header)

  const paddedSize = Math.ceil(content.byteLength / 512) * 512
  const output = new Uint8Array(512 + paddedSize + 1024)
  output.set(header)
  output.set(content, 512)

  return output
}

function writeTarString(
  output: Uint8Array,
  offset: number,
  length: number,
  value: string,
): void {
  for (let index = 0; index < Math.min(value.length, length); index++) {
    output[offset + index] = value.codePointAt(index)!
  }
}

function writeTarOctal(
  output: Uint8Array,
  offset: number,
  length: number,
  value: number,
): void {
  writeTarString(
    output,
    offset,
    length,
    `${value.toString(8).padStart(length - 1, '0')}\0`,
  )
}

function writeTarChecksum(header: Uint8Array): void {
  const checksum = header.reduce((sum, value) => sum + value, 0)
  writeTarString(header, 148, 8, `${checksum.toString(8).padStart(6, '0')}\0 `)
}

function withoutDescription(config: RegestaConfig): RegestaConfig {
  const output: RegestaConfig = { ...config }
  delete output.description
  return output
}

const devLocalhostFetch: typeof fetch = (input) => {
  if (String(input) !== 'http://dev.localhost:4321/.well-known/regesta.json') {
    return Promise.resolve(new Response(null, { status: 404 }))
  }

  return Promise.resolve(Response.json(devLocalhostDomainBinding))
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

async function listenForNpmInstall(
  app: ReturnType<typeof createRegestaApp>,
): Promise<{
  close: () => Promise<void>
  origin: string
}> {
  const server = createServer(async (request, response) => {
    try {
      const host = request.headers.host ?? 'npm.localhost'
      const requestUrl = new URL(request.url ?? '/', `http://${host}`)
      const appResponse = await app.fetch(
        new Request(requestUrl, {
          headers: nodeRequestHeaders(request.headers),
          method: request.method ?? 'GET',
        }),
      )

      response.statusCode = appResponse.status
      response.statusMessage = appResponse.statusText
      appResponse.headers.forEach((value, name) => {
        response.setHeader(name, value)
      })

      if (request.method === 'HEAD' || !appResponse.body) {
        response.end()
        return
      }

      response.end(Buffer.from(await appResponse.arrayBuffer()))
    } catch (error) {
      response.statusCode = 500
      response.end(error instanceof Error ? error.message : 'Internal Error')
    }
  })

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = () => {
      server.off('error', onError)
      resolve()
    }

    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(0)
  })

  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('npm install test server did not expose a TCP port')
  }

  return {
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error)
            return
          }

          resolve()
        })
      }),
    origin: `http://npm.localhost:${address.port}`,
  }
}

function nodeRequestHeaders(headers: IncomingHttpHeaders): Headers {
  const output = new Headers()

  for (const [name, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        output.append(name, item)
      }
    } else if (value !== undefined) {
      output.set(name, value)
    }
  }

  return output
}

async function prepareFixtureNpmPublish(projectDir: string): Promise<{
  artifacts: Array<{
    bytes: Uint8Array
    filename: string
    format: string
    mediaType: string
    role: string
  }>
  config: RegestaConfig
  source: Uint8Array
}> {
  const config: RegestaConfig = {
    description: 'Fixture package',
    exports: {
      '.': './src/index.ts',
    },
    id: 'npm:example.com/hello-regesta',
    provenance: {
      level: 'source-attached',
    },
    source: {
      include: ['regesta.json', 'package.json', 'src'],
    },
    version: '0.0.1',
  }
  const outputDir = await mkdtemp(
    join(tmpdir(), 'regesta-server-test-package-'),
  )

  try {
    await execFileAsync('npm', ['pack', '--pack-destination', outputDir], {
      cwd: projectDir,
    })

    const tarballs = (await readdir(outputDir)).filter((file) =>
      file.endsWith('.tgz'),
    )

    if (tarballs.length !== 1) {
      throw new Error(
        `Expected one npm fixture tarball, found ${tarballs.length}`,
      )
    }

    const filename = tarballs[0]!

    return {
      artifacts: [
        {
          bytes: await readFile(join(outputDir, filename)),
          filename,
          format: 'npm-tarball',
          mediaType: 'application/gzip',
          role: 'install',
        },
      ],
      config,
      source: bytes('source archive'),
    }
  } finally {
    await rm(outputDir, { force: true, recursive: true })
  }
}

interface FixtureProjectOptions {
  dependencies?: boolean
}

async function createFixtureProject(
  options: FixtureProjectOptions = {},
): Promise<string> {
  const root = join(
    process.cwd(),
    'node_modules',
    '.tmp-regesta-server-test',
    `${Date.now()}-${Math.random().toString(16).slice(2)}`,
  )
  const packageJson: Record<string, unknown> = {
    description: 'Fixture package',
    exports: {
      '.': './src/index.ts',
    },
    name: '@example.com/hello-regesta',
    packageManager: 'npm@11.5.0',
    version: '0.0.1',
  }

  if (options.dependencies ?? true) {
    packageJson.dependencies = {
      '@example.com/base': '^1.0.0',
    }
  }

  await mkdir(join(root, 'src'), { recursive: true })
  await writeFile(join(root, 'src', 'index.ts'), 'export const value = 1\n')
  await writeFile(
    join(root, 'package.json'),
    `${JSON.stringify(packageJson, null, 2)}\n`,
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
