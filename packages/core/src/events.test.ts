import { describe, expect, it } from 'vitest'
import { assertRegistryEventSemantics } from './events.ts'

describe('assertRegistryEventSemantics', () => {
  it('accepts current event types for future ecosystem package ids', () => {
    const packageId = 'maven:example.com/group/artifact'

    for (const event of [
      {
        artifactDigests: [
          'sha256:1111111111111111111111111111111111111111111111111111111111111111',
        ],
        channel: 'latest',
        eventType: 'release.published',
        id: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
        object: 'regesta.event',
        release: {
          id: packageId,
          manifestDigest:
            'sha256:2222222222222222222222222222222222222222222222222222222222222222',
          version: '1.0.0',
        },
        sourceDigest:
          'sha256:3333333333333333333333333333333333333333333333333333333333333333',
        timestamp: '2026-06-01T00:00:00.000Z',
      },
      {
        channel: 'latest',
        eventType: 'channel.updated',
        id: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
        object: 'regesta.event',
        package: packageId,
        previousVersion: '1.0.0',
        timestamp: '2026-06-02T00:00:00.000Z',
        version: '1.1.0',
      },
      {
        channel: 'latest',
        eventType: 'channel.deleted',
        id: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
        object: 'regesta.event',
        package: packageId,
        previousVersion: '1.1.0',
        timestamp: '2026-06-03T00:00:00.000Z',
      },
    ]) {
      expect(() => assertRegistryEventSemantics(event)).not.toThrow()
    }
  })

  it('accepts authorization proofs for future ecosystem owner domains', () => {
    const packageId = 'maven:example.com/group/artifact'

    for (const event of [
      {
        artifactDigests: [
          'sha256:1111111111111111111111111111111111111111111111111111111111111111',
        ],
        authorization: authorizationProof('2026-06-01T00:00:00.000Z'),
        channel: 'latest',
        eventType: 'release.published',
        id: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
        object: 'regesta.event',
        release: {
          id: packageId,
          manifestDigest:
            'sha256:2222222222222222222222222222222222222222222222222222222222222222',
          version: '1.0.0',
        },
        sourceDigest:
          'sha256:3333333333333333333333333333333333333333333333333333333333333333',
        timestamp: '2026-06-01T00:00:00.000Z',
      },
      {
        authorization: authorizationProof('2026-06-02T00:00:00.000Z'),
        channel: 'latest',
        eventType: 'channel.updated',
        id: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
        object: 'regesta.event',
        package: packageId,
        previousVersion: '1.0.0',
        timestamp: '2026-06-02T00:00:00.000Z',
        version: '1.1.0',
      },
      {
        authorization: authorizationProof('2026-06-03T00:00:00.000Z'),
        channel: 'latest',
        eventType: 'channel.deleted',
        id: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
        object: 'regesta.event',
        package: packageId,
        previousVersion: '1.1.0',
        timestamp: '2026-06-03T00:00:00.000Z',
      },
    ]) {
      expect(() => assertRegistryEventSemantics(event)).not.toThrow()
    }
  })

  it('rejects authorization proof domains that do not match future ecosystem owners', () => {
    expect(() =>
      assertRegistryEventSemantics({
        authorization: authorizationProof('2026-06-02T00:00:00.000Z', {
          domain: 'other.example.com',
        }),
        channel: 'latest',
        eventType: 'channel.updated',
        id: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
        object: 'regesta.event',
        package: 'maven:example.com/group/artifact',
        previousVersion: '1.0.0',
        timestamp: '2026-06-02T00:00:00.000Z',
        version: '1.1.0',
      }),
    ).toThrow(
      'Registry event authorization domain does not match package owner',
    )
  })

  it('rejects unsupported event types even without digest validation', () => {
    expect(() =>
      assertRegistryEventSemantics(
        JSON.parse(
          `{
            "eventType": "package.deleted",
            "id": "sha256:0000000000000000000000000000000000000000000000000000000000000000",
            "object": "regesta.event",
            "package": "npm:example.com/hello-regesta",
            "timestamp": "2026-06-01T00:00:00.000Z"
          }`,
        ),
      ),
    ).toThrow('Unsupported registry event type')
  })
})

function authorizationProof(
  signedAt: string,
  options: { domain?: string } = {},
) {
  return {
    alg: 'EdDSA',
    domain: options.domain ?? 'example.com',
    kid: 'publish-key',
    object: 'regesta.authorization-proof',
    payloadDigest:
      'sha256:4444444444444444444444444444444444444444444444444444444444444444',
    publicKeyJwk: {
      crv: 'Ed25519',
      kty: 'OKP',
      x: 'A'.repeat(43),
    },
    signature: 'A'.repeat(86),
    signedAt,
    wellKnownDigest:
      'sha256:5555555555555555555555555555555555555555555555555555555555555555',
  }
}
