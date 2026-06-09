import { Buffer } from 'node:buffer'
import { generateKeyPairSync } from 'node:crypto'
import { canonicalJson, sha256 } from '@regesta/protocol'
import { describe, expect, it, vi } from 'vitest'
import {
  createChannelDeleteIntent,
  createChannelUpdateIntent,
  createReleasePublishIntent,
  createWriteAuthorization,
  domainBindingUrl,
  ownerDomainFromPackageId,
  releasePublishArtifactDescriptorDigest,
  verifyPublishAuthorization,
  verifyWriteAuthorization,
  WriteAuthorizationError,
  type DomainBinding,
  type Ed25519PrivateKeyJwk,
  type Ed25519PublicKeyJwk,
  type WriteAuthorization,
} from './index.ts'

describe('verifyWriteAuthorization', () => {
  it('returns an auditable authorization proof for valid write signatures', async () => {
    const fixture = createAuthorizationFixture()
    const bindingText = JSON.stringify(fixture.binding)

    await expect(
      verifyWriteAuthorization({
        authorization: fixture.authorization,
        expectedIntent: fixture.intent,
        fetchBinding: () =>
          Promise.resolve(
            new Response(bindingText, {
              headers: {
                'content-type': 'application/json',
              },
            }),
          ),
        now: fixture.now,
      }),
    ).resolves.toEqual({
      alg: 'EdDSA',
      domain: 'example.com',
      kid: 'ed25519:test',
      object: 'regesta.authorization-proof',
      payloadDigest: sha256(canonicalJson(fixture.authorization.payload)),
      publicKeyJwk: fixture.binding.keys[0]!.publicKeyJwk,
      signature: fixture.authorization.signature,
      signedAt: fixture.authorization.payload.timestamp,
      specVersion: 0,
      wellKnownDigest: sha256(bindingText),
    })
  })

  it('rejects invalid domain binding JSON as an authorization error', async () => {
    const fixture = createAuthorizationFixture()

    await expect(
      verifyWriteAuthorization({
        authorization: fixture.authorization,
        expectedIntent: fixture.intent,
        fetchBinding: () =>
          Promise.resolve(
            new Response('{', {
              headers: {
                'content-type': 'application/json',
              },
            }),
          ),
        now: fixture.now,
      }),
    ).rejects.toMatchObject({
      message: 'Domain binding JSON is invalid',
      name: WriteAuthorizationError.name,
    })
  })

  it('rejects explicit non-JSON domain binding responses', async () => {
    const fixture = createAuthorizationFixture()

    await expect(
      verifyWriteAuthorization({
        authorization: fixture.authorization,
        expectedIntent: fixture.intent,
        fetchBinding: () =>
          Promise.resolve(
            new Response('<!doctype html>', {
              headers: {
                'content-type': 'text/html; charset=utf-8',
              },
            }),
          ),
        now: fixture.now,
      }),
    ).rejects.toMatchObject({
      message: 'Domain binding response must be JSON',
      name: WriteAuthorizationError.name,
    })
  })

  it('rejects unreadable domain binding responses as authorization errors', async () => {
    const fixture = createAuthorizationFixture()

    await expect(
      verifyWriteAuthorization({
        authorization: fixture.authorization,
        expectedIntent: fixture.intent,
        fetchBinding: () => Promise.resolve(unreadableResponse()),
        now: fixture.now,
      }),
    ).rejects.toMatchObject({
      issues: ['domain binding body unavailable'],
      message: 'Domain binding read failed',
      name: WriteAuthorizationError.name,
    })
  })

  it('fetches domain bindings without cache or credentials', async () => {
    const fixture = createAuthorizationFixture()
    let capturedInput: Parameters<typeof fetch>[0] | undefined
    let capturedInit: RequestInit | undefined

    await expect(
      verifyWriteAuthorization({
        authorization: fixture.authorization,
        expectedIntent: fixture.intent,
        fetchBinding: (input, init) => {
          capturedInput = input
          capturedInit = init

          return Promise.resolve(Response.json(fixture.binding))
        },
        now: fixture.now,
      }),
    ).resolves.toMatchObject({
      kid: 'ed25519:test',
    })

    expect(capturedInput).toBe('https://example.com/.well-known/regesta.json')
    expect(capturedInit?.cache).toBe('no-store')
    expect(capturedInit?.credentials).toBe('omit')
    expect(new Headers(capturedInit?.headers).get('accept')).toBe(
      'application/json',
    )
    expect(capturedInit?.method).toBe('GET')
    expect(capturedInit?.signal).toBeInstanceOf(AbortSignal)
  })

  it('aborts slow domain binding fetches as authorization errors', async () => {
    const fixture = createAuthorizationFixture()
    vi.useFakeTimers()

    try {
      const verification = verifyWriteAuthorization({
        authorization: fixture.authorization,
        expectedIntent: fixture.intent,
        fetchBinding: (_input, init) =>
          new Promise((_resolve, reject) => {
            const signal = init?.signal

            if (!(signal instanceof AbortSignal)) {
              reject(new Error('missing abort signal'))
              return
            }

            signal.addEventListener('abort', () => {
              reject(new Error('domain binding fetch aborted'))
            })
          }),
        now: fixture.now,
      })
      const rejected = expect(verification).rejects.toMatchObject({
        issues: ['domain binding fetch aborted'],
        message: 'Domain binding fetch failed',
        name: WriteAuthorizationError.name,
      })

      await vi.advanceTimersByTimeAsync(10 * 1000)
      await rejected
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects oversized domain binding responses', async () => {
    const fixture = createAuthorizationFixture()
    const oversizedBinding = 'x'.repeat(64 * 1024 + 1)

    await expect(
      verifyWriteAuthorization({
        authorization: fixture.authorization,
        expectedIntent: fixture.intent,
        fetchBinding: () =>
          Promise.resolve(
            new Response(oversizedBinding, {
              headers: {
                'content-type': 'application/json',
              },
            }),
          ),
        now: fixture.now,
      }),
    ).rejects.toMatchObject({
      message: 'Domain binding response is too large',
      name: WriteAuthorizationError.name,
    })
    await expect(
      verifyWriteAuthorization({
        authorization: fixture.authorization,
        expectedIntent: fixture.intent,
        fetchBinding: () =>
          Promise.resolve(
            new Response('', {
              headers: {
                'content-length': String(64 * 1024 + 1),
                'content-type': 'application/json',
              },
            }),
          ),
        now: fixture.now,
      }),
    ).rejects.toMatchObject({
      message: 'Domain binding response is too large',
      name: WriteAuthorizationError.name,
    })
  })

  it('rejects non-canonical domain binding domains', async () => {
    const fixture = createAuthorizationFixture()

    for (const domain of ['Example.com', 'example..com', '-example.com']) {
      await expect(
        verifyWriteAuthorization({
          authorization: fixture.authorization,
          expectedIntent: fixture.intent,
          fetchBinding: bindingFetch({
            ...fixture.binding,
            domain,
          }),
          now: fixture.now,
        }),
      ).rejects.toMatchObject({
        message: 'Domain must be a canonical DNS domain',
        name: WriteAuthorizationError.name,
      })
    }
  })

  it('rejects domain bindings from another owner domain', async () => {
    const fixture = createAuthorizationFixture()

    await expect(
      verifyWriteAuthorization({
        authorization: fixture.authorization,
        expectedIntent: fixture.intent,
        fetchBinding: bindingFetch({
          ...fixture.binding,
          domain: 'other.example.com',
        }),
        now: fixture.now,
      }),
    ).rejects.toMatchObject({
      message: 'Domain binding domain mismatch',
      name: WriteAuthorizationError.name,
    })
  })

  it('rejects invalid domain binding key timestamps', async () => {
    const fixture = createAuthorizationFixture()

    await expect(
      verifyWriteAuthorization({
        authorization: fixture.authorization,
        expectedIntent: fixture.intent,
        fetchBinding: bindingFetch({
          ...fixture.binding,
          keys: [
            {
              ...fixture.binding.keys[0]!,
              createdAt: 'not-a-date',
            },
          ],
        }),
        now: fixture.now,
      }),
    ).rejects.toMatchObject({
      message: 'createdAt timestamp is invalid',
      name: WriteAuthorizationError.name,
    })
  })

  it('rejects domain binding key windows with non-positive duration', async () => {
    const fixture = createAuthorizationFixture()

    await expect(
      verifyWriteAuthorization({
        authorization: fixture.authorization,
        expectedIntent: fixture.intent,
        fetchBinding: bindingFetch({
          ...fixture.binding,
          keys: [
            {
              ...fixture.binding.keys[0]!,
              createdAt: '2026-06-01T00:00:01.000Z',
              expiresAt: '2026-06-01T00:00:01.000Z',
            },
          ],
        }),
        now: fixture.now,
      }),
    ).rejects.toMatchObject({
      message: 'Domain binding key expiresAt must be after createdAt',
      name: WriteAuthorizationError.name,
    })
  })

  it('rejects ambiguous domain bindings with duplicate key ids', async () => {
    const fixture = createAuthorizationFixture()

    await expect(
      verifyWriteAuthorization({
        authorization: fixture.authorization,
        expectedIntent: fixture.intent,
        fetchBinding: bindingFetch({
          ...fixture.binding,
          keys: [
            fixture.binding.keys[0]!,
            {
              ...fixture.binding.keys[0]!,
              publicKeyJwk: {
                ...fixture.binding.keys[0]!.publicKeyJwk,
                x: Buffer.alloc(32, 3).toString('base64url'),
              },
            },
          ],
        }),
        now: fixture.now,
      }),
    ).rejects.toMatchObject({
      message: 'Domain binding key kid must be unique: ed25519:test',
      name: WriteAuthorizationError.name,
    })
  })

  it('rejects non-canonical write intent timestamps', async () => {
    const fixture = createAuthorizationFixture()
    const timestamp = '2026-06-01T00:00:00Z'
    const intent = {
      ...fixture.intent,
      timestamp,
    }
    const authorization: WriteAuthorization = {
      ...fixture.authorization,
      payload: intent,
    }

    await expect(
      verifyWriteAuthorization({
        authorization,
        expectedIntent: intent,
        fetchBinding: bindingFetch(fixture.binding),
        now: fixture.now,
      }),
    ).rejects.toMatchObject({
      message: 'timestamp must be canonical ISO 8601',
      name: WriteAuthorizationError.name,
    })
  })

  it('rejects payload mismatches before fetching domain bindings', async () => {
    const fixture = createAuthorizationFixture()
    const fetchBinding = vi.fn(() => Promise.resolve(new Response(null)))

    await expect(
      verifyWriteAuthorization({
        authorization: fixture.authorization,
        expectedIntent: {
          ...fixture.intent,
          version: '0.0.2',
        },
        fetchBinding,
        now: fixture.now,
      }),
    ).rejects.toMatchObject({
      message: 'Write authorization payload mismatch',
      name: WriteAuthorizationError.name,
    })
    expect(fetchBinding).not.toHaveBeenCalled()
  })

  it('rejects unknown write authorization fields before fetching domain bindings', async () => {
    const fixture = createAuthorizationFixture()
    const fetchBinding = vi.fn(() => Promise.resolve(new Response(null)))

    await expect(
      verifyWriteAuthorization({
        authorization: {
          ...fixture.authorization,
          payload: {
            ...fixture.authorization.payload,
            extra: 'not signed',
          },
        },
        expectedIntent: fixture.intent,
        fetchBinding,
        now: fixture.now,
      }),
    ).rejects.toMatchObject({
      message: 'Write intent must not include unknown field: extra',
      name: WriteAuthorizationError.name,
    })
    expect(fetchBinding).not.toHaveBeenCalled()
  })

  it('rejects write authorization key ids with control characters before fetching domain bindings', async () => {
    const fixture = createAuthorizationFixture()
    const fetchBinding = vi.fn(() => Promise.resolve(new Response(null)))

    await expect(
      verifyWriteAuthorization({
        authorization: {
          ...fixture.authorization,
          kid: `${fixture.authorization.kid}\r\nx`,
        },
        expectedIntent: fixture.intent,
        fetchBinding,
        now: fixture.now,
      }),
    ).rejects.toMatchObject({
      message: 'kid must not include control characters',
      name: WriteAuthorizationError.name,
    })
    expect(fetchBinding).not.toHaveBeenCalled()
  })

  it('rejects unknown domain binding fields', async () => {
    const fixture = createAuthorizationFixture()

    await expect(
      verifyWriteAuthorization({
        authorization: fixture.authorization,
        expectedIntent: fixture.intent,
        fetchBinding: bindingFetch({
          ...fixture.binding,
          policy: {},
        }),
        now: fixture.now,
      }),
    ).rejects.toMatchObject({
      message: 'Domain binding must not include unknown field: policy',
      name: WriteAuthorizationError.name,
    })

    await expect(
      verifyWriteAuthorization({
        authorization: fixture.authorization,
        expectedIntent: fixture.intent,
        fetchBinding: bindingFetch({
          ...fixture.binding,
          keys: [
            {
              ...fixture.binding.keys[0]!,
              revokedAt: '2026-06-01T00:00:00.000Z',
            },
          ],
        }),
        now: fixture.now,
      }),
    ).rejects.toMatchObject({
      message: 'Domain binding key must not include unknown field: revokedAt',
      name: WriteAuthorizationError.name,
    })

    await expect(
      verifyWriteAuthorization({
        authorization: fixture.authorization,
        expectedIntent: fixture.intent,
        fetchBinding: bindingFetch({
          ...fixture.binding,
          keys: [
            {
              ...fixture.binding.keys[0]!,
              publicKeyJwk: {
                ...fixture.binding.keys[0]!.publicKeyJwk,
                key_ops: ['verify'],
              },
            },
          ],
        }),
        now: fixture.now,
      }),
    ).rejects.toMatchObject({
      message: 'publicKeyJwk must not include unknown field: key_ops',
      name: WriteAuthorizationError.name,
    })
  })

  it('rejects domain binding key ids with control characters', async () => {
    const fixture = createAuthorizationFixture()

    await expect(
      verifyWriteAuthorization({
        authorization: fixture.authorization,
        expectedIntent: fixture.intent,
        fetchBinding: bindingFetch({
          ...fixture.binding,
          keys: [
            {
              ...fixture.binding.keys[0]!,
              kid: `${fixture.binding.keys[0]!.kid}\r\nx`,
            },
          ],
        }),
        now: fixture.now,
      }),
    ).rejects.toMatchObject({
      message: 'kid must not include control characters',
      name: WriteAuthorizationError.name,
    })
  })

  it('rejects malformed domain binding public keys before crypto verification', async () => {
    const fixture = createAuthorizationFixture()

    for (const [x, message] of [
      ['!!!', 'publicKeyJwk.x must be base64url'],
      [
        `${fixture.binding.keys[0]!.publicKeyJwk.x}=`,
        'publicKeyJwk.x must be base64url',
      ],
      ['YWJj', 'publicKeyJwk.x must be an Ed25519 public key'],
    ]) {
      await expect(
        verifyWriteAuthorization({
          authorization: fixture.authorization,
          expectedIntent: fixture.intent,
          fetchBinding: bindingFetch({
            ...fixture.binding,
            keys: [
              {
                ...fixture.binding.keys[0]!,
                publicKeyJwk: {
                  ...fixture.binding.keys[0]!.publicKeyJwk,
                  x,
                },
              },
            ],
          }),
          now: fixture.now,
        }),
      ).rejects.toMatchObject({
        message,
        name: WriteAuthorizationError.name,
      })
    }
  })

  it('rejects malformed write authorization signatures before crypto verification', async () => {
    const fixture = createAuthorizationFixture()

    for (const [signature, message] of [
      ['!!!', 'Write authorization signature must be base64url'],
      [
        `${fixture.authorization.signature}=`,
        'Write authorization signature must be base64url',
      ],
      ['YWJj', 'Write authorization signature must be an Ed25519 signature'],
    ]) {
      await expect(
        verifyWriteAuthorization({
          authorization: {
            ...fixture.authorization,
            signature,
          },
          expectedIntent: fixture.intent,
          fetchBinding: bindingFetch(fixture.binding),
          now: fixture.now,
        }),
      ).rejects.toMatchObject({
        message,
        name: WriteAuthorizationError.name,
      })
    }
  })

  it('rejects domain binding keys that are not active yet', async () => {
    const fixture = createAuthorizationFixture()

    await expect(
      verifyWriteAuthorization({
        authorization: fixture.authorization,
        expectedIntent: fixture.intent,
        fetchBinding: bindingFetch({
          ...fixture.binding,
          keys: [
            {
              ...fixture.binding.keys[0]!,
              createdAt: '2026-06-01T00:00:01.000Z',
            },
          ],
        }),
        now: fixture.now,
      }),
    ).rejects.toMatchObject({
      message: 'Domain binding key not found or inactive',
      name: WriteAuthorizationError.name,
    })
  })

  it('rejects domain binding keys that were not active at signing time', async () => {
    const fixture = createAuthorizationFixture()

    await expect(
      verifyWriteAuthorization({
        authorization: fixture.authorization,
        expectedIntent: fixture.intent,
        fetchBinding: bindingFetch({
          ...fixture.binding,
          keys: [
            {
              ...fixture.binding.keys[0]!,
              createdAt: '2026-06-01T00:00:01.000Z',
            },
          ],
        }),
        now: new Date('2026-06-01T00:00:02.000Z'),
      }),
    ).rejects.toMatchObject({
      message: 'Domain binding key not found or inactive',
      name: WriteAuthorizationError.name,
    })
  })

  it('rejects expired domain binding keys', async () => {
    const fixture = createAuthorizationFixture()

    await expect(
      verifyWriteAuthorization({
        authorization: fixture.authorization,
        expectedIntent: fixture.intent,
        fetchBinding: bindingFetch({
          ...fixture.binding,
          keys: [
            {
              ...fixture.binding.keys[0]!,
              expiresAt: '2026-06-01T00:00:00.000Z',
            },
          ],
        }),
        now: fixture.now,
      }),
    ).rejects.toMatchObject({
      message: 'Domain binding key not found or inactive',
      name: WriteAuthorizationError.name,
    })
  })

  it('rejects domain binding keys that expire before signing time', async () => {
    const fixture = createAuthorizationFixture({
      timestamp: '2026-06-01T00:00:04.000Z',
    })

    await expect(
      verifyWriteAuthorization({
        authorization: fixture.authorization,
        expectedIntent: fixture.intent,
        fetchBinding: bindingFetch({
          ...fixture.binding,
          keys: [
            {
              ...fixture.binding.keys[0]!,
              expiresAt: '2026-06-01T00:00:03.000Z',
            },
          ],
        }),
        now: fixture.now,
      }),
    ).rejects.toMatchObject({
      message: 'Domain binding key not found or inactive',
      name: WriteAuthorizationError.name,
    })
  })
})

describe('domain binding helpers', () => {
  it('derives owner domains and well-known URLs from canonical package ids', () => {
    expect(ownerDomainFromPackageId('npm:example.com/hello-regesta')).toBe(
      'example.com',
    )
    expect(domainBindingUrl('example.com')).toBe(
      'https://example.com/.well-known/regesta.json',
    )
  })

  it('rejects non-canonical domains when building domain binding URLs', () => {
    expect(() => domainBindingUrl('Example.com')).toThrow(
      'Domain must be a canonical DNS domain',
    )
  })
})

describe('write intent helpers', () => {
  it('normalizes release publish intent fields at creation time', () => {
    expect(() =>
      createReleasePublishIntent({
        artifactDescriptorDigest: testArtifactDescriptorDigest(),
        artifactDigests: [sha256(bytes('artifact'))],
        configDigest: sha256(bytes('config')),
        nonce: '',
        packageId: 'npm:example.com/auth-test',
        sourceDigest: sha256(bytes('source')),
        timestamp: '2026-06-01T00:00:00.000Z',
        version: '0.0.1',
      }),
    ).toThrow('nonce must be a non-empty string')

    expect(() =>
      createReleasePublishIntent({
        artifactDescriptorDigest: testArtifactDescriptorDigest(),
        artifactDigests: [sha256(bytes('artifact'))],
        configDigest: sha256(bytes('config')),
        nonce: 'control-nonce\r\nx',
        packageId: 'npm:example.com/auth-test',
        sourceDigest: sha256(bytes('source')),
        timestamp: '2026-06-01T00:00:00.000Z',
        version: '0.0.1',
      }),
    ).toThrow('nonce must not include control characters')

    expect(() =>
      createReleasePublishIntent({
        artifactDescriptorDigest: testArtifactDescriptorDigest(),
        artifactDigests: [sha256(bytes('artifact'))],
        configDigest: sha256(bytes('config')),
        nonce: 'invalid-timestamp',
        packageId: 'npm:example.com/auth-test',
        sourceDigest: sha256(bytes('source')),
        timestamp: '2026-06-01T00:00:00Z',
        version: '0.0.1',
      }),
    ).toThrow('timestamp must be canonical ISO 8601')

    expect(() =>
      createReleasePublishIntent({
        artifactDescriptorDigest: testArtifactDescriptorDigest(),
        artifactDigests: [sha256(bytes('artifact'))],
        configDigest: sha256(bytes('config')),
        nonce: 'empty-version',
        packageId: 'npm:example.com/auth-test',
        sourceDigest: sha256(bytes('source')),
        timestamp: '2026-06-01T00:00:00.000Z',
        version: '',
      }),
    ).toThrow('version must be a non-empty string')

    expect(() =>
      createReleasePublishIntent({
        artifactDescriptorDigest: testArtifactDescriptorDigest(),
        artifactDigests: [sha256(bytes('artifact'))],
        configDigest: sha256(bytes('config')),
        nonce: 'control-version',
        packageId: 'npm:example.com/auth-test',
        sourceDigest: sha256(bytes('source')),
        timestamp: '2026-06-01T00:00:00.000Z',
        version: '0.0.1\r\nx',
      }),
    ).toThrow('version must not include control characters')
  })

  it('normalizes channel intent fields at creation time', () => {
    expect(() =>
      createChannelUpdateIntent({
        channel: '',
        nonce: 'empty-channel',
        packageId: 'npm:example.com/auth-test',
        timestamp: '2026-06-01T00:00:00.000Z',
        version: '0.0.1',
      }),
    ).toThrow('channel must be a non-empty string')

    expect(() =>
      createChannelUpdateIntent({
        channel: 'latest\r\nx',
        nonce: 'control-channel',
        packageId: 'npm:example.com/auth-test',
        timestamp: '2026-06-01T00:00:00.000Z',
        version: '0.0.1',
      }),
    ).toThrow('channel must not include control characters')

    expect(() =>
      createChannelUpdateIntent({
        channel: 'latest',
        nonce: 'empty-previous-version',
        packageId: 'npm:example.com/auth-test',
        previousVersion: '',
        timestamp: '2026-06-01T00:00:00.000Z',
        version: '0.0.1',
      }),
    ).toThrow('previousVersion must be a non-empty string')

    expect(() =>
      createChannelUpdateIntent({
        channel: 'latest',
        nonce: 'control-previous-version',
        packageId: 'npm:example.com/auth-test',
        previousVersion: '0.0.1\r\nx',
        timestamp: '2026-06-01T00:00:00.000Z',
        version: '0.0.2',
      }),
    ).toThrow('previousVersion must not include control characters')

    expect(() =>
      createChannelDeleteIntent({
        channel: 'latest',
        nonce: 'invalid-timestamp',
        packageId: 'npm:example.com/auth-test',
        previousVersion: '0.0.1',
        timestamp: '2026-06-01T00:00:00Z',
      }),
    ).toThrow('timestamp must be canonical ISO 8601')
  })

  it('rejects empty release publish artifact digest lists', () => {
    expect(() =>
      createReleasePublishIntent({
        artifactDescriptorDigest: testArtifactDescriptorDigest(),
        artifactDigests: [],
        configDigest: sha256(bytes('config')),
        nonce: 'empty-artifacts',
        packageId: 'npm:example.com/auth-test',
        sourceDigest: sha256(bytes('source')),
        timestamp: '2026-06-01T00:00:00.000Z',
        version: '0.0.1',
      }),
    ).toThrow('artifactDigests must not be empty')
  })

  it('does not retain mutable artifact digest input arrays', () => {
    const artifactDigests = [sha256(bytes('artifact'))]
    const intent = createReleasePublishIntent({
      artifactDescriptorDigest: testArtifactDescriptorDigest(),
      artifactDigests,
      configDigest: sha256(bytes('config')),
      nonce: 'mutable-artifacts',
      packageId: 'npm:example.com/auth-test',
      sourceDigest: sha256(bytes('source')),
      timestamp: '2026-06-01T00:00:00.000Z',
      version: '0.0.1',
    })

    artifactDigests[0] = sha256(bytes('mutated artifact'))

    expect(intent.artifactDigests).toEqual([sha256(bytes('artifact'))])
  })

  it('binds release publish authorization to artifact descriptor metadata', async () => {
    const fixture = createAuthorizationFixture({
      now: new Date(),
      timestamp: new Date().toISOString(),
    })

    await expect(
      verifyPublishAuthorization({
        artifacts: [
          {
            bytes: bytes('artifact'),
            mediaType: 'application/octet-stream',
            role: 'install',
          },
        ],
        authorization: fixture.authorization,
        configDigest: sha256(bytes('config')),
        fetchBinding: bindingFetch(fixture.binding),
        packageId: 'npm:example.com/auth-test',
        source: bytes('source'),
        version: '0.0.1',
      }),
    ).rejects.toMatchObject({
      message: 'Write authorization payload mismatch',
      name: WriteAuthorizationError.name,
    })
  })

  it('rejects unsafe artifact descriptor strings before digesting them', () => {
    expect(() =>
      releasePublishArtifactDescriptorDigest([
        {
          digest: sha256(bytes('artifact')),
          filename: 'artifact.bin\r\nx',
          format: 'demo',
          mediaType: 'application/octet-stream',
          role: 'install',
        },
      ]),
    ).toThrow('artifact filename must not include control characters')

    expect(() =>
      releasePublishArtifactDescriptorDigest([
        {
          digest: sha256(bytes('artifact')),
          format: 'demo\r\nx',
          mediaType: 'application/octet-stream',
          role: 'install',
        },
      ]),
    ).toThrow('artifact format must not include control characters')

    expect(() =>
      releasePublishArtifactDescriptorDigest([
        {
          digest: sha256(bytes('artifact')),
          mediaType: 'application/octet-stream',
          role: 'install\r\nx',
        },
      ]),
    ).toThrow('artifact role must not include control characters')
  })
})

function createAuthorizationFixture(
  input: {
    now?: Date
    timestamp?: string
  } = {},
): {
  authorization: WriteAuthorization
  binding: DomainBinding
  intent: ReturnType<typeof createReleasePublishIntent>
  now: Date
} {
  const now = input.now ?? new Date('2026-06-01T00:00:00.000Z')
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const privateKeyJwk = normalizePrivateKeyJwk(
    privateKey.export({ format: 'jwk' }),
  )
  const publicKeyJwk = normalizePublicKeyJwk(
    publicKey.export({ format: 'jwk' }),
  )
  const intent = createReleasePublishIntent({
    artifactDescriptorDigest: testArtifactDescriptorDigest(),
    artifactDigests: [sha256(bytes('artifact'))],
    configDigest: sha256(bytes('config')),
    nonce: 'auth-test-nonce',
    packageId: 'npm:example.com/auth-test',
    sourceDigest: sha256(bytes('source')),
    timestamp: input.timestamp ?? now.toISOString(),
    version: '0.0.1',
  })
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
    authorization: createWriteAuthorization(intent, {
      kid: 'ed25519:test',
      privateKeyJwk,
    }),
    binding,
    intent,
    now,
  }
}

function testArtifactDescriptorDigest() {
  return releasePublishArtifactDescriptorDigest([
    {
      digest: sha256(bytes('artifact')),
      mediaType: 'application/gzip',
      role: 'install',
    },
  ])
}

function bindingFetch(binding: unknown): typeof fetch {
  return (input) => {
    if (String(input) !== 'https://example.com/.well-known/regesta.json') {
      return Promise.resolve(new Response(null, { status: 404 }))
    }

    return Promise.resolve(Response.json(binding))
  }
}

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value)
}

function unreadableResponse(): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.error(new Error('domain binding body unavailable'))
      },
    }),
  )
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
