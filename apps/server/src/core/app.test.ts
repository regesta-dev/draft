import { Buffer } from 'node:buffer'
import { createMemoryRegistryAdapters } from '@regesta/adapters'
import { sha256, type WriteAuthorizationProof } from '@regesta/protocol'
import { describe, expect, it } from 'vitest'
import { createCoreRegistryApp, type CoreRegistryServices } from './app.ts'

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
})

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
