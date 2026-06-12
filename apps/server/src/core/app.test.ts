import { Buffer } from 'node:buffer'
import { createMemoryRegistryAdapters } from '@regesta/adapters'
import { sha256, type WriteAuthorizationProof } from '@regesta/protocol'
import { describe, expect, it, vi } from 'vitest'
import {
  createCoreRegistryApp,
  type CoreRegistryAuditEntry,
  type CoreRegistryServices,
} from './app.ts'

describe('createCoreRegistryApp', () => {
  it('passes public Host-header request URLs to write authorization services', async () => {
    const adapters = createMemoryRegistryAdapters()
    const capturedRequestUrls: string[] = []
    const signedAt = '2026-06-01T00:00:00.000Z'
    const services: CoreRegistryServices = {
      readWriteAuthorization: (authorization) => authorization,
      verifyChannelDeleteAuthorization: (input) => {
        capturedRequestUrls.push(input.requestUrl)

        return Promise.resolve(authorizationProof('channel-delete', signedAt))
      },
      verifyChannelUpdateAuthorization: (input) => {
        capturedRequestUrls.push(input.requestUrl)

        return Promise.resolve(authorizationProof('channel-update', signedAt))
      },
      verifyPublishAuthorization: (input) => {
        capturedRequestUrls.push(input.requestUrl)

        return Promise.resolve(authorizationProof('publish', signedAt))
      },
    }
    const app = createCoreRegistryApp(adapters, services)
    const packageId = 'npm:example.com/host-write-url'
    const packagePath = encodeURIComponent(packageId)
    const publish = await app.request('http://127.0.0.1:4321/releases', {
      body: publishForm({
        id: packageId,
        signedAt,
        version: '0.0.1',
      }),
      headers: {
        host: 'registry.example:8443',
      },
      method: 'POST',
    })

    expect(publish.status).toBe(201)

    const update = await app.request(
      `http://127.0.0.1:4321/packages/${packagePath}/channels/latest`,
      {
        body: JSON.stringify({
          authorization: {},
          version: '0.0.1',
        }),
        headers: {
          'content-type': 'application/json',
          host: 'registry.example:8443',
        },
        method: 'PUT',
      },
    )

    expect(update.status).toBe(200)

    const remove = await app.request(
      `http://127.0.0.1:4321/packages/${packagePath}/channels/latest`,
      {
        body: JSON.stringify({
          authorization: {},
        }),
        headers: {
          'content-type': 'application/json',
          host: 'registry.example:8443',
        },
        method: 'DELETE',
      },
    )

    expect(remove.status).toBe(200)
    expect(capturedRequestUrls).toEqual([
      'http://registry.example:8443/releases',
      `http://registry.example:8443/packages/${packagePath}/channels/latest`,
      `http://registry.example:8443/packages/${packagePath}/channels/latest`,
    ])
  })

  it('uses package event heads for conditional package state reads', async () => {
    const adapters = createMemoryRegistryAdapters()
    const signedAt = '2026-06-01T00:00:00.000Z'
    const services = coreRegistryServices(signedAt)
    const app = createCoreRegistryApp(adapters, services)
    const packageId = 'npm:example.com/conditional-state'
    const packagePath = encodeURIComponent(packageId)
    const publish = await app.request('http://127.0.0.1:4321/releases', {
      body: publishForm({
        id: packageId,
        signedAt,
        version: '0.0.1',
      }),
      method: 'POST',
    })
    const published = (await publish.json()) as {
      event: {
        id: string
      }
    }
    const getPackageEventHead = vi.spyOn(
      adapters.database,
      'getPackageEventHead',
    )
    const getPackageEventState = vi.spyOn(
      adapters.database,
      'getPackageEventState',
    )
    const etag = `W/"${published.event.id}"`
    const lastModified = new Date(Date.parse(signedAt)).toUTCString()

    const conditionalEtag = await app.request(`/packages/${packagePath}`, {
      headers: {
        'if-none-match': etag,
      },
    })

    expect(conditionalEtag.status).toBe(304)
    expect(conditionalEtag.headers.get('cache-control')).toBe('no-cache')
    expect(conditionalEtag.headers.get('etag')).toBe(etag)
    expect(conditionalEtag.headers.get('last-modified')).toBe(lastModified)
    expect(await conditionalEtag.text()).toBe('')
    expect(getPackageEventHead).toHaveBeenCalledOnce()
    expect(getPackageEventHead).toHaveBeenCalledWith(packageId)
    expect(getPackageEventState).not.toHaveBeenCalled()

    getPackageEventHead.mockClear()
    getPackageEventState.mockClear()

    const conditionalModified = await app.request(`/packages/${packagePath}`, {
      headers: {
        'if-modified-since': lastModified,
      },
    })

    expect(conditionalModified.status).toBe(304)
    expect(conditionalModified.headers.get('etag')).toBe(etag)
    expect(conditionalModified.headers.get('last-modified')).toBe(lastModified)
    expect(await conditionalModified.text()).toBe('')
    expect(getPackageEventHead).toHaveBeenCalledOnce()
    expect(getPackageEventHead).toHaveBeenCalledWith(packageId)
    expect(getPackageEventState).not.toHaveBeenCalled()

    getPackageEventHead.mockClear()
    getPackageEventState.mockClear()

    const staleEtag = await app.request(`/packages/${packagePath}`, {
      headers: {
        'if-modified-since': lastModified,
        'if-none-match': 'W/"stale"',
      },
    })

    expect(staleEtag.status).toBe(200)
    expect(staleEtag.headers.get('etag')).toBe(etag)
    expect(staleEtag.headers.get('last-modified')).toBe(lastModified)
    expect(getPackageEventHead).toHaveBeenCalledOnce()
    expect(getPackageEventState).toHaveBeenCalledOnce()
  })

  it('serves collection HEAD requests without listing collection contents', async () => {
    const adapters = createMemoryRegistryAdapters()
    adapters.database.listEvents = () => {
      throw new Error('event collection HEAD must not list events')
    }
    adapters.objects.listDescriptors = () => {
      throw new Error('object collection HEAD must not list descriptors')
    }
    const app = createCoreRegistryApp(
      adapters,
      coreRegistryServices('2026-06-01T00:00:00.000Z'),
    )

    const events = await app.request('/events', {
      method: 'HEAD',
    })
    const objects = await app.request('/objects', {
      method: 'HEAD',
    })

    expect(events.status).toBe(200)
    expect(events.headers.get('cache-control')).toBe('no-cache')
    expect(events.headers.get('content-type')).toBe(
      'application/json; charset=UTF-8',
    )
    expect(events.headers.get('content-length')).toBeNull()
    expect(await events.text()).toBe('')
    expect(objects.status).toBe(200)
    expect(objects.headers.get('cache-control')).toBe('no-cache')
    expect(objects.headers.get('content-type')).toBe(
      'application/json; charset=UTF-8',
    )
    expect(objects.headers.get('content-length')).toBeNull()
    expect(await objects.text()).toBe('')
  })

  it('serves HEAD error responses without JSON bodies', async () => {
    const app = createCoreRegistryApp(
      createMemoryRegistryAdapters(),
      coreRegistryServices('2026-06-01T00:00:00.000Z'),
    )
    const digest = sha256(Buffer.from('missing object'))

    const event = await app.request(`/events/${digest.replace(':', '/')}`, {
      method: 'HEAD',
    })
    const object = await app.request(`/objects/${digest}`, {
      method: 'HEAD',
    })
    const release = await app.request(
      `/packages/${encodeURIComponent('npm:example.com/missing')}/releases/0.0.1`,
      {
        method: 'HEAD',
      },
    )

    for (const response of [event, object, release]) {
      expect(response.status).toBe(404)
      expect(response.headers.get('content-type')).toBe(
        'application/json; charset=UTF-8',
      )
      expect(response.headers.get('content-length')).toBeNull()
      expect(await response.text()).toBe('')
    }
  })

  it('uses single-channel adapter reads for package channel routes', async () => {
    const adapters = createMemoryRegistryAdapters()
    const signedAt = '2026-06-01T00:00:00.000Z'
    const app = createCoreRegistryApp(adapters, coreRegistryServices(signedAt))
    const packageId = 'npm:example.com/channel-route'
    const packagePath = encodeURIComponent(packageId)
    const publish = await app.request('http://127.0.0.1:4321/releases', {
      body: publishForm({
        id: packageId,
        signedAt,
        version: '0.0.1',
      }),
      method: 'POST',
    })

    expect(publish.status).toBe(201)

    const getPackageChannelVersion = vi.spyOn(
      adapters.database,
      'getPackageChannelVersion',
    )
    const getPackageChannels = vi.spyOn(adapters.database, 'getPackageChannels')
    const channel = await app.request(
      `/packages/${packagePath}/channels/latest`,
    )

    expect(channel.status).toBe(200)
    await expect(channel.json()).resolves.toMatchObject({
      manifest: {
        id: packageId,
        version: '0.0.1',
      },
    })
    expect(getPackageChannelVersion).toHaveBeenCalledOnce()
    expect(getPackageChannelVersion).toHaveBeenCalledWith(packageId, 'latest')
    expect(getPackageChannels).not.toHaveBeenCalled()
  })

  it('does not record invalid raw request ids in core audit entries', async () => {
    const entries: CoreRegistryAuditEntry[] = []
    const adapters = createMemoryRegistryAdapters()
    const signedAt = '2026-06-01T00:00:00.000Z'
    const services = coreRegistryServices(signedAt)
    const app = createCoreRegistryApp(adapters, services, {
      auditLog: (entry) => {
        entries.push(entry)
      },
    })
    const publish = await app.request('/releases', {
      body: publishForm({
        id: 'npm:example.com/invalid-audit-request-id',
        signedAt,
        version: '0.0.1',
      }),
      headers: {
        'x-request-id': 'invalid request id',
      },
      method: 'POST',
    })

    expect(publish.status).toBe(201)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toEqual(
      expect.not.objectContaining({
        requestId: 'invalid request id',
      }),
    )
  })
})

