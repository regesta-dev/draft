import { Buffer } from 'node:buffer'
import {
  createHash,
  generateKeyPairSync,
  sign,
  type KeyObject,
} from 'node:crypto'
import {
  canonicalJson,
  defaultPackageChannel,
  sha256,
  type PackageId,
} from '@regesta/protocol'
import { describe, expect, it, vi } from 'vitest'
import {
  createChannelDeleteIntent,
  createChannelUpdateIntent,
  createReleasePublishIntent,
  createSshWriteAuthorization,
  createWriteAuthorization,
  domainBindingUrl,
  ownerDomainFromPackageId,
  regestaSshSignatureNamespace,
  releasePublishArtifactDescriptorDigest,
  verifyChannelDeleteAuthorization,
  verifyChannelUpdateAuthorization,
  verifyPublishAuthorization,
  verifyWriteAuthorization,
  WriteAuthorizationError,
  writeIntentPayloadBytes,
  type DomainBinding,
  type Ed25519PrivateKeyJwk,
  type Ed25519PublicKeyJwk,
  type WriteAuthorization,
  type WriteIntent,
} from './index.ts'

describe('verifyWriteAuthorization', () => {
  it('returns an auditable authorization proof for valid write signatures', async () => {
    const fixture = createAuthorizationFixture()
    const bindingText = JSON.stringify(fixture.binding)
    const bindingBytes = bytes(bindingText)

    await expect(
      verifyWriteAuthorization({
        authorization: fixture.authorization,
        expectedIntent: fixture.intent,
        fetchBinding: () =>
          Promise.resolve(
            new Response(bindingBytes, {
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
      wellKnownDigest: sha256(bindingBytes),
    })
  })

  it('verifies write signatures for future ecosystem package ids', async () => {
    const fixture = createAuthorizationFixture({
      packageId: 'maven:example.com/group/artifact',
    })

    await expect(
      verifyWriteAuthorization({
        authorization: fixture.authorization,
        expectedIntent: fixture.intent,
        fetchBinding: bindingFetch(fixture.binding),
        now: fixture.now,
      }),
    ).resolves.toMatchObject({
      domain: 'example.com',
      object: 'regesta.authorization-proof',
      payloadDigest: sha256(canonicalJson(fixture.authorization.payload)),
    })
  })

  it('returns an auditable authorization proof for valid ssh-ed25519 write signatures', async () => {
    const fixture = createSshAuthorizationFixture()
    const bindingText = JSON.stringify(fixture.binding)
    const bindingBytes = bytes(bindingText)
    const key = fixture.binding.keys[0]

    if (!key || key.alg !== 'ssh-ed25519') {
      throw new Error('SSH fixture key missing')
    }

    await expect(
      verifyWriteAuthorization({
        authorization: fixture.authorization,
        expectedIntent: fixture.intent,
        fetchBinding: () =>
          Promise.resolve(
            new Response(bindingBytes, {
              headers: {
                'content-type': 'application/json',
              },
            }),
          ),
        now: fixture.now,
      }),
    ).resolves.toEqual({
      alg: 'ssh-ed25519',
      domain: 'example.com',
      kid: 'ssh-ed25519:test',
      object: 'regesta.authorization-proof',
      payloadDigest: sha256(canonicalJson(fixture.authorization.payload)),
      publicKey: key.publicKey,
      signature: fixture.authorization.signature,
      signedAt: fixture.authorization.payload.timestamp,
      wellKnownDigest: sha256(bindingBytes),
    })
  })

  it('rejects ssh-ed25519 signatures from another namespace', async () => {
    const fixture = createSshAuthorizationFixture({ namespace: 'git' })

    await expect(
      verifyWriteAuthorization({
        authorization: fixture.authorization,
        expectedIntent: fixture.intent,
        fetchBinding: bindingFetch(fixture.binding),
        now: fixture.now,
      }),
    ).rejects.toMatchObject({
      message: `OpenSSH signature namespace must be ${regestaSshSignatureNamespace}`,
      name: WriteAuthorizationError.name,
    })
  })

  it('records the digest of exact domain binding response bytes', async () => {
    const fixture = createAuthorizationFixture()
    const bindingText = JSON.stringify(fixture.binding)
    const bindingBytes = concatBytes(
      new Uint8Array([0xef, 0xbb, 0xbf]),
      bytes(bindingText),
    )

    await expect(
      verifyWriteAuthorization({
        authorization: fixture.authorization,
        expectedIntent: fixture.intent,
        fetchBinding: () =>
          Promise.resolve(
            new Response(bindingBytes, {
              headers: {
                'content-type': 'application/json',
              },
            }),
          ),
        now: fixture.now,
      }),
    ).resolves.toMatchObject({
      wellKnownDigest: sha256(bindingBytes),
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

  it('rejects domain binding responses that are not valid UTF-8', async () => {
    const fixture = createAuthorizationFixture()

    await expect(
      verifyWriteAuthorization({
        authorization: fixture.authorization,
        expectedIntent: fixture.intent,
        fetchBinding: () =>
          Promise.resolve(
            new Response(new Uint8Array([0xff]), {
              headers: {
                'content-type': 'application/json',
              },
            }),
          ),
        now: fixture.now,
      }),
    ).rejects.toMatchObject({
      message: 'Domain binding response must be UTF-8',
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

  it('rejects domain binding responses without a JSON content type', async () => {
    const fixture = createAuthorizationFixture()

    await expect(
      verifyWriteAuthorization({
        authorization: fixture.authorization,
        expectedIntent: fixture.intent,
        fetchBinding: () => Promise.resolve(new Response('{}')),
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
    expect(capturedInit?.redirect).toBe('error')
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

  it('rejects domain binding Content-Length mismatches', async () => {
    const fixture = createAuthorizationFixture()
    const bindingText = JSON.stringify(fixture.binding)

    for (const contentLength of [
      String(bytes(bindingText).byteLength - 1),
      String(bytes(bindingText).byteLength + 1),
    ]) {
      await expect(
        verifyWriteAuthorization({
          authorization: fixture.authorization,
          expectedIntent: fixture.intent,
          fetchBinding: () =>
            Promise.resolve(
              new Response(bindingText, {
                headers: {
                  'content-length': contentLength,
                  'content-type': 'application/json',
                },
              }),
            ),
          now: fixture.now,
        }),
      ).rejects.toMatchObject({
        message: 'Domain binding Content-Length does not match response body',
        name: WriteAuthorizationError.name,
      })
    }
  })

  it('rejects invalid domain binding Content-Length headers', async () => {
    const fixture = createAuthorizationFixture()
    const bindingText = JSON.stringify(fixture.binding)

    for (const contentLength of ['', '-1', '1.0', '1e0', 'NaN']) {
      await expect(
        verifyWriteAuthorization({
          authorization: fixture.authorization,
          expectedIntent: fixture.intent,
          fetchBinding: () =>
            Promise.resolve(
              new Response(bindingText, {
                headers: {
                  'content-length': contentLength,
                  'content-type': 'application/json',
                },
              }),
            ),
          now: fixture.now,
        }),
      ).rejects.toMatchObject({
        message: 'Domain binding Content-Length is invalid',
        name: WriteAuthorizationError.name,
      })
    }
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

  it('rejects domain bindings without write keys', async () => {
    const fixture = createAuthorizationFixture()

    await expect(
      verifyWriteAuthorization({
        authorization: fixture.authorization,
        expectedIntent: fixture.intent,
        fetchBinding: bindingFetch({
          ...fixture.binding,
          keys: [],
        }),
        now: fixture.now,
      }),
    ).rejects.toMatchObject({
      message: 'Domain binding keys must not be empty',
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

    await expectWriteAuthorizationRejectsBeforeDomainBinding({
      authorization,
      expectedIntent: intent,
      message: 'timestamp must be canonical ISO 8601',
      now: fixture.now,
    })
  })

  it('rejects stale or future write intent timestamps before fetching domain bindings', async () => {
    for (const now of [
      new Date('2026-06-01T00:10:00.001Z'),
      new Date('2026-05-31T23:49:59.999Z'),
    ]) {
      const fixture = createAuthorizationFixture({
        now,
        timestamp: '2026-06-01T00:00:00.000Z',
      })

      await expectWriteAuthorizationRejectsBeforeDomainBinding({
        authorization: fixture.authorization,
        expectedIntent: fixture.intent,
        message: 'Write intent timestamp is outside window',
        now,
      })
    }
  })

  it('rejects payload mismatches before fetching domain bindings', async () => {
    const fixture = createAuthorizationFixture()

    await expectWriteAuthorizationRejectsBeforeDomainBinding({
      authorization: fixture.authorization,
      expectedIntent: {
        ...fixture.intent,
        version: '0.0.2',
      },
      message: 'Write authorization payload mismatch',
      now: fixture.now,
    })
  })

  it('rejects malformed write authorization envelopes before fetching domain bindings', async () => {
    const fixture = createAuthorizationFixture()

    for (const [authorization, message] of [
      [
        {
          ...fixture.authorization,
          alg: 'none',
        },
        'Write authorization alg must be EdDSA or ssh-ed25519',
      ],
      [
        {
          ...fixture.authorization,
          extra: 'not signed',
        },
        'Write authorization must not include unknown field: extra',
      ],
      [
        {
          ...fixture.authorization,
          payload: null,
        },
        'Write intent must be an object',
      ],
      [
        {
          ...fixture.authorization,
          payload: {
            ...fixture.authorization.payload,
            operation: 'package.yank',
          },
        },
        'Unsupported write intent operation',
      ],
      [
        {
          ...fixture.authorization,
          signature: '',
        },
        'Write authorization must include signature',
      ],
    ]) {
      await expectWriteAuthorizationRejectsBeforeDomainBinding({
        authorization,
        expectedIntent: fixture.intent,
        message,
        now: fixture.now,
      })
    }
  })

  it('rejects release publish intents without a channel before fetching domain bindings', async () => {
    const fixture = createAuthorizationFixture()
    const payload: Record<string, unknown> = {
      ...fixture.authorization.payload,
    }
    delete payload.channel

    await expectWriteAuthorizationRejectsBeforeDomainBinding({
      authorization: {
        ...fixture.authorization,
        payload,
      },
      expectedIntent: fixture.intent,
      message: 'channel must be a non-empty string',
      now: fixture.now,
    })
  })

  it('rejects write intent domains that do not match package owners before fetching domain bindings', async () => {
    const fixture = createAuthorizationFixture()

    await expectWriteAuthorizationRejectsBeforeDomainBinding({
      authorization: {
        ...fixture.authorization,
        payload: {
          ...fixture.authorization.payload,
          domain: 'other.example.com',
        },
      },
      expectedIntent: {
        ...fixture.intent,
        domain: 'other.example.com',
      },
      message: 'Write intent domain must match package owner',
      now: fixture.now,
    })
  })

  it('rejects channel write intent domains that do not match package owners before fetching domain bindings', () => {
    const fixture = createAuthorizationFixture()
    const packageId = 'npm:example.com/auth-test'
    const updateIntent = createChannelUpdateIntent({
      channel: 'beta',
      nonce: 'channel-update-domain-mismatch',
      packageId,
      previousVersion: '0.0.1',
      timestamp: fixture.now.toISOString(),
      version: '0.0.2',
    })
    const deleteIntent = createChannelDeleteIntent({
      channel: 'beta',
      nonce: 'channel-delete-domain-mismatch',
      packageId,
      previousVersion: '0.0.2',
      timestamp: fixture.now.toISOString(),
    })
    const fetchBinding = vi.fn(() => Promise.resolve(new Response(null)))

    expect(() =>
      verifyChannelUpdateAuthorization({
        authorization: {
          ...fixture.authorization,
          payload: {
            ...updateIntent,
            domain: 'other.example.com',
          },
        },
        channel: 'beta',
        fetchBinding,
        packageId,
        previousVersion: '0.0.1',
        version: '0.0.2',
      }),
    ).toThrow('Write intent domain must match package owner')
    expect(() =>
      verifyChannelDeleteAuthorization({
        authorization: {
          ...fixture.authorization,
          payload: {
            ...deleteIntent,
            domain: 'other.example.com',
          },
        },
        channel: 'beta',
        fetchBinding,
        packageId,
        previousVersion: '0.0.2',
      }),
    ).toThrow('Write intent domain must match package owner')
    expect(fetchBinding).not.toHaveBeenCalled()
  })

  it('rejects unknown write authorization fields before fetching domain bindings', async () => {
    const fixture = createAuthorizationFixture()

    await expectWriteAuthorizationRejectsBeforeDomainBinding({
      authorization: {
        ...fixture.authorization,
        payload: {
          ...fixture.authorization.payload,
          extra: 'not signed',
        },
      },
      expectedIntent: fixture.intent,
      message: 'Write intent must not include unknown field: extra',
      now: fixture.now,
    })
  })

  it('rejects write authorization key ids with control characters before fetching domain bindings', async () => {
    const fixture = createAuthorizationFixture()

    await expectWriteAuthorizationRejectsBeforeDomainBinding({
      authorization: {
        ...fixture.authorization,
        kid: `${fixture.authorization.kid}\r\nx`,
      },
      expectedIntent: fixture.intent,
      message: 'kid must not include control characters',
      now: fixture.now,
    })
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
      await expectWriteAuthorizationRejectsBeforeDomainBinding({
        authorization: {
          ...fixture.authorization,
          signature,
        },
        expectedIntent: fixture.intent,
        message,
        now: fixture.now,
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
    expect(
      createReleasePublishIntent({
        artifactDescriptorDigest: testArtifactDescriptorDigest(),
        artifactDigests: [sha256(bytes('artifact'))],
        configDigest: sha256(bytes('config')),
        nonce: 'default-channel',
        packageId: 'npm:example.com/auth-test',
        sourceDigest: sha256(bytes('source')),
        timestamp: '2026-06-01T00:00:00.000Z',
        version: '0.0.1',
      }),
    ).toMatchObject({
      channel: defaultPackageChannel,
      operation: 'release.publish',
    })

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

  it('binds release publish authorization to artifacts, config, and source bytes', async () => {
    const now = new Date()
    const fixture = createAuthorizationFixture({
      now,
      timestamp: now.toISOString(),
    })
    const baseInput = {
      artifacts: [
        {
          bytes: bytes('artifact'),
          mediaType: 'application/gzip',
          role: 'install',
        },
      ],
      authorization: fixture.authorization,
      configDigest: sha256(bytes('config')),
      fetchBinding: bindingFetch(fixture.binding),
      packageId: 'npm:example.com/auth-test',
      source: bytes('source'),
      version: '0.0.1',
    }

    await expect(verifyPublishAuthorization(baseInput)).resolves.toMatchObject({
      kid: 'ed25519:test',
      object: 'regesta.authorization-proof',
      payloadDigest: sha256(canonicalJson(fixture.authorization.payload)),
    })

    for (const input of [
      {
        ...baseInput,
        artifacts: [
          {
            bytes: bytes('tampered artifact'),
            mediaType: 'application/gzip',
            role: 'install',
          },
        ],
      },
      {
        ...baseInput,
        configDigest: sha256(bytes('tampered config')),
      },
      {
        ...baseInput,
        source: bytes('tampered source'),
      },
    ]) {
      await expect(verifyPublishAuthorization(input)).rejects.toMatchObject({
        message: 'Write authorization payload mismatch',
        name: WriteAuthorizationError.name,
      })
    }
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

async function expectWriteAuthorizationRejectsBeforeDomainBinding(input: {
  authorization: unknown
  expectedIntent: WriteIntent
  message: string
  now?: Date
}): Promise<void> {
  const fetchBinding = vi.fn(() => Promise.resolve(new Response(null)))

  await expect(
    verifyWriteAuthorization({
      authorization: input.authorization,
      expectedIntent: input.expectedIntent,
      fetchBinding,
      ...(input.now === undefined ? {} : { now: input.now }),
    }),
  ).rejects.toMatchObject({
    message: input.message,
    name: WriteAuthorizationError.name,
  })
  expect(fetchBinding).not.toHaveBeenCalled()
}

function createAuthorizationFixture(
  input: {
    now?: Date
    packageId?: PackageId
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
    packageId: input.packageId ?? 'npm:example.com/auth-test',
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

function createSshAuthorizationFixture(
  input: {
    namespace?: string
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
  const publicKeyJwk = normalizePublicKeyJwk(
    publicKey.export({ format: 'jwk' }),
  )
  const publicKeyBytes = Buffer.from(publicKeyJwk.x, 'base64url')
  const publicKeyText = sshEd25519PublicKeyText(publicKeyBytes)
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
        alg: 'ssh-ed25519',
        kid: 'ssh-ed25519:test',
        publicKey: publicKeyText,
        use: 'regesta-write',
      },
    ],
    object: 'regesta.domain-binding',
  }

  return {
    authorization: createSshWriteAuthorization(intent, {
      kid: 'ssh-ed25519:test',
      signature: openSshSignature({
        namespace: input.namespace ?? regestaSshSignatureNamespace,
        payload: writeIntentPayloadBytes(intent),
        privateKey,
        publicKey: publicKeyBytes,
      }),
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

function concatBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  const output = new Uint8Array(left.byteLength + right.byteLength)
  output.set(left)
  output.set(right, left.byteLength)
  return output
}

function concatManyBytes(...chunks: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(
    chunks.reduce((total, chunk) => total + chunk.byteLength, 0),
  )
  let offset = 0

  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.byteLength
  }

  return output
}

function openSshSignature(input: {
  namespace: string
  payload: Uint8Array
  privateKey: KeyObject
  publicKey: Uint8Array
}): string {
  const hashAlgorithm = 'sha512'
  const digest = createHash(hashAlgorithm).update(input.payload).digest()
  const signedData = concatManyBytes(
    bytes('SSHSIG'),
    sshString(bytes(input.namespace)),
    sshString(new Uint8Array()),
    sshString(bytes(hashAlgorithm)),
    sshString(digest),
  )
  const signature = sign(null, signedData, input.privateKey)
  const body = concatManyBytes(
    bytes('SSHSIG'),
    uint32(1),
    sshString(sshEd25519PublicKeyBlob(input.publicKey)),
    sshString(bytes(input.namespace)),
    sshString(new Uint8Array()),
    sshString(bytes(hashAlgorithm)),
    sshString(
      concatManyBytes(
        sshString(bytes('ssh-ed25519')),
        sshString(new Uint8Array(signature)),
      ),
    ),
  )
  const encoded = Buffer.from(body).toString('base64')
  const lines = encoded.match(/.{1,70}/gu) ?? [encoded]

  return `-----BEGIN SSH SIGNATURE-----\n${lines.join('\n')}\n-----END SSH SIGNATURE-----`
}

function sshEd25519PublicKeyText(publicKey: Uint8Array): string {
  return `ssh-ed25519 ${Buffer.from(sshEd25519PublicKeyBlob(publicKey)).toString('base64')}`
}

function sshEd25519PublicKeyBlob(publicKey: Uint8Array): Uint8Array {
  return concatManyBytes(sshString(bytes('ssh-ed25519')), sshString(publicKey))
}

function sshString(value: Uint8Array): Uint8Array {
  return concatManyBytes(uint32(value.byteLength), value)
}

function uint32(value: number): Uint8Array {
  const output = new Uint8Array(4)
  const view = new DataView(output.buffer)

  view.setUint32(0, value, false)

  return output
}

function unreadableResponse(): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.error(new Error('domain binding body unavailable'))
      },
    }),
    {
      headers: {
        'content-type': 'application/json',
      },
    },
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
