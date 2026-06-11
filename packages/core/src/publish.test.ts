import { Buffer } from 'node:buffer'
import {
  sha256,
  type PackageId,
  type RegistryEvent,
  type WriteAuthorizationProof,
} from '@regesta/protocol'
import { describe, expect, it, vi } from 'vitest'
import {
  deletePackageChannel,
  getPackageState,
  updatePackageChannel,
} from './channels.ts'
import { verifyRelease } from './verify.ts'
import {
  publishRelease,
  ReleaseAlreadyExistsError,
  ReleaseNotFoundError,
  WriteAuthorizationReplayError,
  type PublishInput,
  type RegistryAdapters,
  type StoredObject,
  type StoredRelease,
} from './index.ts'

const TEST_ED25519_PUBLIC_KEY = Buffer.alloc(32, 1).toString('base64url')
const TEST_ED25519_SIGNATURE = Buffer.alloc(64, 2).toString('base64url')

describe('publishRelease', () => {
  it('publishes and verifies one tarball-backed package', async () => {
    const adapters = createTestRegistryAdapters()

    const result = await publishRelease(
      {
        ...createPublishInput(),
        createdAt: '2026-06-01T00:00:00.000Z',
      },
      adapters,
    )

    const verification = await verifyRelease(
      adapters,
      'npm:example.com/hello-regesta',
      '0.0.1',
    )
    const state = await getPackageState(
      adapters,
      'npm:example.com/hello-regesta',
    )

    expect(result.channel).toBe('latest')
    expect(result.manifest.id).toBe('npm:example.com/hello-regesta')
    expect(result.manifest.ecosystem).toBe('npm')
    expect(result.manifest.name).toBe('example.com/hello-regesta')
    expect(result.manifest.object).toBe('regesta.release-manifest')
    expect(result.manifest.artifacts).toEqual([
      expect.objectContaining({
        compatibility: {
          modules: ['esm'],
          runtimes: ['node', 'bun'],
        },
        format: 'npm-tarball',
        mediaType: 'application/gzip',
        role: 'install',
      }),
    ])
    expect(result.manifest.metadata?.description).toBe('Test package')
    expect(result.manifest.metadata?.exports).toEqual({
      '.': './src/index.ts',
    })
    expect('dependencies' in result.manifest).toBe(false)
    expect('ecosystemMetadata' in result.manifest).toBe(false)
    expect(result.manifest.provenance).toEqual({
      level: 'source-attached',
      verified: false,
    })
    expect('compatibility' in result.manifest).toBe(false)
    expect(state.channels).toEqual({ latest: '0.0.1' })
    expect(verification.ok).toBe(true)
  })

  it('uses the write authorization signedAt as the publish timestamp', async () => {
    const adapters = createTestRegistryAdapters()
    const authorization = createAuthorizationProof('signed publish timestamp')

    const result = await publishRelease(
      {
        ...createPublishInput(),
        authorization,
      },
      adapters,
    )

    expect(result.manifest.createdAt).toBe(authorization.signedAt)
    expect(result.event.timestamp).toBe(authorization.signedAt)
  })

  it('preserves defined release metadata values even when they are falsey', async () => {
    const adapters = createTestRegistryAdapters()

    const result = await publishRelease(
      {
        ...createPublishInput(),
        config: {
          description: '',
          exports: null,
          id: 'npm:example.com/hello-regesta',
          repository: '',
          source: {
            include: ['regesta.json'],
          },
          version: '0.0.1',
        },
        createdAt: '2026-06-01T00:00:00.000Z',
      },
      adapters,
    )

    expect(result.manifest.metadata).toEqual({
      description: '',
      exports: null,
      repository: '',
    })
  })

  it('rejects signed publish timestamps that differ from authorization time', async () => {
    const adapters = createTestRegistryAdapters()

    await expect(
      publishRelease(
        {
          ...createPublishInput(),
          authorization: createAuthorizationProof('mismatched publish time'),
          createdAt: '2026-06-01T00:01:00.000Z',
        },
        adapters,
      ),
    ).rejects.toThrow(
      'Publish createdAt must match write authorization signedAt',
    )
  })

  it('rejects non-canonical publish timestamps before storing objects', async () => {
    const adapters = createTestRegistryAdapters()

    await expect(
      publishRelease(
        {
          ...createPublishInput(),
          createdAt: '2026-06-01T00:00:00Z',
        },
        adapters,
      ),
    ).rejects.toThrow('Publish createdAt must be canonical ISO 8601')
    await expect(adapters.objects.get(sha256('source archive'))).resolves.toBe(
      undefined,
    )
  })

  it('rejects invalid source archives before storing objects', async () => {
    const cases: Array<{
      message: string
      source: unknown
    }> = [
      {
        message: 'Publish source must be a Uint8Array',
        source: 'source archive',
      },
      {
        message: 'Publish source must not be empty',
        source: bytes(''),
      },
    ]

    for (const { message, source } of cases) {
      const adapters = createTestRegistryAdapters()

      await expect(
        publishRelease(
          {
            ...createPublishInput(),
            // @ts-expect-error Runtime validation protects untyped clients.
            source,
          },
          adapters,
        ),
      ).rejects.toThrow(message)
      await expect(
        adapters.objects.get(
          source instanceof Uint8Array
            ? sha256(source)
            : sha256(String(source)),
        ),
      ).resolves.toBe(undefined)
    }
  })

  it('rejects invalid artifact containers before storing objects', async () => {
    const cases: Array<{
      artifacts: unknown
      message: string
    }> = [
      {
        artifacts: 'install artifact',
        message: 'Publish artifacts must be an array',
      },
      {
        artifacts: [undefined],
        message: 'Publish artifact must be an object',
      },
      {
        artifacts: [
          {
            bytes: bytes('install artifact'),
            mediaType: 'application/gzip\r\nx: y',
            role: 'install',
          },
        ],
        message:
          'Publish artifact mediaType must not include control characters',
      },
      {
        artifacts: [
          {
            bytes: bytes('install artifact'),
            mediaType: 'application/gzip',
            role: '',
          },
        ],
        message: 'Publish artifacts must include role',
      },
      {
        artifacts: [
          {
            bytes: bytes('docs artifact'),
            mediaType: 'text/plain',
            role: 'docs',
          },
        ],
        message: 'Publish request must include exactly one install artifact',
      },
      {
        artifacts: [
          {
            bytes: bytes('first install artifact'),
            mediaType: 'application/gzip',
            role: 'install',
          },
          {
            bytes: bytes('second install artifact'),
            mediaType: 'application/gzip',
            role: 'install',
          },
        ],
        message: 'Publish request must include exactly one install artifact',
      },
    ]

    for (const { artifacts, message } of cases) {
      const adapters = createTestRegistryAdapters()

      await expect(
        publishRelease(
          {
            ...createPublishInput(),
            // @ts-expect-error Runtime validation protects untyped clients.
            artifacts,
          },
          adapters,
        ),
      ).rejects.toThrow(message)
      await expect(
        adapters.objects.get(sha256('source archive')),
      ).resolves.toBe(undefined)
      for (const artifact of Array.isArray(artifacts) ? artifacts : []) {
        if (artifact && typeof artifact === 'object') {
          const artifactBytes = Reflect.get(artifact, 'bytes')
          if (artifactBytes instanceof Uint8Array) {
            await expect(
              adapters.objects.get(sha256(artifactBytes)),
            ).resolves.toBe(undefined)
          }
        }
      }
    }
  })

  it('rejects empty artifact descriptor strings before storing objects', async () => {
    const cases: Array<{
      artifact: PublishInput['artifacts'][number]
      message: string
    }> = [
      {
        artifact: {
          bytes: bytes('install artifact'),
          filename: 'artifact.bin\r\nx',
          mediaType: 'application/gzip',
          role: 'install',
        },
        message:
          'Publish artifact filename must not include control characters',
      },
      {
        artifact: {
          bytes: bytes('install artifact'),
          format: 'npm-tarball\r\nx',
          mediaType: 'application/gzip',
          role: 'install',
        },
        message: 'Publish artifact format must not include control characters',
      },
      {
        artifact: {
          bytes: bytes('install artifact'),
          mediaType: 'application/gzip',
          role: 'install\r\nx',
        },
        message: 'Publish artifact role must not include control characters',
      },
      {
        artifact: {
          bytes: bytes('install artifact'),
          filename: '',
          mediaType: 'application/gzip',
          role: 'install',
        },
        message: 'Publish artifact filename must be non-empty',
      },
      {
        artifact: {
          bytes: bytes('install artifact'),
          format: '',
          mediaType: 'application/gzip',
          role: 'install',
        },
        message: 'Publish artifact format must be non-empty',
      },
    ]

    for (const { artifact, message } of cases) {
      const adapters = createTestRegistryAdapters()

      await expect(
        publishRelease(
          {
            ...createPublishInput(),
            artifacts: [artifact],
          },
          adapters,
        ),
      ).rejects.toThrow(message)
      await expect(
        adapters.objects.get(sha256('source archive')),
      ).resolves.toBe(undefined)
    }
  })

  it('rejects invalid artifact ecosystem metadata before storing objects', async () => {
    const cases: Array<{
      ecosystemMetadata: unknown
      message: string
    }> = [
      {
        ecosystemMetadata: 'npm',
        message: 'Publish artifact ecosystemMetadata must be an object',
      },
      {
        ecosystemMetadata: {
          npm: {
            dependencies: {
              tinyexec: undefined,
            },
          },
        },
        message:
          'Publish artifact ecosystemMetadata must contain only canonical JSON values',
      },
    ]

    for (const { ecosystemMetadata, message } of cases) {
      const adapters = createTestRegistryAdapters()

      await expect(
        publishRelease(
          {
            ...createPublishInput(),
            artifacts: [
              {
                bytes: bytes('install artifact'),
                // @ts-expect-error Runtime validation protects untyped clients.
                ecosystemMetadata,
                mediaType: 'application/gzip',
                role: 'install',
              },
            ],
          },
          adapters,
        ),
      ).rejects.toThrow(message)
      await expect(
        adapters.objects.get(sha256('source archive')),
      ).resolves.toBe(undefined)
    }
  })

  it('rejects invalid artifact compatibility before storing objects', async () => {
    const cases: Array<{
      compatibility: unknown
      message: string
    }> = [
      {
        compatibility: [],
        message: 'Publish artifact compatibility must be an object',
      },
      {
        compatibility: { extra: true },
        message:
          'Publish artifact compatibility must not include unknown field: extra',
      },
      {
        compatibility: { modules: 'esm' },
        message: 'Publish artifact compatibility modules must be an array',
      },
      {
        compatibility: { modules: ['esm\r\nx'] },
        message:
          'Publish artifact compatibility modules[0] must not include control characters',
      },
      {
        compatibility: {
          abi: [
            {
              name: 'node-api\r\nx',
            },
          ],
        },
        message:
          'Publish artifact ABI compatibility name must not include control characters',
      },
      {
        compatibility: {
          runtimes: [
            {
              conditions: 'import',
              name: 'node',
            },
          ],
        },
        message:
          'Publish artifact runtime compatibility conditions must be an array',
      },
    ]

    for (const { compatibility, message } of cases) {
      const adapters = createTestRegistryAdapters()
      const artifact = {
        bytes: bytes('install artifact'),
        mediaType: 'application/gzip',
        role: 'install',
      } satisfies PublishInput['artifacts'][number]
      Object.assign(artifact, { compatibility })

      await expect(
        publishRelease(
          {
            ...createPublishInput(),
            artifacts: [artifact],
          },
          adapters,
        ),
      ).rejects.toThrow(message)
      await expect(
        adapters.objects.get(sha256('source archive')),
      ).resolves.toBe(undefined)
    }
  })

  it('rejects release-level compatibility in regesta config', async () => {
    const adapters = createTestRegistryAdapters()

    await expect(
      publishRelease(
        {
          ...createPublishInput(),
          config: {
            compatibility: {
              runtimes: ['node'],
            },
            id: 'npm:example.com/hello-regesta',
            provenance: {
              level: 'source-attached',
            },
            source: {
              include: ['regesta.json'],
            },
            version: '0.0.1',
          },
        },
        adapters,
      ),
    ).rejects.toThrow(
      'regesta.json compatibility is not supported; attach compatibility to publish artifacts',
    )
  })

  it('rejects schema fields in regesta config', async () => {
    const adapters = createTestRegistryAdapters()

    await expect(
      publishRelease(
        {
          ...createPublishInput(),
          config: {
            $schema: 'https://example.com/regesta.schema.json',
            id: 'npm:example.com/hello-regesta',
            source: {
              include: ['regesta.json'],
            },
            version: '0.0.1',
          },
        },
        adapters,
      ),
    ).rejects.toThrow('regesta.json schema fields are not supported')
  })

  it('rejects generic dependencies in regesta config', async () => {
    const adapters = createTestRegistryAdapters()

    await expect(
      publishRelease(
        {
          ...createPublishInput(),
          config: {
            dependencies: {
              'example.com/base': '^1.0.0',
            },
            id: 'npm:example.com/hello-regesta',
            source: {
              include: ['regesta.json'],
            },
            version: '0.0.1',
          },
        },
        adapters,
      ),
    ).rejects.toThrow(
      'regesta.json dependencies are not supported; use ecosystem-native manifests',
    )
  })

  it('rejects unknown and invalid regesta config fields before storing objects', async () => {
    const cases: Array<{
      config: unknown
      message: string
    }> = [
      {
        config: {
          id: 'npm:example.com/hello-regesta',
          license: 'MIT',
          source: {
            include: ['regesta.json'],
          },
          version: '0.0.1',
        },
        message: 'regesta.json must not include unknown field: license',
      },
      {
        config: {
          package: 'npm:example.com/hello-regesta',
          source: {
            include: ['regesta.json'],
          },
          version: '0.0.1',
        },
        message: 'regesta.json must not include unknown field: package',
      },
      {
        config: {
          files: ['src'],
          id: 'npm:example.com/hello-regesta',
          version: '0.0.1',
        },
        message: 'regesta.json must not include unknown field: files',
      },
      {
        config: {
          id: 'npm:example.com/hello-regesta',
          version: '0.0.1',
        },
        message: 'regesta.json source is required',
      },
      {
        config: {
          id: 'npm:example.com/hello-regesta',
          source: {
            include: ['regesta.json'],
          },
          version: '0.0.1\r\nx',
        },
        message: 'regesta.json version must not include control characters',
      },
      {
        config: {
          description: 1,
          id: 'npm:example.com/hello-regesta',
          source: {
            include: ['regesta.json'],
          },
          version: '0.0.1',
        },
        message: 'regesta.json description must be a string',
      },
      {
        config: {
          family: 1,
          id: 'npm:example.com/hello-regesta',
          source: {
            include: ['regesta.json'],
          },
          version: '0.0.1',
        },
        message: 'regesta.json family must be a string',
      },
      {
        config: {
          id: 'npm:example.com/hello-regesta',
          repository: 1,
          source: {
            include: ['regesta.json'],
          },
          version: '0.0.1',
        },
        message: 'regesta.json repository must be a string',
      },
      {
        config: {
          id: 'npm:example.com/hello-regesta',
          provenance: {
            builder: 'test-builder',
          },
          source: {
            include: ['regesta.json'],
          },
          version: '0.0.1',
        },
        message:
          'regesta.json provenance must not include unknown field: builder',
      },
      {
        config: {
          id: 'npm:example.com/hello-regesta',
          source: {
            include: ['regesta.json'],
            root: '.',
          },
          version: '0.0.1',
        },
        message: 'regesta.json source must not include unknown field: root',
      },
      {
        config: {
          id: 'npm:example.com/hello-regesta',
          source: {
            include: ['src/\nindex.ts'],
          },
          version: '0.0.1',
        },
        message:
          'regesta.json source.include paths must not contain control characters',
      },
      {
        config: {
          id: 'npm:example.com/hello-regesta',
          source: {
            include: ['/etc/passwd'],
          },
          version: '0.0.1',
        },
        message: 'regesta.json source.include paths must be relative',
      },
      {
        config: {
          id: 'npm:example.com/hello-regesta',
          source: {
            include: ['../secret.txt'],
          },
          version: '0.0.1',
        },
        message:
          'regesta.json source.include paths must not contain parent directory segments',
      },
      {
        config: {
          id: 'npm:example.com/hello-regesta',
          source: {
            include: [String.raw`src\index.ts`],
          },
          version: '0.0.1',
        },
        message: 'regesta.json source.include paths must use forward slashes',
      },
      {
        config: {
          id: 'npm:example.com/hello-regesta',
          source: {
            include: ['./src'],
          },
          version: '0.0.1',
        },
        message: 'regesta.json source.include paths must be normalized',
      },
      {
        config: {
          id: 'npm:example.com/hello-regesta',
          source: {
            include: ['src//index.ts'],
          },
          version: '0.0.1',
        },
        message: 'regesta.json source.include paths must be normalized',
      },
      {
        config: {
          id: 'npm:example.com/hello-regesta',
          source: {
            exclude: ['src/..'],
          },
          version: '0.0.1',
        },
        message:
          'regesta.json source.exclude paths must not contain parent directory segments',
      },
      {
        config: {
          id: 'npm:example.com/hello-regesta',
          source: {
            exclude: ['regesta.json'],
          },
          version: '0.0.1',
        },
        message: 'regesta.json source.exclude must not exclude regesta.json',
      },
      {
        config: {
          id: 'npm:example.com/hello-regesta',
          source: {
            exclude: ['regesta.json/'],
          },
          version: '0.0.1',
        },
        message: 'regesta.json source.exclude must not exclude regesta.json',
      },
    ]

    for (const { config, message } of cases) {
      const adapters = createTestRegistryAdapters()

      await expect(
        publishRelease(
          {
            ...createPublishInput(),
            config,
          },
          adapters,
        ),
      ).rejects.toThrow(message)
      await expect(
        adapters.objects.get(sha256('source archive')),
      ).resolves.toBeUndefined()
    }
  })

  it('publishes non-npm package ids without ecosystem-specific assumptions', async () => {
    const adapters = createTestRegistryAdapters()

    const result = await publishRelease(
      {
        artifacts: [
          {
            bytes: bytes('crate artifact'),
            format: 'cargo-crate',
            mediaType: 'application/gzip',
            role: 'install',
          },
        ],
        config: {
          id: 'cargo:example.com/hello-regesta',
          languages: ['rust'],
          provenance: {
            level: 'source-attached',
          },
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
    const verification = await verifyRelease(
      adapters,
      'cargo:example.com/hello-regesta',
      '0.0.1',
    )
    const state = await getPackageState(
      adapters,
      'cargo:example.com/hello-regesta',
    )

    expect(result.manifest.id).toBe('cargo:example.com/hello-regesta')
    expect(result.manifest.ecosystem).toBe('cargo')
    expect(result.manifest.name).toBe('example.com/hello-regesta')
    expect(result.manifest.languages).toEqual(['rust'])
    expect(result.manifest.artifacts).toEqual([
      expect.objectContaining({
        format: 'cargo-crate',
        mediaType: 'application/gzip',
        role: 'install',
      }),
    ])
    expect(result.manifest.metadata).toBeUndefined()
    expect(result.manifest.artifacts[0]!.ecosystemMetadata).toBeUndefined()
    expect(state.ecosystem).toBe('cargo')
    expect(state.name).toBe('example.com/hello-regesta')
    expect(state.channels).toEqual({ latest: '0.0.1' })
    expect(verification.ok).toBe(true)
  })

  it('maps package channels without changing releases', async () => {
    const adapters = createTestRegistryAdapters()

    await publishRelease(
      {
        ...createPublishInput(),
        createdAt: '2026-06-01T00:00:00.000Z',
      },
      adapters,
    )
    const update = await updatePackageChannel(adapters, {
      channel: 'beta',
      packageId: 'npm:example.com/hello-regesta',
      timestamp: '2026-06-01T00:01:00.000Z',
      version: '0.0.1',
    })
    const state = await getPackageState(
      adapters,
      'npm:example.com/hello-regesta',
    )

    expect(update.event.eventType).toBe('channel.updated')
    expect(state.channels).toEqual({ beta: '0.0.1', latest: '0.0.1' })
    expect(state.releases).toEqual([
      expect.objectContaining({
        createdAt: '2026-06-01T00:00:00.000Z',
        version: '0.0.1',
      }),
    ])
  })

  it('derives package state from append-only package events', async () => {
    const adapters = createTestRegistryAdapters()

    await publishRelease(
      {
        ...createPublishInput(),
        createdAt: '2026-06-01T00:00:00.000Z',
      },
      adapters,
    )
    await updatePackageChannel(adapters, {
      channel: 'beta',
      packageId: 'npm:example.com/hello-regesta',
      timestamp: '2026-06-01T00:01:00.000Z',
      version: '0.0.1',
    })
    adapters.database.getPackageChannels = () =>
      Promise.reject(new Error('package state should not read channel views'))
    adapters.database.listPackageReleases = () =>
      Promise.reject(new Error('package state should not read release views'))

    await expect(
      getPackageState(adapters, 'npm:example.com/hello-regesta'),
    ).resolves.toMatchObject({
      channels: {
        beta: '0.0.1',
        latest: '0.0.1',
      },
      releases: [
        {
          createdAt: '2026-06-01T00:00:00.000Z',
          version: '0.0.1',
        },
      ],
    })
  })

  it('derives channel mutation state from append-only package events', async () => {
    const adapters = createTestRegistryAdapters()

    await publishRelease(
      {
        ...createPublishInput(),
        createdAt: '2026-06-01T00:00:00.000Z',
      },
      adapters,
    )
    adapters.database.getPackageChannels = () =>
      Promise.reject(new Error('channel mutations should not read views'))

    await expect(
      updatePackageChannel(adapters, {
        channel: 'latest',
        packageId: 'npm:example.com/hello-regesta',
        timestamp: '2026-06-01T00:01:00.000Z',
        version: '0.0.1',
      }),
    ).resolves.toMatchObject({
      previousVersion: '0.0.1',
    })
    await expect(
      deletePackageChannel(adapters, {
        channel: 'latest',
        packageId: 'npm:example.com/hello-regesta',
        timestamp: '2026-06-01T00:02:00.000Z',
      }),
    ).resolves.toMatchObject({
      previousVersion: '0.0.1',
    })
  })

  it('does not update release projections when publish commit fails', async () => {
    const adapters = createTestRegistryAdapters()
    const enqueue = vi.fn(() => Promise.resolve())
    adapters.queue.enqueue = enqueue
    adapters.database.commitPublishedRelease = () => {
      throw new Error('publish commit failed')
    }

    await expect(
      publishRelease(
        {
          ...createPublishInput(),
          createdAt: '2026-06-01T00:00:00.000Z',
        },
        adapters,
      ),
    ).rejects.toThrow('publish commit failed')

    await expect(
      adapters.database.getRelease('npm:example.com/hello-regesta', '0.0.1'),
    ).resolves.toBeUndefined()
    await expect(
      adapters.database.getPackageChannels('npm:example.com/hello-regesta'),
    ).resolves.toEqual({})
    expect(enqueue).not.toHaveBeenCalled()
  })

  it('keeps committed releases visible when derived queue enqueue fails', async () => {
    const adapters = createTestRegistryAdapters()
    const queueError = new Error('queue unavailable')
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    adapters.queue.enqueue = () => {
      throw queueError
    }

    try {
      const result = await publishRelease(
        {
          ...createPublishInput(),
          createdAt: '2026-06-01T00:00:00.000Z',
        },
        adapters,
      )

      await expect(
        adapters.database.getRelease('npm:example.com/hello-regesta', '0.0.1'),
      ).resolves.toEqual({
        event: result.event,
        manifest: result.manifest,
        manifestDescriptor: result.manifestDescriptor,
      })
      await expect(
        adapters.database.getPackageChannels('npm:example.com/hello-regesta'),
      ).resolves.toEqual({ latest: '0.0.1' })
      expect(consoleError).toHaveBeenCalledWith(
        'Regesta derived queue enqueue failed',
        {
          error: queueError,
          kind: 'regesta.derived-queue-failure',
          payload: {
            channel: 'latest',
            manifestDigest: result.manifestDescriptor.digest,
            package: 'npm:example.com/hello-regesta',
            version: '0.0.1',
          },
          topic: 'release.published',
        },
      )
    } finally {
      consoleError.mockRestore()
    }
  })

  it('rejects duplicate package versions with a typed conflict error', async () => {
    const adapters = createTestRegistryAdapters()
    const input = {
      ...createPublishInput(),
      createdAt: '2026-06-01T00:00:00.000Z',
    }

    await publishRelease(input, adapters)

    await expect(publishRelease(input, adapters)).rejects.toThrow(
      ReleaseAlreadyExistsError,
    )
  })

  it('rejects channel updates that target missing releases with a typed error', async () => {
    const adapters = createTestRegistryAdapters()

    await expect(
      updatePackageChannel(adapters, {
        channel: 'latest',
        packageId: 'npm:example.com/hello-regesta',
        timestamp: '2026-06-01T00:01:00.000Z',
        version: '0.0.1',
      }),
    ).rejects.toThrow(ReleaseNotFoundError)
  })

  it('rejects non-canonical channel mutation timestamps before committing events', async () => {
    const adapters = createTestRegistryAdapters()
    await publishRelease(
      {
        ...createPublishInput(),
        createdAt: '2026-06-01T00:00:00.000Z',
      },
      adapters,
    )

    await expect(
      updatePackageChannel(adapters, {
        channel: 'beta',
        packageId: 'npm:example.com/hello-regesta',
        timestamp: '2026-06-01T00:01:00Z',
        version: '0.0.1',
      }),
    ).rejects.toThrow('Channel timestamp must be canonical ISO 8601')
    await expect(
      deletePackageChannel(adapters, {
        channel: 'latest',
        packageId: 'npm:example.com/hello-regesta',
        timestamp: '2026-06-01T00:02:00Z',
      }),
    ).rejects.toThrow('Channel timestamp must be canonical ISO 8601')
  })

  it('does not update channel projections when channel commit fails', async () => {
    const adapters = createTestRegistryAdapters()
    await publishRelease(
      {
        ...createPublishInput(),
        createdAt: '2026-06-01T00:00:00.000Z',
      },
      adapters,
    )
    const enqueue = vi.fn(() => Promise.resolve())
    adapters.queue.enqueue = enqueue
    adapters.database.commitPackageChannelUpdate = () => {
      throw new Error('channel commit failed')
    }
    adapters.database.commitPackageChannelDelete = () => {
      throw new Error('channel commit failed')
    }

    await expect(
      updatePackageChannel(adapters, {
        channel: 'beta',
        packageId: 'npm:example.com/hello-regesta',
        timestamp: '2026-06-01T00:01:00.000Z',
        version: '0.0.1',
      }),
    ).rejects.toThrow('channel commit failed')
    await expect(
      deletePackageChannel(adapters, {
        channel: 'latest',
        packageId: 'npm:example.com/hello-regesta',
        timestamp: '2026-06-01T00:02:00.000Z',
      }),
    ).rejects.toThrow('channel commit failed')

    await expect(
      adapters.database.getPackageChannels('npm:example.com/hello-regesta'),
    ).resolves.toEqual({ latest: '0.0.1' })
    expect(enqueue).not.toHaveBeenCalled()
  })

  it('keeps committed channel mutations visible when derived queue enqueue fails', async () => {
    const adapters = createTestRegistryAdapters()
    await publishRelease(
      {
        ...createPublishInput(),
        createdAt: '2026-06-01T00:00:00.000Z',
      },
      adapters,
    )
    const queueError = new Error('queue unavailable')
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    adapters.queue.enqueue = () => Promise.reject(queueError)

    try {
      const update = await updatePackageChannel(adapters, {
        channel: 'beta',
        packageId: 'npm:example.com/hello-regesta',
        timestamp: '2026-06-01T00:01:00.000Z',
        version: '0.0.1',
      })

      expect(update.previousVersion).toBeUndefined()

      await expect(
        deletePackageChannel(adapters, {
          channel: 'latest',
          packageId: 'npm:example.com/hello-regesta',
          timestamp: '2026-06-01T00:02:00.000Z',
        }),
      ).resolves.toMatchObject({
        previousVersion: '0.0.1',
      })
      await Promise.resolve()
      await expect(
        getPackageState(adapters, 'npm:example.com/hello-regesta'),
      ).resolves.toMatchObject({
        channels: {
          beta: '0.0.1',
        },
      })
      expect(consoleError).toHaveBeenCalledWith(
        'Regesta derived queue enqueue failed',
        {
          error: queueError,
          kind: 'regesta.derived-queue-failure',
          payload: {
            channel: 'beta',
            package: 'npm:example.com/hello-regesta',
            version: '0.0.1',
          },
          topic: 'channel.updated',
        },
      )
      expect(consoleError).toHaveBeenCalledWith(
        'Regesta derived queue enqueue failed',
        {
          error: queueError,
          kind: 'regesta.derived-queue-failure',
          payload: {
            channel: 'latest',
            package: 'npm:example.com/hello-regesta',
          },
          topic: 'channel.deleted',
        },
      )
    } finally {
      consoleError.mockRestore()
    }
  })

  it('rejects replayed write authorization payload digests', async () => {
    const adapters = createTestRegistryAdapters()
    await publishRelease(
      {
        ...createPublishInput(),
        createdAt: '2026-06-01T00:00:00.000Z',
      },
      adapters,
    )
    const authorization = createAuthorizationProof('channel-update')

    await updatePackageChannel(adapters, {
      authorization,
      channel: 'latest',
      packageId: 'npm:example.com/hello-regesta',
      version: '0.0.1',
    })
    adapters.database.getEventLog = () => {
      throw new Error('replay guard should not scan the event log')
    }

    await expect(
      updatePackageChannel(adapters, {
        authorization,
        channel: 'latest',
        packageId: 'npm:example.com/hello-regesta',
        version: '0.0.1',
      }),
    ).rejects.toThrow(WriteAuthorizationReplayError)
  })

  it('rejects release manifests that claim trusted build verification in v0', async () => {
    const adapters = createTestRegistryAdapters()

    await publishRelease(
      {
        ...createPublishInput(),
        createdAt: '2026-06-01T00:00:00.000Z',
      },
      adapters,
    )

    const release = await adapters.database.getRelease(
      'npm:example.com/hello-regesta',
      '0.0.1',
    )

    Object.assign(release!.manifest, {
      provenance: {
        level: 'trusted-builder',
        verified: true,
      },
    })

    const verification = await verifyRelease(
      adapters,
      'npm:example.com/hello-regesta',
      '0.0.1',
    )

    expect(verification.ok).toBe(false)
    expect(verification.problems).toContain(
      'Release provenance must be source-attached',
    )
    expect(verification.problems).toContain(
      'V0 release provenance must not claim verified build status',
    )
  })

  it('verifies releases by event id without scanning the full event log', async () => {
    const adapters = createTestRegistryAdapters()
    await publishRelease(
      {
        ...createPublishInput(),
        createdAt: '2026-06-01T00:00:00.000Z',
      },
      adapters,
    )
    adapters.database.getEventLog = () => {
      throw new Error('verification should not scan the event log')
    }

    const verification = await verifyRelease(
      adapters,
      'npm:example.com/hello-regesta',
      '0.0.1',
    )

    expect(verification.ok).toBe(true)
  })

  it('rejects releases whose manifest object is missing from storage', async () => {
    const adapters = createTestRegistryAdapters()
    const result = await publishRelease(
      {
        ...createPublishInput(),
        createdAt: '2026-06-01T00:00:00.000Z',
      },
      adapters,
    )
    const getObject = adapters.objects.get.bind(adapters.objects)
    adapters.objects.get = (digest) => {
      if (digest === result.manifestDescriptor.digest) {
        return Promise.resolve(undefined)
      }

      return getObject(digest)
    }

    const verification = await verifyRelease(
      adapters,
      'npm:example.com/hello-regesta',
      '0.0.1',
    )

    expect(verification.ok).toBe(false)
    expect(verification.problems).toContain(
      `Release manifest object missing: ${result.manifestDescriptor.digest}`,
    )
  })

  it('reports stored object byte length mismatches against descriptors', async () => {
    const adapters = createTestRegistryAdapters()
    const result = await publishRelease(
      {
        ...createPublishInput(),
        createdAt: '2026-06-01T00:00:00.000Z',
      },
      adapters,
    )
    const getObject = adapters.objects.get.bind(adapters.objects)
    adapters.objects.get = async (digest) => {
      const object = await getObject(digest)

      if (digest !== result.manifest.source.digest || !object) {
        return object
      }

      return {
        bytes: bytes('short source'),
        descriptor: object.descriptor,
      }
    }

    const verification = await verifyRelease(
      adapters,
      'npm:example.com/hello-regesta',
      '0.0.1',
    )

    expect(verification.ok).toBe(false)
    expect(verification.problems).toContain(
      `Source object byte length does not match descriptor: ${result.manifest.source.digest}`,
    )
    expect(verification.problems).toContain(
      `Source object bytes digest mismatch: ${result.manifest.source.digest}`,
    )
  })

  it('reports stored object descriptor mismatches before reading bytes', async () => {
    const adapters = createTestRegistryAdapters()
    const result = await publishRelease(
      {
        ...createPublishInput(),
        createdAt: '2026-06-01T00:00:00.000Z',
      },
      adapters,
    )
    const getDescriptor = adapters.objects.getDescriptor.bind(adapters.objects)
    const getObject = adapters.objects.get.bind(adapters.objects)
    let sourceObjectReads = 0

    adapters.objects.getDescriptor = async (digest) => {
      const descriptor = await getDescriptor(digest)

      if (digest !== result.manifest.source.digest || !descriptor) {
        return descriptor
      }

      return {
        ...descriptor,
        size: descriptor.size + 1,
      }
    }
    adapters.objects.get = (digest) => {
      if (digest === result.manifest.source.digest) {
        sourceObjectReads += 1
      }

      return getObject(digest)
    }

    const verification = await verifyRelease(
      adapters,
      'npm:example.com/hello-regesta',
      '0.0.1',
    )

    expect(verification.ok).toBe(false)
    expect(verification.problems).toContain(
      `Source object size mismatch: ${result.manifest.source.digest}`,
    )
    expect(sourceObjectReads).toBe(0)
  })

  it('reports stored object descriptor read failures before reading bytes', async () => {
    const adapters = createTestRegistryAdapters()
    const result = await publishRelease(
      {
        ...createPublishInput(),
        createdAt: '2026-06-01T00:00:00.000Z',
      },
      adapters,
    )
    const getDescriptor = adapters.objects.getDescriptor.bind(adapters.objects)
    const getObject = adapters.objects.get.bind(adapters.objects)
    let sourceObjectReads = 0

    adapters.objects.getDescriptor = (digest) => {
      if (digest === result.manifest.source.digest) {
        throw new Error('source descriptor is corrupted')
      }

      return getDescriptor(digest)
    }
    adapters.objects.get = (digest) => {
      if (digest === result.manifest.source.digest) {
        sourceObjectReads += 1
      }

      return getObject(digest)
    }

    const verification = await verifyRelease(
      adapters,
      'npm:example.com/hello-regesta',
      '0.0.1',
    )

    expect(verification.ok).toBe(false)
    expect(verification.problems).toContain(
      'Source object descriptor read failed: source descriptor is corrupted',
    )
    expect(sourceObjectReads).toBe(0)
  })

  it('rejects releases whose manifest identity differs from the requested release', async () => {
    const adapters = createTestRegistryAdapters()
    await publishRelease(
      {
        ...createPublishInput(),
        createdAt: '2026-06-01T00:00:00.000Z',
      },
      adapters,
    )

    const release = await adapters.database.getRelease(
      'npm:example.com/hello-regesta',
      '0.0.1',
    )
    Object.assign(release!.manifest, {
      ecosystem: 'npm',
      id: 'npm:example.com/other-package',
      name: 'example.com/other-package',
      version: '0.0.2',
    })

    const verification = await verifyRelease(
      adapters,
      'npm:example.com/hello-regesta',
      '0.0.1',
    )

    expect(verification.ok).toBe(false)
    expect(verification.problems).toContain(
      'Release manifest package id does not match requested package id',
    )
    expect(verification.problems).toContain(
      'Release manifest version does not match requested version',
    )
  })

  it('reports invalid release manifest package ids without throwing', async () => {
    const adapters = createTestRegistryAdapters()
    await publishRelease(
      {
        ...createPublishInput(),
        createdAt: '2026-06-01T00:00:00.000Z',
      },
      adapters,
    )

    const release = await adapters.database.getRelease(
      'npm:example.com/hello-regesta',
      '0.0.1',
    )
    Object.assign(release!.manifest, {
      id: 'invalid-id',
    })

    const verification = await verifyRelease(
      adapters,
      'npm:example.com/hello-regesta',
      '0.0.1',
    )

    expect(verification.ok).toBe(false)
    expect(verification.problems).toContain('Invalid package id: invalid-id')
  })

  it('reports null release metadata without throwing', async () => {
    const adapters = createTestRegistryAdapters()
    await publishRelease(
      {
        ...createPublishInput(),
        createdAt: '2026-06-01T00:00:00.000Z',
      },
      adapters,
    )

    const release = await adapters.database.getRelease(
      'npm:example.com/hello-regesta',
      '0.0.1',
    )
    Object.assign(release!.manifest, {
      metadata: null,
    })

    const verification = await verifyRelease(
      adapters,
      'npm:example.com/hello-regesta',
      '0.0.1',
    )

    expect(verification.ok).toBe(false)
    expect(verification.problems).toContain(
      'Release metadata must be an object',
    )
  })

  it('reports non-canonical artifact ecosystem metadata without throwing', async () => {
    const adapters = createTestRegistryAdapters()
    await publishRelease(
      {
        ...createPublishInput(),
        createdAt: '2026-06-01T00:00:00.000Z',
      },
      adapters,
    )

    const release = await adapters.database.getRelease(
      'npm:example.com/hello-regesta',
      '0.0.1',
    )
    Object.assign(release!.manifest.artifacts[0]!, {
      ecosystemMetadata: {
        npm: {
          dependencies: {
            tinyexec: undefined,
          },
        },
      },
    })

    const verification = await verifyRelease(
      adapters,
      'npm:example.com/hello-regesta',
      '0.0.1',
    )

    expect(verification.ok).toBe(false)
    expect(verification.problems).toContain(
      'Release artifact ecosystemMetadata must contain only canonical JSON values: Canonical JSON does not support undefined values',
    )
    expect(verification.problems).toContain(
      'Release manifest canonicalization failed: Canonical JSON does not support undefined values',
    )
  })

  it('reports release manifest protocol field problems without throwing', async () => {
    const adapters = createTestRegistryAdapters()
    await publishRelease(
      {
        ...createPublishInput(),
        createdAt: '2026-06-01T00:00:00.000Z',
      },
      adapters,
    )

    const release = await adapters.database.getRelease(
      'npm:example.com/hello-regesta',
      '0.0.1',
    )
    Object.assign(release!.manifest, {
      configDigest: 'sha256:not-a-digest',
      createdAt: '2026-06-01T00:00:00Z',
      extra: true,
      family: 1,
      languages: 'typescript',
      version: '',
    })
    Object.assign(release!.manifest.metadata!, {
      deprecated: false,
      description: 1,
      exports: false,
      repository: 1,
    })
    Object.assign(release!.manifest.provenance, {
      builder: 'test-builder',
    })
    Object.assign(release!.manifest.source, {
      extra: true,
    })
    Object.assign(release!.manifest.artifacts[0]!, {
      compatibility: {
        abi: [
          {
            name: 'napi',
            versions: '8',
          },
        ],
        extra: true,
        modules: 'esm',
        platforms: [
          {
            os: 'linux',
          },
        ],
        runtimes: [
          'node',
          {
            conditions: 'import',
            name: 'node\r\nx',
          },
        ],
      },
      ecosystemMetadata: 'npm',
      extra: true,
      filename: '',
      format: '',
      role: '',
    })

    const verification = await verifyRelease(
      adapters,
      'npm:example.com/hello-regesta',
      '0.0.1',
    )

    expect(verification.ok).toBe(false)
    expect(verification.problems).toContain(
      'Release manifest must not include unknown field: extra',
    )
    expect(verification.problems).toContain(
      'Release manifest configDigest is invalid: Invalid sha256 digest: sha256:not-a-digest',
    )
    expect(verification.problems).toContain(
      'Release manifest createdAt is invalid: Release manifest createdAt must be canonical ISO 8601',
    )
    expect(verification.problems).toContain(
      'Release manifest version must be a non-empty string',
    )
    expect(verification.problems).toContain(
      'Release metadata must not include unknown field: deprecated',
    )
    expect(verification.problems).toContain(
      'Release metadata description must be a string',
    )
    expect(verification.problems).toContain(
      'Release metadata exports must be JSON string, null, array, or object values',
    )
    expect(verification.problems).toContain(
      'Release metadata repository must be a string',
    )
    expect(verification.problems).toContain(
      'Release manifest family must be a string',
    )
    expect(verification.problems).toContain(
      'Release manifest languages must be an array',
    )
    expect(verification.problems).toContain(
      'Release provenance must not include unknown field: builder',
    )
    expect(verification.problems).toContain(
      'Release source descriptor must not include unknown field: extra',
    )
    expect(verification.problems).toContain(
      'Release artifact descriptor must not include unknown field: extra',
    )
    expect(verification.problems).toContain(
      'Release artifact role must be a non-empty string',
    )
    expect(verification.problems).toContain(
      'Release artifact filename must be a non-empty string',
    )
    expect(verification.problems).toContain(
      'Release artifact format must be a non-empty string',
    )
    expect(verification.problems).toContain(
      'Release artifact compatibility must not include unknown field: extra',
    )
    expect(verification.problems).toContain(
      'Release artifact ABI compatibility versions must be an array',
    )
    expect(verification.problems).toContain(
      'Release artifact compatibility modules must be an array',
    )
    expect(verification.problems).toContain(
      'Release artifact platform compatibility os must be an array',
    )
    expect(verification.problems).toContain(
      'Release artifact runtime compatibility conditions must be an array',
    )
    expect(verification.problems).toContain(
      'Release artifact runtime compatibility name must not include control characters',
    )
    expect(verification.problems).toContain(
      'Release artifact ecosystemMetadata must be an object',
    )
  })

  it('reports malformed release object references without throwing', async () => {
    const adapters = createTestRegistryAdapters()
    await publishRelease(
      {
        ...createPublishInput(),
        createdAt: '2026-06-01T00:00:00.000Z',
      },
      adapters,
    )

    const release = await adapters.database.getRelease(
      'npm:example.com/hello-regesta',
      '0.0.1',
    )
    Object.assign(release!, {
      manifestDescriptor: 'not-a-descriptor',
    })
    Object.assign(release!.manifest, {
      artifacts: 'not-artifacts',
      source: null,
    })

    const verification = await verifyRelease(
      adapters,
      'npm:example.com/hello-regesta',
      '0.0.1',
    )

    expect(verification.ok).toBe(false)
    expect(verification.problems).toContain(
      'Release manifest descriptor must be an object',
    )
    expect(verification.problems).toContain(
      'Release source descriptor must be an object',
    )
    expect(verification.problems).toContain(
      'Release manifest artifacts must be an array',
    )
  })

  it('reports non-canonical manifests and mismatched log events without throwing', async () => {
    const adapters = createTestRegistryAdapters()
    await publishRelease(
      {
        ...createPublishInput(),
        createdAt: '2026-06-01T00:00:00.000Z',
      },
      adapters,
    )

    const release = await adapters.database.getRelease(
      'npm:example.com/hello-regesta',
      '0.0.1',
    )
    Object.assign(release!.manifest.metadata!, {
      description: undefined,
    })
    const getEvent = adapters.database.getEvent
    adapters.database.getEvent = async (id) => {
      const event = await getEvent(id)
      return event
        ? {
            ...event,
            channel: 'beta',
          }
        : undefined
    }

    const verification = await verifyRelease(
      adapters,
      'npm:example.com/hello-regesta',
      '0.0.1',
    )

    expect(verification.ok).toBe(false)
    expect(verification.problems).toContain(
      'Release manifest canonicalization failed: Canonical JSON does not support undefined values',
    )
    expect(verification.problems).toContain(
      'Publish event log entry does not match stored release event',
    )
  })

  it('reports publish event authorization protocol problems without throwing', async () => {
    const adapters = createTestRegistryAdapters()
    await publishRelease(
      {
        ...createPublishInput(),
        authorization: createAuthorizationProof('verifier auth problems'),
      },
      adapters,
    )

    const release = await adapters.database.getRelease(
      'npm:example.com/hello-regesta',
      '0.0.1',
    )
    Object.assign(release!.event, {
      extra: true,
    })
    Object.assign(release!.event.release, {
      extra: true,
      manifestDigest: 'sha256:not-a-digest',
      version: '',
    })
    Object.assign(release!.event, {
      artifactDigests: ['sha256:not-a-digest'],
      sourceDigest: 'sha256:not-a-digest',
    })
    Object.assign(release!.event.authorization!, {
      domain: 'other.example.com',
      extra: true,
      payloadDigest: 'sha256:not-a-digest',
      signature: 'YWJj',
      signedAt: '2026-06-01T00:01:00.000Z',
      wellKnownDigest: 'sha256:not-a-digest',
    })
    Object.assign(release!.event.authorization!.publicKeyJwk, {
      key_ops: ['verify'],
      x: 'YWJj',
    })

    const verification = await verifyRelease(
      adapters,
      'npm:example.com/hello-regesta',
      '0.0.1',
    )

    expect(verification.ok).toBe(false)
    expect(verification.problems).toContain(
      'Publish event must not include unknown field: extra',
    )
    expect(verification.problems).toContain(
      'Publish event release must not include unknown field: extra',
    )
    expect(verification.problems).toContain(
      'Publish event release manifestDigest is invalid: Invalid sha256 digest: sha256:not-a-digest',
    )
    expect(verification.problems).toContain(
      'Publish event release version must be a non-empty string',
    )
    expect(verification.problems).toContain(
      'Publish event sourceDigest is invalid: Invalid sha256 digest: sha256:not-a-digest',
    )
    expect(verification.problems).toContain(
      'Publish event artifactDigests[0] is invalid: Invalid sha256 digest: sha256:not-a-digest',
    )

    Object.assign(release!.event, {
      artifactDigests: [],
    })
    const emptyArtifactDigestVerification = await verifyRelease(
      adapters,
      'npm:example.com/hello-regesta',
      '0.0.1',
    )

    expect(emptyArtifactDigestVerification.ok).toBe(false)
    expect(emptyArtifactDigestVerification.problems).toContain(
      'Publish event artifactDigests must not be empty',
    )

    expect(verification.problems).toContain(
      'Publish event authorization must not include unknown field: extra',
    )
    expect(verification.problems).toContain(
      'Publish event authorization domain does not match package owner',
    )
    expect(verification.problems).toContain(
      'Publish event authorization signature must be an Ed25519 signature',
    )
    expect(verification.problems).toContain(
      'Publish event authorization payloadDigest is invalid: Invalid sha256 digest: sha256:not-a-digest',
    )
    expect(verification.problems).toContain(
      'Publish event authorization wellKnownDigest is invalid: Invalid sha256 digest: sha256:not-a-digest',
    )
    expect(verification.problems).toContain(
      'Publish event authorization signedAt must match event timestamp',
    )
    expect(verification.problems).toContain(
      'Publish event authorization publicKeyJwk must not include unknown field: key_ops',
    )
    expect(verification.problems).toContain(
      'Publish event authorization publicKeyJwk.x must be an Ed25519 public key',
    )
  })

  it('reports object store read failures without throwing', async () => {
    const adapters = createTestRegistryAdapters()
    const result = await publishRelease(
      {
        ...createPublishInput(),
        createdAt: '2026-06-01T00:00:00.000Z',
      },
      adapters,
    )
    const getObject = adapters.objects.get.bind(adapters.objects)
    adapters.objects.get = (digest) => {
      if (digest === result.manifest.source.digest) {
        throw new Error('source object is corrupted')
      }

      return getObject(digest)
    }

    const verification = await verifyRelease(
      adapters,
      'npm:example.com/hello-regesta',
      '0.0.1',
    )

    expect(verification.ok).toBe(false)
    expect(verification.problems).toContain(
      'Source object read failed: source object is corrupted',
    )
  })
})

function createPublishInput(): PublishInput {
  return {
    artifacts: [
      {
        bytes: bytes('install artifact'),
        compatibility: {
          modules: ['esm'],
          runtimes: ['node', 'bun'],
        },
        format: 'npm-tarball',
        mediaType: 'application/gzip',
        role: 'install',
      },
    ],
    config: {
      description: 'Test package',
      exports: {
        '.': './src/index.ts',
      },
      id: 'npm:example.com/hello-regesta',
      languages: ['typescript'],
      provenance: {
        level: 'source-attached',
      },
      source: {
        include: ['regesta.json'],
      },
      version: '0.0.1',
    },
    source: bytes('source archive'),
  }
}

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value)
}

function createAuthorizationProof(value: string): WriteAuthorizationProof {
  return {
    alg: 'EdDSA',
    domain: 'example.com',
    kid: 'test-key',
    object: 'regesta.authorization-proof',
    payloadDigest: sha256(bytes(value)),
    publicKeyJwk: {
      crv: 'Ed25519',
      kty: 'OKP',
      x: TEST_ED25519_PUBLIC_KEY,
    },
    signature: TEST_ED25519_SIGNATURE,
    signedAt: '2026-06-01T00:00:00.000Z',
    wellKnownDigest: sha256(bytes('well-known')),
  }
}

function createTestRegistryAdapters(): RegistryAdapters {
  const objects = new Map<string, StoredObject>()
  const events: RegistryEvent[] = []
  const releases = new Map<PackageId, Map<string, StoredRelease>>()
  const channels = new Map<PackageId, Record<string, string>>()

  return {
    database: {
      appendEvent: (event) => {
        events.push(event)
        return Promise.resolve()
      },
      commitPackageChannelDelete: (event) => {
        events.push(event)

        const packageChannels = channels.get(event.package) ?? {}
        delete packageChannels[event.channel]
        channels.set(event.package, packageChannels)

        return Promise.resolve()
      },
      commitPackageChannelUpdate: (event) => {
        events.push(event)

        const packageChannels = channels.get(event.package) ?? {}
        channels.set(event.package, {
          ...packageChannels,
          [event.channel]: event.version,
        })

        return Promise.resolve()
      },
      commitPublishedRelease: (release, channel) => {
        events.push(release.event)

        const packageReleases =
          releases.get(release.manifest.id) ?? new Map<string, StoredRelease>()
        packageReleases.set(release.manifest.version, release)
        releases.set(release.manifest.id, packageReleases)

        const packageChannels = channels.get(release.manifest.id) ?? {}
        channels.set(release.manifest.id, {
          ...packageChannels,
          [channel]: release.manifest.version,
        })

        return Promise.resolve()
      },
      getEvent: (id) =>
        Promise.resolve(
          events.find((event) => {
            return event.id === id
          }),
        ),
      getEventLog: () => Promise.resolve([...events]),
      getPackageChannels: (packageId) => {
        const packageChannels = channels.get(packageId)

        return Promise.resolve(packageChannels ? { ...packageChannels } : {})
      },
      getRelease: (packageId, version) =>
        Promise.resolve(releases.get(packageId)?.get(version)),
      hasAuthorizationPayloadDigest: (payloadDigest) =>
        Promise.resolve(
          events.some((event) => {
            return event.authorization?.payloadDigest === payloadDigest
          }),
        ),
      listEvents: (options = {}) => {
        const afterIndex = options.after
          ? events.findIndex((event) => event.id === options.after)
          : -1

        if (options.after && afterIndex < 0) {
          return Promise.resolve([])
        }

        const startIndex = afterIndex + 1
        const endIndex =
          options.limit === undefined ? undefined : startIndex + options.limit

        return Promise.resolve(events.slice(startIndex, endIndex))
      },
      listPackageEvents: (packageId) =>
        Promise.resolve(
          events.filter((event) => {
            return eventPackageId(event) === packageId
          }),
        ),
      listPackageReleases: (packageId) =>
        Promise.resolve([...(releases.get(packageId)?.values() ?? [])]),
    },
    objects: {
      get: (digest) => Promise.resolve(objects.get(digest)),
      getDescriptor: (digest) =>
        Promise.resolve(objects.get(digest)?.descriptor),
      listDescriptors: () =>
        Promise.resolve(
          [...objects.values()]
            .map((object) => object.descriptor)
            .toSorted((left, right) => {
              return left.digest.localeCompare(right.digest)
            }),
        ),
      put: (objectBytes, mediaType) => {
        const descriptor = {
          digest: sha256(objectBytes),
          mediaType,
          size: objectBytes.byteLength,
        }
        objects.set(descriptor.digest, {
          bytes: objectBytes,
          descriptor,
        })

        return Promise.resolve(descriptor)
      },
    },
    queue: {
      enqueue: () => Promise.resolve(),
    },
    signer: {
      sign: (objectBytes) => Promise.resolve(objectBytes),
    },
  }
}

function eventPackageId(event: RegistryEvent): PackageId {
  return event.eventType === 'release.published'
    ? event.release.id
    : event.package
}