function coreRegistryServices(signedAt: string): CoreRegistryServices {
  return {
    readWriteAuthorization: (authorization) => authorization,
    verifyChannelDeleteAuthorization: () => {
      return Promise.resolve(authorizationProof('channel-delete', signedAt))
    },
    verifyChannelUpdateAuthorization: () => {
      return Promise.resolve(authorizationProof('channel-update', signedAt))
    },
    verifyPublishAuthorization: () => {
      return Promise.resolve(authorizationProof('publish', signedAt))
    },
  }
}

function publishForm(input: {
  id: string
  signedAt: string
  version: string
}): FormData {
  const form = new FormData()
  const source = new Uint8Array([1])
  const artifact = new Uint8Array([2])

  form.set(
    'config',
    JSON.stringify({
      id: input.id,
      source: {
        include: ['regesta.json'],
      },
      version: input.version,
    }),
  )
  form.set('authorization', JSON.stringify({}))
  form.set('createdAt', input.signedAt)
  form.set('source', new File([source], 'source.tgz'))
  form.set(
    'artifacts',
    JSON.stringify([
      {
        mediaType: 'application/gzip',
        part: 'artifact.0',
        role: 'install',
      },
    ]),
  )
  form.set('artifact.0', new File([artifact], 'host-write-url.tgz'))

  return form
}

function authorizationProof(
  seed: string,
  signedAt: string,
): WriteAuthorizationProof {
  const signature = Buffer.alloc(64, seed.length).toString('base64url')

  return {
    alg: 'EdDSA',
    domain: 'example.com',
    kid: 'ed25519:test',
    object: 'regesta.authorization-proof',
    payloadDigest: sha256(new TextEncoder().encode(`${seed}:payload`)),
    publicKeyJwk: {
      crv: 'Ed25519',
      kty: 'OKP',
      x: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    },
    signature,
    signedAt,
    wellKnownDigest: sha256(new TextEncoder().encode(`${seed}:binding`)),
  }
}
