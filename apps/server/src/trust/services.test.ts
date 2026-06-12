import { generateKeyPairSync } from 'node:crypto'
import {
  createChannelDeleteIntent,
  createChannelUpdateIntent,
  createReleasePublishIntent,
  createWriteAuthorization,
  releasePublishArtifactDescriptorDigest,
  type DomainBinding,
  type Ed25519PrivateKeyJwk,
  type Ed25519PublicKeyJwk,
  type WriteIntent,
} from '@regesta/auth'
import { sha256 } from '@regesta/protocol'
import { describe, expect, it } from 'vitest'
import { createTrustServices } from './services.ts'

describe('createTrustServices', () => {
  it('forwards disabled domain binding fetch timeouts to all write verifiers', async () => {
    const fixture = createTrustFixture()
    const capturedSignals: Array<AbortSignal | null | undefined> = []
    const capturedRequestUrls: string[] = []
    const fetchBinding: typeof fetch = (_input, init) => {
      capturedSignals.push(init?.signal)

      return Promise.resolve(Response.json(fixture.binding))
    }
    const services = createTrustServices({
      domainBindingFetchForRequest(requestUrl) {
        capturedRequestUrls.push(requestUrl)

        return fetchBinding
      },
      domainBindingFetchTimeoutMs: 0,
    })
    const artifacts = [
      {
        bytes: bytes('install artifact'),
        mediaType: 'application/octet-stream',
        role: 'install',
      },
    ]
    const source = bytes('source archive')
    const configDigest = sha256(bytes('config'))
    const packageId = 'npm:example.com/trust-service'
    const timestamp = new Date().toISOString()

    await expect(
      services.verifyPublishAuthorization({
        artifacts,
        authorization: fixture.sign(
          createReleasePublishIntent({
            artifactDescriptorDigest: releasePublishArtifactDescriptorDigest(
              artifacts.map((artifact) => ({
                digest: sha256(artifact.bytes),
                mediaType: artifact.mediaType,
                role: artifact.role,
              })),
            ),
            artifactDigests: artifacts.map((artifact) =>
              sha256(artifact.bytes),
            ),
            configDigest,
            nonce: 'trust-service-publish',
            packageId,
            sourceDigest: sha256(source),
            timestamp,
            version: '0.0.1',
          }),
        ),
        configDigest,
        packageId,
        requestUrl: 'http://registry.test/releases',
        source,
        version: '0.0.1',
      }),
    ).resolves.toMatchObject({
      domain: 'example.com',
      kid: 'ed25519:test',
    })

    await expect(
      services.verifyChannelUpdateAuthorization({
        authorization: fixture.sign(
          createChannelUpdateIntent({
            channel: 'latest',
            nonce: 'trust-service-channel-update',
            packageId,
            previousVersion: '0.0.1',
            timestamp,
            version: '0.0.2',
          }),
        ),
        channel: 'latest',
        packageId,
        previousVersion: '0.0.1',
        requestUrl:
          'http://registry.test/packages/npm:example.com/trust-service/channels/latest',
        version: '0.0.2',
      }),
    ).resolves.toMatchObject({
      domain: 'example.com',
      kid: 'ed25519:test',
    })

    await expect(
      services.verifyChannelDeleteAuthorization({
        authorization: fixture.sign(
          createChannelDeleteIntent({
            channel: 'latest',
            nonce: 'trust-service-channel-delete',
            packageId,
            previousVersion: '0.0.2',
            timestamp,
          }),
        ),
        channel: 'latest',
        packageId,
        previousVersion: '0.0.2',
        requestUrl:
          'http://registry.test/packages/npm:example.com/trust-service/channels/latest',
      }),
    ).resolves.toMatchObject({
      domain: 'example.com',
      kid: 'ed25519:test',
    })

    expect(capturedSignals).toEqual([undefined, undefined, undefined])
    expect(capturedRequestUrls).toEqual([
      'http://registry.test/releases',
      'http://registry.test/packages/npm:example.com/trust-service/channels/latest',
      'http://registry.test/packages/npm:example.com/trust-service/channels/latest',
    ])
  })

  it('rejects invalid domain binding fetch timeout configuration', () => {
    expect(() =>
      createTrustServices({
        domainBindingFetchTimeoutMs: -1,
      }),
    ).toThrow(
      'Domain binding fetch timeout must be a non-negative safe integer',
    )
  })
})

function createTrustFixture(): {
  binding: DomainBinding
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
  }

  return {
    binding,
    sign: (intent) =>
      createWriteAuthorization(intent, {
        kid: 'ed25519:test',
        privateKeyJwk,
      }),
  }
}

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value)
}

function normalizePrivateKeyJwk(value: unknown): Ed25519PrivateKeyJwk {
  if (!isRecord(value)) {
    throw new Error('private key JWK must be an object')
  }

  if (
    value.crv !== 'Ed25519' ||
    typeof value.d !== 'string' ||
    value.kty !== 'OKP' ||
    typeof value.x !== 'string'
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
    value.crv !== 'Ed25519' ||
    value.kty !== 'OKP' ||
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
