import { Buffer } from 'node:buffer'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  ObjectCursorNotFoundError,
  PackageChannelConflictError,
  RegistryEventAlreadyExistsError,
  RegistryEventIntegrityError,
  ReleaseAlreadyExistsError,
  ReleaseNotFoundError,
  WriteAuthorizationReplayError,
} from '@regesta/core'
import {
  canonicalJson,
  parsePackageId,
  registryEventDigest,
  sha256,
  type ChannelDeletedEvent,
  type ChannelUpdatedEvent,
  type PackageId,
  type PublishReleaseEvent,
  type RegistryEvent,
  type Sha256Digest,
} from '@regesta/protocol'
import { describe, expect, it } from 'vitest'
import {
  createLocalRegistryAdapters,
  LocalQueueAdapter,
  LocalSignerAdapter,
} from './local.ts'
import {
  MemoryCheckpointStore,
  MemoryObjectStore,
  MemoryRegistryDatabase,
  MemorySignerAdapter,
} from './memory.ts'
import { describeRegistryDatabaseConformance } from './registry-database.conformance.ts'
import { SQLiteRegistryDatabase } from './sqlite.ts'
import type { StoredRelease } from './interfaces.ts'

const TEST_ED25519_PUBLIC_KEY = Buffer.alloc(32, 1).toString('base64url')
const TEST_ED25519_SIGNATURE = Buffer.alloc(64, 2).toString('base64url')

describeRegistryDatabaseConformance({
  create: () => new MemoryRegistryDatabase(),
  name: 'MemoryRegistryDatabase',
})

describeRegistryDatabaseConformance({
  create: () => new SQLiteRegistryDatabase(':memory:'),
  destroy: (database) => {
    database.close()
  },
  name: 'SQLiteRegistryDatabase',
})

describe('CheckpointStore adapters', () => {
  it('keeps memory checkpoint bytes independent from ordinary object bytes', async () => {
    const checkpoints = new MemoryCheckpointStore()
    const objects = new MemoryObjectStore()
    const checkpointBytes = bytes('checkpoint bytes')

    const checkpoint = await checkpoints.put(
      checkpointBytes,
      'application/octet-stream',
    )

    await expect(objects.get(checkpoint.digest)).resolves.toBeUndefined()
    await expect(checkpoints.get(checkpoint.digest)).resolves.toMatchObject({
      descriptor: checkpoint,
    })
    await expect(
      checkpoints.put(checkpointBytes, 'application/octet-stream'),
    ).resolves.toEqual(checkpoint)
    expect(() => checkpoints.put(checkpointBytes, 'application/json')).toThrow(
      `Memory object mediaType conflict: ${checkpoint.digest}`,
    )
  })

  it('persists local checkpoint bytes separately from ordinary object bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'regesta-checkpoints-'))

    try {
      const firstAdapters = createLocalRegistryAdapters(root)
      const checkpoints = firstAdapters.checkpoints
      if (!checkpoints) {
        throw new Error(
          'Expected local registry adapters to include checkpoints',
        )
      }
      const checkpointBytes = bytes('local checkpoint bytes')
      const checkpoint = await checkpoints.put(
        checkpointBytes,
        'application/octet-stream',
      )

      await expect(
        firstAdapters.objects.get(checkpoint.digest),
      ).resolves.toBeUndefined()

      const secondAdapters = createLocalRegistryAdapters(root)
      const stored = await secondAdapters.checkpoints?.get(checkpoint.digest)

      expect([...(stored?.bytes ?? [])]).toEqual([...checkpointBytes])
      expect(stored?.descriptor).toEqual(checkpoint)
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })
})

describe('createLocalRegistryAdapters', () => {
  it('persists releases, channels, events, and objects across adapter instances', async () => {
    const root = await mkdtemp(join(tmpdir(), 'regesta-local-'))

    try {
      const firstAdapters = createLocalRegistryAdapters(root)
      const release = storedRelease('npm:example.com/persisted', '0.0.1')
      const source = await firstAdapters.objects.put(
        bytes('source archive'),
        'application/vnd.regesta.source-archive+tgz',
      )
      const artifact = await firstAdapters.objects.put(
        bytes('install artifact'),
        'application/gzip',
      )
      release.manifest.source = source
      release.manifest.artifacts = [
        {
          ...artifact,
          role: 'install',
        },
      ]
      const manifestBytes = bytes(`${canonicalJson(release.manifest)}\n`)
      release.manifestDescriptor = await firstAdapters.objects.put(
        manifestBytes,
        'application/vnd.regesta.release-manifest.v0+json',
      )
      release.event = publishReleaseEvent({
        authorization: {
          alg: 'EdDSA',
          domain: 'example.com',
          kid: 'test-key',
          object: 'regesta.authorization-proof',
          payloadDigest: sha256(bytes('authorization payload')),
          publicKeyJwk: {
            crv: 'Ed25519',
            kty: 'OKP',
            x: TEST_ED25519_PUBLIC_KEY,
          },
          signature: TEST_ED25519_SIGNATURE,
          signedAt: '2026-06-01T00:00:00.000Z',
          wellKnownDigest: sha256(bytes('well-known')),
        },
        artifactDigests: [artifact.digest],
        channel: 'latest',
        eventType: 'release.published',
        object: 'regesta.event',
        release: {
          id: 'npm:example.com/persisted',
          manifestDigest: release.manifestDescriptor.digest,
          version: '0.0.1',
        },
        sourceDigest: source.digest,
        timestamp: '2026-06-01T00:00:00.000Z',
      })

      await firstAdapters.database.commitPublishedRelease(release, 'latest')

      const secondAdapters = createLocalRegistryAdapters(root)
      const persistedRelease = await secondAdapters.database.getRelease(
        'npm:example.com/persisted',
        '0.0.1',
      )

      expect(persistedRelease?.manifest.id).toBe('npm:example.com/persisted')
      await expect(
        secondAdapters.database.getPackageChannels('npm:example.com/persisted'),
      ).resolves.toEqual({ latest: '0.0.1' })
      await expect(secondAdapters.database.getEventLog()).resolves.toEqual([
        release.event,
      ])
      await expect(secondAdapters.database.countPackages()).resolves.toBe(1)
      await expect(
        secondAdapters.database.getEvent(release.event.id),
      ).resolves.toEqual(release.event)
      await expect(
        secondAdapters.database.hasAuthorizationPayloadDigest(
          release.event.authorization.payloadDigest,
        ),
      ).resolves.toBe(true)
      await expect(
        secondAdapters.objects.get(source.digest),
      ).resolves.toMatchObject({
        descriptor: source,
      })
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it('rejects corrupted local object bytes and metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'regesta-local-object-'))

    try {
      const adapters = createLocalRegistryAdapters(root)
      const descriptor = await adapters.objects.put(
        bytes('object bytes'),
        'application/octet-stream',
      )

      await writeFile(
        objectPath(root, descriptor.digest),
        bytes('OBJECT bytes'),
      )

      await expect(adapters.objects.get(descriptor.digest)).rejects.toThrow(
        `Local object bytes digest mismatch: ${descriptor.digest}`,
      )

      await writeFile(
        objectPath(root, descriptor.digest),
        bytes('object bytes'),
      )
      await writeFile(
        `${objectPath(root, descriptor.digest)}.json`,
        `${JSON.stringify({
          ...descriptor,
          digest: sha256(bytes('other object')),
        })}\n`,
      )

      await expect(adapters.objects.get(descriptor.digest)).rejects.toThrow(
        `Local object metadata digest mismatch: ${descriptor.digest}`,
      )
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it('reads local object descriptors without returning object bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'regesta-local-object-'))

    try {
      const adapters = createLocalRegistryAdapters(root)
      const descriptor = await adapters.objects.put(
        bytes('object bytes'),
        'application/octet-stream',
      )
      const readDescriptor = await adapters.objects.getDescriptor(
        descriptor.digest,
      )

      expect(readDescriptor).toEqual(descriptor)

      if (!readDescriptor) {
        throw new Error('Expected stored object descriptor to exist')
      }

      readDescriptor.size = 0

      await expect(
        adapters.objects.getDescriptor(descriptor.digest),
      ).resolves.toEqual(descriptor)
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it('does not expose mutable local object byte or descriptor references', async () => {
    const root = await mkdtemp(join(tmpdir(), 'regesta-local-object-'))

    try {
      const adapters = createLocalRegistryAdapters(root)
      const objectBytes = bytes('object bytes')
      const descriptor = await adapters.objects.put(
        objectBytes,
        'application/octet-stream',
      )
      const expectedDescriptor = { ...descriptor }

      objectBytes[0] = 0
      descriptor.size = 0

      const firstRead = await adapters.objects.get(expectedDescriptor.digest)

      expect(text(firstRead?.bytes)).toBe('object bytes')
      expect(firstRead?.descriptor).toEqual(expectedDescriptor)

      if (!firstRead) {
        throw new Error('Expected stored object to exist')
      }

      firstRead.bytes[0] = 0
      firstRead.descriptor.size = 0

      const secondRead = await adapters.objects.get(expectedDescriptor.digest)

      expect(text(secondRead?.bytes)).toBe('object bytes')
      expect(secondRead?.descriptor).toEqual(expectedDescriptor)

      const descriptorRead = await adapters.objects.getDescriptor(
        expectedDescriptor.digest,
      )
      expect(descriptorRead).toEqual(expectedDescriptor)

      if (!descriptorRead) {
        throw new Error('Expected stored object descriptor to exist')
      }

      descriptorRead.size = 0

      await expect(
        adapters.objects.getDescriptor(expectedDescriptor.digest),
      ).resolves.toEqual(expectedDescriptor)
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it('rejects invalid local object digests before building filesystem paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'regesta-local-object-'))

    try {
      const adapters = createLocalRegistryAdapters(root)
      const digest: Sha256Digest = JSON.parse('"sha256:../../outside"')

      await expect(adapters.objects.get(digest)).rejects.toThrow(
        'Invalid sha256 digest: sha256:../../outside',
      )
      await expect(adapters.objects.getDescriptor(digest)).rejects.toThrow(
        'Invalid sha256 digest: sha256:../../outside',
      )
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it('checks local object store readiness without committing probe objects', async () => {
    const root = await mkdtemp(join(tmpdir(), 'regesta-local-object-'))

    try {
      const adapters = createLocalRegistryAdapters(root)

      if (!adapters.objects.checkReadiness) {
        throw new Error('Expected local object store readiness check to exist')
      }

      await expect(adapters.objects.checkReadiness()).resolves.toBeUndefined()
      await expect(readdirRecursive(join(root, 'objects'))).resolves.toEqual([])
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it('checks local checkpoint store readiness without committing probe checkpoints', async () => {
    const root = await mkdtemp(join(tmpdir(), 'regesta-local-checkpoints-'))

    try {
      const adapters = createLocalRegistryAdapters(root)
      const checkpoints = adapters.checkpoints
      if (!checkpoints?.checkReadiness) {
        throw new Error(
          'Expected local checkpoint store readiness check to exist',
        )
      }

      await expect(checkpoints.checkReadiness()).resolves.toBeUndefined()
      await expect(
        readdirRecursive(join(root, 'checkpoints', 'objects')),
      ).resolves.toEqual([])
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it('checks registry database readiness', async () => {
    const memory = new MemoryRegistryDatabase()
    const sqlite = new SQLiteRegistryDatabase(':memory:')

    try {
      await expect(memory.checkReadiness()).resolves.toBeUndefined()
      await expect(sqlite.checkReadiness()).resolves.toBeUndefined()
    } finally {
      sqlite.close()
    }
  })

  it('checks local queue readiness without appending probe messages', async () => {
    const root = await mkdtemp(join(tmpdir(), 'regesta-local-queue-'))

    try {
      const queue = new LocalQueueAdapter(root)

      await expect(queue.checkReadiness()).resolves.toBeUndefined()
      await expect(readdirRecursive(root)).resolves.toEqual([])
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it('appends local queue messages as newline-delimited JSON', async () => {
    const root = await mkdtemp(join(tmpdir(), 'regesta-local-queue-'))

    try {
      const queue = new LocalQueueAdapter(root)

      await queue.enqueue('release.published', {
        package: 'npm:example.com/queued',
        version: '0.0.1',
      })
      await queue.enqueue('channel.updated', {
        channel: 'latest',
        package: 'npm:example.com/queued',
        version: '0.0.1',
      })

      const text = await readFile(join(root, 'queue.ndjson'), 'utf8')
      const entries = text
        .trimEnd()
        .split('\n')
        .map((line) => JSON.parse(line))

      expect(text.endsWith('\n')).toBe(true)
      expect(entries).toHaveLength(2)
      expect(entries.every(hasCanonicalEnqueuedAt)).toBe(true)
      expect(entries).toEqual([
        {
          enqueuedAt: expect.any(String),
          payload: {
            package: 'npm:example.com/queued',
            version: '0.0.1',
          },
          topic: 'release.published',
        },
        {
          enqueuedAt: expect.any(String),
          payload: {
            channel: 'latest',
            package: 'npm:example.com/queued',
            version: '0.0.1',
          },
          topic: 'channel.updated',
        },
      ])
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it('preserves parseable local queue entries across concurrent shared-root adapters', async () => {
    const root = await mkdtemp(join(tmpdir(), 'regesta-local-queue-'))

    try {
      const firstQueue = new LocalQueueAdapter(root)
      const secondQueue = new LocalQueueAdapter(root)
      const messages = Array.from({ length: 20 }, (_, index) => {
        return {
          payload: {
            index,
            package: 'npm:example.com/concurrent-queue',
          },
          topic: index % 2 === 0 ? 'release.published' : 'channel.updated',
        }
      })

      await Promise.all(
        messages.map((message, index) => {
          const queue = index % 2 === 0 ? firstQueue : secondQueue
          return queue.enqueue(message.topic, message.payload)
        }),
      )

      const text = await readFile(join(root, 'queue.ndjson'), 'utf8')
      const entries = text
        .trimEnd()
        .split('\n')
        .map((line) => JSON.parse(line))

      expect(text.endsWith('\n')).toBe(true)
      expect(entries).toHaveLength(messages.length)
      expect(entries.every(hasCanonicalEnqueuedAt)).toBe(true)
      expect(entries).toEqual(
        expect.arrayContaining(
          messages.map((message) => {
            return {
              enqueuedAt: expect.any(String),
              payload: message.payload,
              topic: message.topic,
            }
          }),
        ),
      )
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it('rejects non-serializable local queue messages without appending partial entries', async () => {
    const root = await mkdtemp(join(tmpdir(), 'regesta-local-queue-'))

    try {
      const queue = new LocalQueueAdapter(root)
      const payload: Record<string, unknown> = {}
      payload.self = payload

      await expect(queue.enqueue('release.published', payload)).rejects.toThrow(
        /circular|cyclic/iu,
      )
      await expect(readdirRecursive(root)).resolves.toEqual([])
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it('checks local signer readiness', async () => {
    const signer = new LocalSignerAdapter()

    await expect(signer.checkReadiness()).resolves.toBeUndefined()
  })

  it('keeps local and memory signer adapters deterministic', async () => {
    const payload = bytes('server-side signing payload')
    const expectedSignature = bytes(sha256(payload))

    await expect(new LocalSignerAdapter().sign(payload)).resolves.toEqual(
      expectedSignature,
    )
    await expect(new MemorySignerAdapter().sign(payload)).resolves.toEqual(
      expectedSignature,
    )
    await expect(
      new MemorySignerAdapter().checkReadiness(),
    ).resolves.toBeUndefined()
  })

  it('rejects partially missing local object files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'regesta-local-object-'))

    try {
      const adapters = createLocalRegistryAdapters(root)
      const missingMetadata = await adapters.objects.put(
        bytes('object bytes'),
        'application/octet-stream',
      )
      const missingBytes = await adapters.objects.put(
        bytes('other object bytes'),
        'application/octet-stream',
      )

      await rm(`${objectPath(root, missingMetadata.digest)}.json`)

      await expect(
        adapters.objects.get(missingMetadata.digest),
      ).rejects.toThrow(
        `Local object metadata missing: ${missingMetadata.digest}`,
      )
      await expect(
        adapters.objects.getDescriptor(missingMetadata.digest),
      ).rejects.toThrow(
        `Local object metadata missing: ${missingMetadata.digest}`,
      )

      await rm(objectPath(root, missingBytes.digest))

      await expect(adapters.objects.get(missingBytes.digest)).rejects.toThrow(
        `Local object bytes missing: ${missingBytes.digest}`,
      )
      await expect(
        adapters.objects.getDescriptor(missingBytes.digest),
      ).rejects.toThrow(`Local object bytes missing: ${missingBytes.digest}`)
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it('repairs interrupted local object writes on repeated put', async () => {
    const root = await mkdtemp(join(tmpdir(), 'regesta-local-object-'))

    try {
      const adapters = createLocalRegistryAdapters(root)
      const missingMetadataBytes = bytes('object bytes')
      const missingMetadata = await adapters.objects.put(
        missingMetadataBytes,
        'application/octet-stream',
      )

      await rm(`${objectPath(root, missingMetadata.digest)}.json`)

      await expect(
        adapters.objects.get(missingMetadata.digest),
      ).rejects.toThrow(
        `Local object metadata missing: ${missingMetadata.digest}`,
      )

      await expect(
        adapters.objects.put(missingMetadataBytes, 'application/octet-stream'),
      ).resolves.toEqual(missingMetadata)
      await expect(
        adapters.objects.get(missingMetadata.digest),
      ).resolves.toMatchObject({
        descriptor: missingMetadata,
      })

      const missingObjectBytes = bytes('other object bytes')
      const missingObject = await adapters.objects.put(
        missingObjectBytes,
        'application/octet-stream',
      )

      await rm(objectPath(root, missingObject.digest))

      await expect(adapters.objects.get(missingObject.digest)).rejects.toThrow(
        `Local object bytes missing: ${missingObject.digest}`,
      )

      await expect(
        adapters.objects.put(missingObjectBytes, 'application/octet-stream'),
      ).resolves.toEqual(missingObject)
      await expect(
        adapters.objects.get(missingObject.digest),
      ).resolves.toMatchObject({
        descriptor: missingObject,
      })
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it('rejects interrupted local object metadata media type conflicts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'regesta-local-object-'))

    try {
      const adapters = createLocalRegistryAdapters(root)
      const objectBytes = bytes('object bytes')
      const descriptor = await adapters.objects.put(objectBytes, 'text/plain')

      await rm(objectPath(root, descriptor.digest))

      await expect(
        adapters.objects.put(objectBytes, 'application/octet-stream'),
      ).rejects.toThrow(`Local object mediaType conflict: ${descriptor.digest}`)
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it('rejects malformed local object metadata JSON with the object digest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'regesta-local-object-'))

    try {
      const adapters = createLocalRegistryAdapters(root)
      const descriptor = await adapters.objects.put(
        bytes('object bytes'),
        'application/octet-stream',
      )

      await writeFile(`${objectPath(root, descriptor.digest)}.json`, '{')

      await expect(adapters.objects.get(descriptor.digest)).rejects.toThrow(
        `Local object metadata invalid JSON: ${descriptor.digest}`,
      )
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it('rejects unknown local object metadata fields', async () => {
    const root = await mkdtemp(join(tmpdir(), 'regesta-local-object-'))

    try {
      const adapters = createLocalRegistryAdapters(root)
      const descriptor = await adapters.objects.put(
        bytes('object bytes'),
        'application/octet-stream',
      )

      await writeFile(
        `${objectPath(root, descriptor.digest)}.json`,
        `${JSON.stringify({
          ...descriptor,
          location: 'local-path',
        })}\n`,
      )

      await expect(adapters.objects.get(descriptor.digest)).rejects.toThrow(
        'Local object metadata must not include unknown field: location',
      )
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it('rejects invalid local object descriptors before writing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'regesta-local-object-'))

    try {
      const adapters = createLocalRegistryAdapters(root)

      await expect(
        adapters.objects.put(bytes('object bytes'), ''),
      ).rejects.toThrow('Object mediaType must be a non-empty string')
      await expect(
        adapters.objects.put(bytes('object bytes'), 'text/plain\r\nx: y'),
      ).rejects.toThrow('Object mediaType must not include control characters')
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it('keeps local object descriptors immutable for duplicate bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'regesta-local-object-'))

    try {
      const adapters = createLocalRegistryAdapters(root)
      const objectBytes = bytes('same object bytes')
      const first = await adapters.objects.put(objectBytes, 'text/plain')
      const second = await adapters.objects.put(objectBytes, 'text/plain')

      expect(second).toEqual(first)
      await expect(
        adapters.objects.put(objectBytes, 'application/octet-stream'),
      ).rejects.toThrow(`Local object mediaType conflict: ${first.digest}`)
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it('serializes concurrent local object writes for the same digest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'regesta-local-object-'))

    try {
      const adapters = createLocalRegistryAdapters(root)
      const objectBytes = bytes('concurrent same object bytes')
      const descriptors = await Promise.all(
        Array.from({ length: 8 }, () => {
          return adapters.objects.put(objectBytes, 'text/plain')
        }),
      )
      const [firstDescriptor] = descriptors

      expect(firstDescriptor).toBeDefined()
      expect(descriptors).toEqual(
        Array.from({ length: 8 }, () => firstDescriptor),
      )
      await expect(
        adapters.objects.getDescriptor(firstDescriptor!.digest),
      ).resolves.toEqual(firstDescriptor)
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it('rejects concurrent local object media type conflicts for the same digest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'regesta-local-object-'))

    try {
      const adapters = createLocalRegistryAdapters(root)
      const objectBytes = bytes('concurrent object media type conflict')
      const results = await Promise.allSettled([
        adapters.objects.put(objectBytes, 'text/plain'),
        adapters.objects.put(objectBytes, 'application/octet-stream'),
      ])
      const fulfilled = results.find((result) => {
        return result.status === 'fulfilled'
      })
      const rejected = results.find((result) => {
        return result.status === 'rejected'
      })

      if (!fulfilled || fulfilled.status !== 'fulfilled') {
        throw new Error('Expected one concurrent object write to succeed')
      }

      if (!rejected || rejected.status !== 'rejected') {
        throw new Error('Expected one concurrent object write to fail')
      }

      expect(String(rejected.reason)).toContain(
        `Local object mediaType conflict: ${fulfilled.value.digest}`,
      )
      await expect(
        adapters.objects.getDescriptor(fulfilled.value.digest),
      ).resolves.toEqual(fulfilled.value)
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it('lists local object descriptors in digest order with cursor pagination', async () => {
    const root = await mkdtemp(join(tmpdir(), 'regesta-local-object-'))

    try {
      const adapters = createLocalRegistryAdapters(root)
      const descriptors = await Promise.all([
        adapters.objects.put(bytes('object c'), 'text/plain'),
        adapters.objects.put(bytes('object a'), 'application/octet-stream'),
        adapters.objects.put(bytes('object b'), 'application/json'),
      ])
      const sorted = descriptors.toSorted((left, right) => {
        return left.digest.localeCompare(right.digest)
      })

      await expect(adapters.objects.listDescriptors()).resolves.toEqual(sorted)
      await expect(
        adapters.objects.listDescriptors({ limit: 2 }),
      ).resolves.toEqual(sorted.slice(0, 2))
      await expect(
        adapters.objects.listDescriptors({
          after: sorted[1]!.digest,
          limit: 2,
        }),
      ).resolves.toEqual(sorted.slice(2))

      const read = await adapters.objects.listDescriptors({ limit: 1 })
      read[0]!.size = 0

      await expect(
        adapters.objects.getDescriptor(read[0]!.digest),
      ).resolves.toEqual(sorted[0])
      await expect(
        adapters.objects.listDescriptors({ after: sha256(bytes('missing')) }),
      ).rejects.toThrow(ObjectCursorNotFoundError)
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it('keeps local object descriptors immutable across concurrent adapter instances', async () => {
    const root = await mkdtemp(join(tmpdir(), 'regesta-local-object-'))

    try {
      const firstAdapters = createLocalRegistryAdapters(root)
      const secondAdapters = createLocalRegistryAdapters(root)
      const objectBytes = bytes('shared root same object bytes')
      const [first, second] = await Promise.all([
        firstAdapters.objects.put(objectBytes, 'text/plain'),
        secondAdapters.objects.put(objectBytes, 'text/plain'),
      ])

      expect(second).toEqual(first)
      await expect(
        firstAdapters.objects.getDescriptor(first.digest),
      ).resolves.toEqual(first)
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it('rejects local object media type conflicts across concurrent adapter instances', async () => {
    const root = await mkdtemp(join(tmpdir(), 'regesta-local-object-'))

    try {
      const firstAdapters = createLocalRegistryAdapters(root)
      const secondAdapters = createLocalRegistryAdapters(root)
      const objectBytes = bytes('shared root media type conflict')
      const results = await Promise.allSettled([
        firstAdapters.objects.put(objectBytes, 'text/plain'),
        secondAdapters.objects.put(objectBytes, 'application/octet-stream'),
      ])
      const fulfilled = results.find((result) => {
        return result.status === 'fulfilled'
      })
      const rejected = results.find((result) => {
        return result.status === 'rejected'
      })

      if (!fulfilled || fulfilled.status !== 'fulfilled') {
        throw new Error('Expected one shared root object write to succeed')
      }

      if (!rejected || rejected.status !== 'rejected') {
        throw new Error('Expected one shared root object write to fail')
      }

      expect(String(rejected.reason)).toContain(
        `Local object mediaType conflict: ${fulfilled.value.digest}`,
      )
      await expect(
        firstAdapters.objects.getDescriptor(fulfilled.value.digest),
      ).resolves.toEqual(fulfilled.value)
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })
})

describe('MemoryObjectStore', () => {
  it('does not expose mutable object byte or descriptor references', async () => {
    const store = new MemoryObjectStore()
    const objectBytes = bytes('object bytes')
    const descriptor = await store.put(objectBytes, 'application/octet-stream')

    objectBytes[0] = 0
    descriptor.size = 0

    const firstRead = await store.get(descriptor.digest)

    expect(text(firstRead?.bytes)).toBe('object bytes')
    expect(firstRead?.descriptor.size).toBe('object bytes'.length)

    if (!firstRead) {
      throw new Error('Expected stored object to exist')
    }

    firstRead.bytes[0] = 0
    firstRead.descriptor.size = 0

    const secondRead = await store.get(descriptor.digest)

    expect(text(secondRead?.bytes)).toBe('object bytes')
    expect(secondRead?.descriptor.size).toBe('object bytes'.length)

    const descriptorRead = await store.getDescriptor(descriptor.digest)
    expect(descriptorRead).toEqual({
      ...descriptor,
      size: 'object bytes'.length,
    })

    if (!descriptorRead) {
      throw new Error('Expected stored object descriptor to exist')
    }

    descriptorRead.size = 0

    await expect(store.getDescriptor(descriptor.digest)).resolves.toEqual({
      ...descriptor,
      size: 'object bytes'.length,
    })
  })

  it('rejects invalid object descriptors', async () => {
    const store = new MemoryObjectStore()

    expect(() => store.put(bytes('object bytes'), '')).toThrow(
      'Object mediaType must be a non-empty string',
    )
    expect(() =>
      store.put(bytes('object bytes'), 'text/plain\r\nx: y'),
    ).toThrow('Object mediaType must not include control characters')

    const descriptor = await store.put(
      bytes('object bytes'),
      'application/octet-stream',
    )
    const object = store.objects.get(descriptor.digest)

    if (!object) {
      throw new Error('Expected stored object to exist')
    }

    object.descriptor.mediaType = ''

    expect(() => store.get(descriptor.digest)).toThrow(
      'Object mediaType must be a non-empty string',
    )
  })

  it('rejects unknown memory object descriptor fields', async () => {
    const store = new MemoryObjectStore()
    const descriptor = await store.put(
      bytes('object bytes'),
      'application/octet-stream',
    )
    const object = store.objects.get(descriptor.digest)

    if (!object) {
      throw new Error('Expected stored object to exist')
    }

    Object.assign(object.descriptor, {
      location: 'memory',
    })

    expect(() => store.get(descriptor.digest)).toThrow(
      'Memory object descriptor must not include unknown field: location',
    )
  })

  it('keeps memory object descriptors immutable for duplicate bytes', async () => {
    const store = new MemoryObjectStore()
    const objectBytes = bytes('same object bytes')
    const first = await store.put(objectBytes, 'text/plain')
    const second = await store.put(objectBytes, 'text/plain')

    expect(second).toEqual(first)
    expect(() => store.put(objectBytes, 'application/octet-stream')).toThrow(
      `Memory object mediaType conflict: ${first.digest}`,
    )
  })

  it('lists memory object descriptors in digest order with cursor pagination', async () => {
    const store = new MemoryObjectStore()
    const descriptors = await Promise.all([
      store.put(bytes('object c'), 'text/plain'),
      store.put(bytes('object a'), 'application/octet-stream'),
      store.put(bytes('object b'), 'application/json'),
    ])
    const sorted = descriptors.toSorted((left, right) => {
      return left.digest.localeCompare(right.digest)
    })

    await expect(store.listDescriptors()).resolves.toEqual(sorted)
    await expect(store.listDescriptors({ limit: 2 })).resolves.toEqual(
      sorted.slice(0, 2),
    )
    await expect(
      store.listDescriptors({ after: sorted[1]!.digest, limit: 2 }),
    ).resolves.toEqual(sorted.slice(2))

    const read = await store.listDescriptors({ limit: 1 })
    read[0]!.size = 0

    await expect(store.getDescriptor(read[0]!.digest)).resolves.toEqual(
      sorted[0],
    )
    expect(() =>
      store.listDescriptors({ after: sha256(bytes('missing')) }),
    ).toThrow(ObjectCursorNotFoundError)
  })
})

describe('MemoryRegistryDatabase', () => {
  it('does not expose mutable event or release references', async () => {
    const database = new MemoryRegistryDatabase()
    const event = publishEventForPackage(
      'npm:example.com/mutable-events',
      '0.0.1',
      '2026-06-01T00:00:00.000Z',
    )
    await database.appendEvent(event)

    event.release.version = '9.9.9'

    const logEvent = publishEvent(await only(database.getEventLog()))
    logEvent.release.version = '9.9.9'

    const storedEvent = publishEvent(await database.getEvent(event.id))

    expect(storedEvent.release.version).toBe('0.0.1')

    const release = storedRelease('npm:example.com/mutable-release', '0.0.1')
    await database.putRelease(release)

    release.manifest.version = '9.9.9'
    const firstRead = await database.getRelease(
      'npm:example.com/mutable-release',
      '0.0.1',
    )

    if (!firstRead) {
      throw new Error('Expected release to exist')
    }

    firstRead.manifest.version = '9.9.9'
    publishEvent(firstRead.event).release.version = '9.9.9'

    const secondRead = await database.getRelease(
      'npm:example.com/mutable-release',
      '0.0.1',
    )

    expect(secondRead?.manifest.version).toBe('0.0.1')
    expect(publishEvent(secondRead?.event).release.version).toBe('0.0.1')
  })
})

describe('SQLiteRegistryDatabase', () => {
  it('backfills package count statistics for existing release tables', async () => {
    const root = await mkdtemp(join(tmpdir(), 'regesta-sqlite-stats-'))
    const databasePath = join(root, 'registry.sqlite')
    const firstDatabase = new SQLiteRegistryDatabase(databasePath)
    let firstDatabaseClosed = false

    try {
      await firstDatabase.putRelease(
        storedRelease('npm:example.com/stats-migration', '0.0.1'),
      )
      await firstDatabase.putRelease(
        storedRelease('npm:example.com/other-stats-migration', '0.0.1'),
      )
      firstDatabase.close()
      firstDatabaseClosed = true

      const rawDatabase = new DatabaseSync(databasePath)
      rawDatabase.exec('DROP TABLE registry_stats')
      rawDatabase.close()

      const migratedDatabase = new SQLiteRegistryDatabase(databasePath)
      try {
        await expect(migratedDatabase.countPackages()).resolves.toBe(2)
      } finally {
        migratedDatabase.close()
      }
    } finally {
      if (!firstDatabaseClosed) {
        firstDatabase.close()
      }
      await rm(root, { force: true, recursive: true })
    }
  })

  it('keeps existing package count statistics across startup', async () => {
    const root = await mkdtemp(join(tmpdir(), 'regesta-sqlite-stats-'))
    const databasePath = join(root, 'registry.sqlite')
    const firstDatabase = new SQLiteRegistryDatabase(databasePath)
    let firstDatabaseClosed = false

    try {
      await firstDatabase.putRelease(
        storedRelease('npm:example.com/stats-startup', '0.0.1'),
      )
      firstDatabase.close()
      firstDatabaseClosed = true

      const rawDatabase = new DatabaseSync(databasePath)
      rawDatabase
        .prepare(
          `UPDATE registry_stats
            SET value = 7
            WHERE key = 'package_count'`,
        )
        .run()
      rawDatabase.close()

      const reopenedDatabase = new SQLiteRegistryDatabase(databasePath)
      try {
        await expect(reopenedDatabase.countPackages()).resolves.toBe(7)
      } finally {
        reopenedDatabase.close()
      }
    } finally {
      if (!firstDatabaseClosed) {
        firstDatabase.close()
      }
      await rm(root, { force: true, recursive: true })
    }
  })

  it('reads package counts from registry_stats without scanning releases on normal reads', async () => {
    const root = await mkdtemp(join(tmpdir(), 'regesta-sqlite-stats-'))
    const databasePath = join(root, 'registry.sqlite')
    const database = new SQLiteRegistryDatabase(databasePath)

    try {
      await database.putRelease(
        storedRelease('npm:example.com/stats-hot-path', '0.0.1'),
      )

      const rawDatabase = new DatabaseSync(databasePath)
      try {
        rawDatabase
          .prepare(
            `UPDATE registry_stats
              SET value = 7
              WHERE key = 'package_count'`,
          )
          .run()
        rawDatabase.exec('DROP TABLE releases')
      } finally {
        rawDatabase.close()
      }

      await expect(database.countPackages()).resolves.toBe(7)
    } finally {
      database.close()
      await rm(root, { force: true, recursive: true })
    }
  })

  it('rejects invalid package count statistics', async () => {
    const root = await mkdtemp(join(tmpdir(), 'regesta-sqlite-stats-'))
    const databasePath = join(root, 'registry.sqlite')
    const firstDatabase = new SQLiteRegistryDatabase(databasePath)
    let firstDatabaseClosed = false

    try {
      firstDatabase.close()
      firstDatabaseClosed = true

      const rawDatabase = new DatabaseSync(databasePath)
      rawDatabase.exec('DROP TABLE registry_stats')
      rawDatabase.exec(`
        CREATE TABLE registry_stats (
          key TEXT PRIMARY KEY,
          value INTEGER NOT NULL
        );
      `)
      rawDatabase
        .prepare(
          `INSERT INTO registry_stats (key, value)
            VALUES ('package_count', -1)`,
        )
        .run()
      rawDatabase.close()

      const reopenedDatabase = new SQLiteRegistryDatabase(databasePath)
      try {
        await expect(reopenedDatabase.countPackages()).rejects.toThrow(
          'SQLite column value must be a non-negative integer',
        )
      } finally {
        reopenedDatabase.close()
      }
    } finally {
      if (!firstDatabaseClosed) {
        firstDatabase.close()
      }
      await rm(root, { force: true, recursive: true })
    }
  })

  it('rejects release writes when package count statistics are missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'regesta-sqlite-stats-'))
    const databasePath = join(root, 'registry.sqlite')
    const database = new SQLiteRegistryDatabase(databasePath)

    try {
      const rawDatabase = new DatabaseSync(databasePath)
      rawDatabase
        .prepare(`DELETE FROM registry_stats WHERE key = 'package_count'`)
        .run()
      rawDatabase.close()

      const release = storedRelease(
        'npm:example.com/missing-stats-row',
        '0.0.1',
      )

      await expect(database.putRelease(release)).rejects.toThrow(
        'SQLite registry statistic is missing: package_count',
      )
      await expect(
        database.getRelease(release.manifest.id, release.manifest.version),
      ).resolves.toBeUndefined()
    } finally {
      database.close()
      await rm(root, { force: true, recursive: true })
    }
  })

  it('backfills event-derived registry state for existing event logs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'regesta-sqlite-events-'))
    const databasePath = join(root, 'registry.sqlite')
    const firstDatabase = new SQLiteRegistryDatabase(databasePath)
    let firstDatabaseClosed = false

    try {
      const release = storedRelease(
        'npm:example.com/event-state-migration',
        '0.0.1',
      )
      await firstDatabase.putRelease(release)
      await firstDatabase.setPackageChannel(
        release.manifest.id,
        'latest',
        release.manifest.version,
      )
      await firstDatabase.appendEvent(release.event)
      firstDatabase.close()
      firstDatabaseClosed = true

      const rawDatabase = new DatabaseSync(databasePath)
      rawDatabase.prepare(`DELETE FROM registry_event_state_meta`).run()
      rawDatabase.exec(`
        DROP TABLE registry_event_releases;

        CREATE TABLE registry_event_releases (
          package_id TEXT NOT NULL,
          version TEXT NOT NULL,
          PRIMARY KEY (package_id, version)
        );
      `)
      rawDatabase.prepare(`DELETE FROM registry_event_channels`).run()
      rawDatabase.close()

      const migratedDatabase = new SQLiteRegistryDatabase(databasePath)
      try {
        const update = channelUpdatedEvent(release.manifest.id, {
          previousVersion: release.manifest.version,
          version: release.manifest.version,
        })

        await expect(
          migratedDatabase.commitPackageChannelUpdate(update),
        ).resolves.toBeUndefined()
        await expect(migratedDatabase.getEvent(update.id)).resolves.toEqual(
          update,
        )
      } finally {
        migratedDatabase.close()
      }
    } finally {
      if (!firstDatabaseClosed) {
        firstDatabase.close()
      }
      await rm(root, { force: true, recursive: true })
    }
  })

  it('maintains package counts for direct release projection writes', async () => {
    const database = new SQLiteRegistryDatabase(':memory:')

    try {
      await expect(database.countPackages()).resolves.toBe(0)
      await database.putRelease(
        storedRelease('npm:example.com/direct-package-count', '0.0.1'),
      )
      await expect(database.countPackages()).resolves.toBe(1)
      await database.putRelease(
        storedRelease('npm:example.com/direct-package-count', '0.0.2'),
      )
      await expect(database.countPackages()).resolves.toBe(1)
      await database.putRelease(
        storedRelease('npm:example.com/other-direct-package-count', '0.0.1'),
      )
      await expect(database.countPackages()).resolves.toBe(2)
    } finally {
      database.close()
    }
  })

  it('rejects duplicate authorization payload digests at the storage layer', async () => {
    const firstEvent = authorizedPublishEvent('duplicate payload', 'first')
    const secondEvent = authorizedPublishEvent('duplicate payload', 'second')
    const memory = new MemoryRegistryDatabase()
    const sqlite = new SQLiteRegistryDatabase(':memory:')

    try {
      await memory.appendEvent(firstEvent)
      expect(() => memory.appendEvent(secondEvent)).toThrow(
        WriteAuthorizationReplayError,
      )

      await sqlite.appendEvent(firstEvent)
      expect(() => sqlite.appendEvent(secondEvent)).toThrow(
        WriteAuthorizationReplayError,
      )
    } finally {
      sqlite.close()
    }
  })

  it('rejects replay-inconsistent package histories on raw event append', async () => {
    const packageId: PackageId = 'npm:example.com/replay-invalid'
    const firstEvent = publishEventForPackage(
      packageId,
      '0.0.1',
      '2026-06-01T00:00:00.000Z',
    )
    const duplicateVersion = publishEventForPackage(
      packageId,
      '0.0.1',
      '2026-06-01T00:01:00.000Z',
    )
    const missingTarget = channelUpdatedEvent(
      'npm:example.com/replay-missing-target',
    )
    const stalePreviousVersion = channelUpdatedEvent(packageId, {
      previousVersion: '0.0.2',
      version: '0.0.1',
    })
    const memory = new MemoryRegistryDatabase()
    const sqlite = new SQLiteRegistryDatabase(':memory:')

    try {
      await memory.appendEvent(firstEvent)
      expect(() => memory.appendEvent(duplicateVersion)).toThrow(
        RegistryEventIntegrityError,
      )
      expect(() => memory.appendEvent(missingTarget)).toThrow(
        RegistryEventIntegrityError,
      )
      expect(() => memory.appendEvent(stalePreviousVersion)).toThrow(
        RegistryEventIntegrityError,
      )

      await sqlite.appendEvent(firstEvent)
      expect(() => sqlite.appendEvent(duplicateVersion)).toThrow(
        RegistryEventIntegrityError,
      )
      expect(() => sqlite.appendEvent(missingTarget)).toThrow(
        RegistryEventIntegrityError,
      )
      expect(() => sqlite.appendEvent(stalePreviousVersion)).toThrow(
        RegistryEventIntegrityError,
      )
    } finally {
      sqlite.close()
    }
  })

  it('rejects replay-inconsistent release commits before writing projections', async () => {
    const release = storedRelease(
      'npm:example.com/replay-invalid-release-commit',
      '0.0.1',
    )
    const conflictingEvent = publishEventForPackage(
      release.manifest.id,
      release.manifest.version,
      '2026-06-01T00:01:00.000Z',
    )
    const memory = new MemoryRegistryDatabase()
    const sqlite = new SQLiteRegistryDatabase(':memory:')

    try {
      await memory.appendEvent(conflictingEvent)
      expect(() => memory.commitPublishedRelease(release, 'latest')).toThrow(
        RegistryEventIntegrityError,
      )
      await expect(
        memory.getRelease(release.manifest.id, release.manifest.version),
      ).resolves.toBeUndefined()
      await expect(
        memory.getPackageChannels(release.manifest.id),
      ).resolves.toEqual({})

      await sqlite.appendEvent(conflictingEvent)
      expect(() => sqlite.commitPublishedRelease(release, 'latest')).toThrow(
        RegistryEventIntegrityError,
      )
      await expect(
        sqlite.getRelease(release.manifest.id, release.manifest.version),
      ).resolves.toBeUndefined()
      await expect(
        sqlite.getPackageChannels(release.manifest.id),
      ).resolves.toEqual({})
    } finally {
      sqlite.close()
    }
  })

  it('rejects replay-inconsistent channel update commits before writing projections', async () => {
    const packageId: PackageId = 'npm:example.com/replay-invalid-update-commit'
    const firstRelease = storedRelease(packageId, '0.0.1')
    const secondRelease = storedRelease(packageId, '0.0.2')
    const event = channelUpdatedEvent(packageId, {
      previousVersion: '0.0.1',
      version: '0.0.2',
    })
    const memory = new MemoryRegistryDatabase()
    const sqlite = new SQLiteRegistryDatabase(':memory:')

    try {
      await memory.putRelease(firstRelease)
      await memory.putRelease(secondRelease)
      await memory.setPackageChannel(packageId, 'latest', '0.0.1')
      expect(() => memory.commitPackageChannelUpdate(event)).toThrow(
        RegistryEventIntegrityError,
      )
      await expect(memory.getEvent(event.id)).resolves.toBeUndefined()
      await expect(memory.getPackageChannels(packageId)).resolves.toEqual({
        latest: '0.0.1',
      })

      await sqlite.putRelease(firstRelease)
      await sqlite.putRelease(secondRelease)
      await sqlite.setPackageChannel(packageId, 'latest', '0.0.1')
      expect(() => sqlite.commitPackageChannelUpdate(event)).toThrow(
        RegistryEventIntegrityError,
      )
      await expect(sqlite.getEvent(event.id)).resolves.toBeUndefined()
      await expect(sqlite.getPackageChannels(packageId)).resolves.toEqual({
        latest: '0.0.1',
      })
    } finally {
      sqlite.close()
    }
  })

  it('rejects replay-inconsistent channel delete commits before writing projections', async () => {
    const packageId: PackageId = 'npm:example.com/replay-invalid-delete-commit'
    const event = channelDeletedEvent(packageId)
    const memory = new MemoryRegistryDatabase()
    const sqlite = new SQLiteRegistryDatabase(':memory:')

    try {
      await memory.setPackageChannel(packageId, 'latest', '0.0.1')
      expect(() => memory.commitPackageChannelDelete(event)).toThrow(
        RegistryEventIntegrityError,
      )
      await expect(memory.getEvent(event.id)).resolves.toBeUndefined()
      await expect(memory.getPackageChannels(packageId)).resolves.toEqual({
        latest: '0.0.1',
      })

      await sqlite.setPackageChannel(packageId, 'latest', '0.0.1')
      expect(() => sqlite.commitPackageChannelDelete(event)).toThrow(
        RegistryEventIntegrityError,
      )
      await expect(sqlite.getEvent(event.id)).resolves.toBeUndefined()
      await expect(sqlite.getPackageChannels(packageId)).resolves.toEqual({
        latest: '0.0.1',
      })
    } finally {
      sqlite.close()
    }
  })

  it('does not expose direct projection writes as event-derived package state', async () => {
    const release = storedRelease(
      'npm:example.com/direct-projection-state',
      '0.0.1',
    )
    const memory = new MemoryRegistryDatabase()
    const sqlite = new SQLiteRegistryDatabase(':memory:')

    try {
      await memory.putRelease(release)
      await memory.setPackageChannel(
        release.manifest.id,
        'latest',
        release.manifest.version,
      )
      await expect(
        memory.getPackageEventState(release.manifest.id),
      ).resolves.toEqual({
        state: {
          ecosystem: 'npm',
          id: release.manifest.id,
          name: 'example.com/direct-projection-state',
          object: 'regesta.package-state',
          releases: [],
        },
      })

      await sqlite.putRelease(release)
      await sqlite.setPackageChannel(
        release.manifest.id,
        'latest',
        release.manifest.version,
      )
      await expect(
        sqlite.getPackageEventState(release.manifest.id),
      ).resolves.toEqual({
        state: {
          ecosystem: 'npm',
          id: release.manifest.id,
          name: 'example.com/direct-projection-state',
          object: 'regesta.package-state',
          releases: [],
        },
      })
    } finally {
      sqlite.close()
    }
  })

  it('does not commit publish events when release projection write fails', async () => {
    const release = storedRelease('npm:example.com/atomic-release', '0.0.1')
    const memory = new MemoryRegistryDatabase()
    const sqlite = new SQLiteRegistryDatabase(':memory:')

    try {
      await memory.putRelease(release)
      expect(() => memory.commitPublishedRelease(release, 'latest')).toThrow(
        ReleaseAlreadyExistsError,
      )
      await expect(memory.getEvent(release.event.id)).resolves.toBeUndefined()
      await expect(
        memory.getPackageChannels(release.manifest.id),
      ).resolves.toEqual({})

      await sqlite.putRelease(release)
      expect(() => sqlite.commitPublishedRelease(release, 'latest')).toThrow(
        ReleaseAlreadyExistsError,
      )
      await expect(sqlite.getEvent(release.event.id)).resolves.toBeUndefined()
      await expect(
        sqlite.getPackageChannels(release.manifest.id),
      ).resolves.toEqual({})
    } finally {
      sqlite.close()
    }
  })

  it('rejects stored releases whose publish event does not match the manifest', async () => {
    const release = storedRelease(
      'npm:example.com/inconsistent-release',
      '0.0.1',
    )
    const inconsistentEvent = publishReleaseEvent({
      artifactDigests: release.manifest.artifacts.map((artifact) => {
        return artifact.digest
      }),
      channel: 'latest',
      eventType: 'release.published',
      object: 'regesta.event',
      release: {
        id: 'npm:example.com/other-release',
        manifestDigest: release.manifestDescriptor.digest,
        version: release.manifest.version,
      },
      sourceDigest: release.manifest.source.digest,
      timestamp: release.manifest.createdAt,
    })
    const inconsistentRelease = {
      ...release,
      event: inconsistentEvent,
    } satisfies StoredRelease
    const memory = new MemoryRegistryDatabase()
    const sqlite = new SQLiteRegistryDatabase(':memory:')

    try {
      expect(() =>
        memory.commitPublishedRelease(inconsistentRelease, 'latest'),
      ).toThrow(RegistryEventIntegrityError)
      await expect(
        memory.getEvent(inconsistentEvent.id),
      ).resolves.toBeUndefined()
      await expect(
        memory.getRelease(release.manifest.id, release.manifest.version),
      ).resolves.toBeUndefined()
      await expect(
        memory.getPackageChannels(release.manifest.id),
      ).resolves.toEqual({})

      expect(() =>
        sqlite.commitPublishedRelease(inconsistentRelease, 'latest'),
      ).toThrow(RegistryEventIntegrityError)
      await expect(
        sqlite.getEvent(inconsistentEvent.id),
      ).resolves.toBeUndefined()
      await expect(
        sqlite.getRelease(release.manifest.id, release.manifest.version),
      ).resolves.toBeUndefined()
      await expect(
        sqlite.getPackageChannels(release.manifest.id),
      ).resolves.toEqual({})
    } finally {
      sqlite.close()
    }
  })

  it('rejects stored releases with invalid manifest semantics', async () => {
    const cases: Array<{
      mutate: (release: StoredRelease) => void
      name: string
    }> = [
      {
        mutate: (release) => {
          release.manifest.name = 'example.com/other-release'
        },
        name: 'wrong package name',
      },
      {
        mutate: (release) => {
          Object.assign(release.manifest, {
            extra: true,
          })
        },
        name: 'unknown manifest field',
      },
      {
        mutate: (release) => {
          release.manifest.configDigest = 'sha256:not-a-digest'
        },
        name: 'invalid config digest',
      },
      {
        mutate: (release) => {
          release.manifest.artifacts = []
          release.event = publishReleaseEvent({
            artifactDigests: [],
            channel: release.event.channel,
            eventType: 'release.published',
            object: 'regesta.event',
            release: release.event.release,
            sourceDigest: release.event.sourceDigest,
            timestamp: release.event.timestamp,
          })
        },
        name: 'missing install artifact',
      },
      {
        mutate: (release) => {
          release.manifest.createdAt = '2026-06-01T00:00:00Z'
          release.event = publishReleaseEvent({
            artifactDigests: release.event.artifactDigests,
            channel: release.event.channel,
            eventType: 'release.published',
            object: 'regesta.event',
            release: release.event.release,
            sourceDigest: release.event.sourceDigest,
            timestamp: release.manifest.createdAt,
          })
        },
        name: 'non-canonical createdAt',
      },
      {
        mutate: (release) => {
          Object.assign(release.manifest.provenance, {
            level: 'declared-build',
          })
        },
        name: 'invalid provenance level',
      },
      {
        mutate: (release) => {
          Object.assign(release.manifest.provenance, {
            verified: true,
          })
        },
        name: 'invalid provenance verified',
      },
      {
        mutate: (release) => {
          Object.assign(release.manifest.provenance, {
            builder: 'test-builder',
          })
        },
        name: 'unknown provenance field',
      },
      {
        mutate: (release) => {
          release.manifest.metadata = {
            description: 'test package',
          }
          Object.assign(release.manifest.metadata, {
            deprecated: false,
          })
        },
        name: 'unknown release metadata field',
      },
      {
        mutate: (release) => {
          Object.assign(release.manifest, {
            metadata: [],
          })
        },
        name: 'invalid release metadata object',
      },
      {
        mutate: (release) => {
          Object.assign(release.manifest, {
            metadata: {
              description: 1,
              exports: false,
              repository: 1,
            },
          })
        },
        name: 'invalid release metadata values',
      },
      {
        mutate: (release) => {
          Object.assign(release.manifest, {
            provenance: [],
          })
        },
        name: 'invalid provenance object',
      },
      {
        mutate: (release) => {
          Object.assign(release.manifest, {
            family: 1,
            languages: 'typescript',
          })
        },
        name: 'invalid release navigation metadata',
      },
      {
        mutate: (release) => {
          Object.assign(release.manifest.artifacts[0]!, {
            ecosystemMetadata: 'npm',
          })
        },
        name: 'invalid artifact ecosystem metadata',
      },
      {
        mutate: (release) => {
          Object.assign(release.manifestDescriptor, {
            digest: 'sha256:not-a-digest',
          })
        },
        name: 'invalid manifest descriptor digest',
      },
      {
        mutate: (release) => {
          Object.assign(release.manifestDescriptor, {
            extra: true,
          })
        },
        name: 'unknown manifest descriptor field',
      },
      {
        mutate: (release) => {
          const digest = sha256(bytes('other manifest'))
          release.manifestDescriptor.digest = digest
          release.event = publishReleaseEvent({
            artifactDigests: release.event.artifactDigests,
            channel: release.event.channel,
            eventType: 'release.published',
            object: 'regesta.event',
            release: {
              ...release.event.release,
              manifestDigest: digest,
            },
            sourceDigest: release.event.sourceDigest,
            timestamp: release.event.timestamp,
          })
        },
        name: 'mismatched manifest descriptor digest',
      },
      {
        mutate: (release) => {
          release.manifest.source.size = -1
        },
        name: 'invalid source descriptor size',
      },
      {
        mutate: (release) => {
          Object.assign(release.manifest.source, {
            extra: true,
          })
        },
        name: 'unknown source descriptor field',
      },
      {
        mutate: (release) => {
          const artifact = release.manifest.artifacts.at(0)
          if (!artifact) {
            throw new Error('Expected stored release artifact')
          }

          artifact.mediaType = ''
        },
        name: 'invalid artifact descriptor mediaType',
      },
      {
        mutate: (release) => {
          const artifact = release.manifest.artifacts.at(0)
          if (!artifact) {
            throw new Error('Expected stored release artifact')
          }

          artifact.filename = ''
        },
        name: 'empty artifact descriptor filename',
      },
      {
        mutate: (release) => {
          const artifact = release.manifest.artifacts.at(0)
          if (!artifact) {
            throw new Error('Expected stored release artifact')
          }

          artifact.format = ''
        },
        name: 'empty artifact descriptor format',
      },
      {
        mutate: (release) => {
          const artifact = release.manifest.artifacts.at(0)
          if (!artifact) {
            throw new Error('Expected stored release artifact')
          }

          Object.assign(artifact, {
            extra: true,
          })
        },
        name: 'unknown artifact descriptor field',
      },
      {
        mutate: (release) => {
          const artifact = release.manifest.artifacts.at(0)
          if (!artifact) {
            throw new Error('Expected stored release artifact')
          }

          Object.assign(artifact, {
            compatibility: {
              extra: true,
              runtimes: ['node'],
            },
          })
        },
        name: 'unknown artifact compatibility field',
      },
      {
        mutate: (release) => {
          const artifact = release.manifest.artifacts.at(0)
          if (!artifact) {
            throw new Error('Expected stored release artifact')
          }

          Object.assign(artifact, {
            compatibility: null,
          })
        },
        name: 'null artifact compatibility',
      },
      {
        mutate: (release) => {
          const artifact = release.manifest.artifacts.at(0)
          if (!artifact) {
            throw new Error('Expected stored release artifact')
          }

          Object.assign(artifact, {
            compatibility: {
              modules: 'esm',
            },
          })
        },
        name: 'invalid artifact compatibility modules',
      },
      {
        mutate: (release) => {
          const artifact = release.manifest.artifacts.at(0)
          if (!artifact) {
            throw new Error('Expected stored release artifact')
          }

          Object.assign(artifact, {
            compatibility: {
              modules: ['esm\r\nx'],
            },
          })
        },
        name: 'unsafe artifact compatibility module',
      },
      {
        mutate: (release) => {
          const artifact = release.manifest.artifacts.at(0)
          if (!artifact) {
            throw new Error('Expected stored release artifact')
          }

          Object.assign(artifact, {
            compatibility: {
              runtimes: {
                name: 'node',
              },
            },
          })
        },
        name: 'invalid artifact compatibility runtimes',
      },
      {
        mutate: (release) => {
          const artifact = release.manifest.artifacts.at(0)
          if (!artifact) {
            throw new Error('Expected stored release artifact')
          }

          Object.assign(artifact, {
            compatibility: {
              runtimes: [
                {
                  conditions: 'import',
                  name: 'node',
                },
              ],
            },
          })
        },
        name: 'invalid artifact runtime compatibility conditions',
      },
    ]

    for (const item of cases) {
      const release = storedRelease(
        `npm:example.com/invalid-${item.name.replaceAll(' ', '-')}`,
        '0.0.1',
      )
      item.mutate(release)
      const memory = new MemoryRegistryDatabase()
      const sqlite = new SQLiteRegistryDatabase(':memory:')

      try {
        expect(() => memory.putRelease(release)).toThrow(
          RegistryEventIntegrityError,
        )
        expect(() => memory.commitPublishedRelease(release, 'latest')).toThrow(
          RegistryEventIntegrityError,
        )
        await expect(memory.getEvent(release.event.id)).resolves.toBeUndefined()
        await expect(
          memory.getRelease(release.manifest.id, release.manifest.version),
        ).resolves.toBeUndefined()

        await expect(sqlite.putRelease(release)).rejects.toThrow(
          RegistryEventIntegrityError,
        )
        expect(() => sqlite.commitPublishedRelease(release, 'latest')).toThrow(
          RegistryEventIntegrityError,
        )
        await expect(sqlite.getEvent(release.event.id)).resolves.toBeUndefined()
        await expect(
          sqlite.getRelease(release.manifest.id, release.manifest.version),
        ).resolves.toBeUndefined()
      } finally {
        sqlite.close()
      }
    }
  })

  it('does not update channel projections when channel event persistence fails', async () => {
    const release = storedRelease('npm:example.com/atomic-channel', '0.0.1')
    const event = channelUpdatedEvent(release.manifest.id, {
      previousVersion: '0.0.1',
    })
    const memory = new MemoryRegistryDatabase()
    const sqlite = new SQLiteRegistryDatabase(':memory:')

    try {
      await memory.putRelease(release)
      await memory.appendEvent(release.event)
      await memory.setPackageChannel(event.package, event.channel, '0.0.1')
      await memory.appendEvent(event)
      expect(() => memory.commitPackageChannelUpdate(event)).toThrow(
        RegistryEventAlreadyExistsError,
      )
      await expect(memory.getPackageChannels(event.package)).resolves.toEqual({
        latest: '0.0.1',
      })

      await sqlite.putRelease(release)
      await sqlite.appendEvent(release.event)
      await sqlite.setPackageChannel(event.package, event.channel, '0.0.1')
      await sqlite.appendEvent(event)
      expect(() => sqlite.commitPackageChannelUpdate(event)).toThrow(
        RegistryEventAlreadyExistsError,
      )
      await expect(sqlite.getPackageChannels(event.package)).resolves.toEqual({
        latest: '0.0.1',
      })
    } finally {
      sqlite.close()
    }
  })

  it('rejects channel update events that point at missing releases', async () => {
    const event = channelUpdatedEvent('npm:example.com/missing-release')
    const memory = new MemoryRegistryDatabase()
    const sqlite = new SQLiteRegistryDatabase(':memory:')

    try {
      expect(() => memory.commitPackageChannelUpdate(event)).toThrow(
        ReleaseNotFoundError,
      )
      await expect(memory.getEvent(event.id)).resolves.toBeUndefined()
      await expect(memory.getPackageChannels(event.package)).resolves.toEqual(
        {},
      )

      expect(() => sqlite.commitPackageChannelUpdate(event)).toThrow(
        ReleaseNotFoundError,
      )
      await expect(sqlite.getEvent(event.id)).resolves.toBeUndefined()
      await expect(sqlite.getPackageChannels(event.package)).resolves.toEqual(
        {},
      )
    } finally {
      sqlite.close()
    }
  })

  it('does not delete channel projections when channel event persistence fails', async () => {
    const release = storedRelease(
      'npm:example.com/atomic-channel-delete',
      '0.0.1',
    )
    const event = channelDeletedEvent(release.manifest.id)
    const memory = new MemoryRegistryDatabase()
    const sqlite = new SQLiteRegistryDatabase(':memory:')

    try {
      await memory.appendEvent(release.event)
      await memory.setPackageChannel(event.package, event.channel, '0.0.1')
      await memory.appendEvent(event)
      expect(() => memory.commitPackageChannelDelete(event)).toThrow(
        RegistryEventAlreadyExistsError,
      )
      await expect(memory.getPackageChannels(event.package)).resolves.toEqual({
        latest: '0.0.1',
      })

      await sqlite.appendEvent(release.event)
      await sqlite.setPackageChannel(event.package, event.channel, '0.0.1')
      await sqlite.appendEvent(event)
      expect(() => sqlite.commitPackageChannelDelete(event)).toThrow(
        RegistryEventAlreadyExistsError,
      )
      await expect(sqlite.getPackageChannels(event.package)).resolves.toEqual({
        latest: '0.0.1',
      })
    } finally {
      sqlite.close()
    }
  })

  it('rejects stale channel update events without persisting them', async () => {
    const event = channelUpdatedEvent('npm:example.com/stale-channel', {
      previousVersion: '0.0.1',
      version: '0.0.3',
    })
    const memory = new MemoryRegistryDatabase()
    const sqlite = new SQLiteRegistryDatabase(':memory:')

    try {
      await memory.setPackageChannel(event.package, event.channel, '0.0.2')
      expect(() => memory.commitPackageChannelUpdate(event)).toThrow(
        PackageChannelConflictError,
      )
      await expect(memory.getEvent(event.id)).resolves.toBeUndefined()
      await expect(memory.getPackageChannels(event.package)).resolves.toEqual({
        latest: '0.0.2',
      })

      await sqlite.setPackageChannel(event.package, event.channel, '0.0.2')
      expect(() => sqlite.commitPackageChannelUpdate(event)).toThrow(
        PackageChannelConflictError,
      )
      await expect(sqlite.getEvent(event.id)).resolves.toBeUndefined()
      await expect(sqlite.getPackageChannels(event.package)).resolves.toEqual({
        latest: '0.0.2',
      })
    } finally {
      sqlite.close()
    }
  })

  it('rejects stale channel delete events without persisting them', async () => {
    const event = channelDeletedEvent('npm:example.com/stale-channel-delete')
    const memory = new MemoryRegistryDatabase()
    const sqlite = new SQLiteRegistryDatabase(':memory:')

    try {
      await memory.setPackageChannel(event.package, event.channel, '0.0.2')
      expect(() => memory.commitPackageChannelDelete(event)).toThrow(
        PackageChannelConflictError,
      )
      await expect(memory.getEvent(event.id)).resolves.toBeUndefined()
      await expect(memory.getPackageChannels(event.package)).resolves.toEqual({
        latest: '0.0.2',
      })

      await sqlite.setPackageChannel(event.package, event.channel, '0.0.2')
      expect(() => sqlite.commitPackageChannelDelete(event)).toThrow(
        PackageChannelConflictError,
      )
      await expect(sqlite.getEvent(event.id)).resolves.toBeUndefined()
      await expect(sqlite.getPackageChannels(event.package)).resolves.toEqual({
        latest: '0.0.2',
      })
    } finally {
      sqlite.close()
    }
  })

  it('migrates authorization payload digest indexes for existing event tables', async () => {
    const root = await mkdtemp(join(tmpdir(), 'regesta-sqlite-migration-'))
    const path = join(root, 'registry.sqlite')
    const event = publishReleaseEvent({
      authorization: {
        alg: 'EdDSA',
        domain: 'example.com',
        kid: 'test-key',
        object: 'regesta.authorization-proof',
        payloadDigest: sha256(bytes('legacy authorization payload')),
        publicKeyJwk: {
          crv: 'Ed25519',
          kty: 'OKP',
          x: TEST_ED25519_PUBLIC_KEY,
        },
        signature: TEST_ED25519_SIGNATURE,
        signedAt: '2026-06-01T00:00:00.000Z',
        wellKnownDigest: sha256(bytes('well-known')),
      },
      artifactDigests: [sha256(bytes('artifact'))],
      channel: 'latest',
      eventType: 'release.published',
      object: 'regesta.event',
      release: {
        id: 'npm:example.com/legacy',
        manifestDigest: sha256(bytes('manifest')),
        version: '0.0.1',
      },
      sourceDigest: sha256(bytes('source')),
      timestamp: '2026-06-01T00:00:00.000Z',
    })

    try {
      const legacy = new DatabaseSync(path)
      legacy.exec(`
        CREATE TABLE registry_events (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          id TEXT NOT NULL UNIQUE,
          event_type TEXT NOT NULL,
          package_id TEXT NOT NULL,
          timestamp TEXT NOT NULL,
          event_json TEXT NOT NULL
        );
      `)
      legacy
        .prepare(
          `INSERT INTO registry_events (
            id,
            event_type,
            package_id,
            timestamp,
            event_json
          ) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          event.id,
          event.eventType,
          event.release.id,
          event.timestamp,
          JSON.stringify(event),
        )
      legacy.close()

      const database = new SQLiteRegistryDatabase(path)
      try {
        await expect(
          database.hasAuthorizationPayloadDigest(
            event.authorization.payloadDigest,
          ),
        ).resolves.toBe(true)
      } finally {
        database.close()
      }
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it('validates SQLite event and release JSON when reading persisted data', async () => {
    const root = await mkdtemp(join(tmpdir(), 'regesta-sqlite-read-'))
    const path = join(root, 'registry.sqlite')
    const release = storedRelease('npm:example.com/read-validation', '0.0.1')

    try {
      const database = new SQLiteRegistryDatabase(path)
      try {
        await database.commitPublishedRelease(release, 'latest')
      } finally {
        database.close()
      }

      const eventCorruption = new DatabaseSync(path)
      try {
        eventCorruption
          .prepare(
            `UPDATE registry_events
              SET event_json = ?
              WHERE id = ?`,
          )
          .run(
            canonicalJson({
              ...release.event,
              timestamp: '2026-06-01T00:00:00Z',
            }),
            release.event.id,
          )
      } finally {
        eventCorruption.close()
      }

      const corruptedEventDatabase = new SQLiteRegistryDatabase(path)
      try {
        expect(() => corruptedEventDatabase.getEvent(release.event.id)).toThrow(
          RegistryEventIntegrityError,
        )
      } finally {
        corruptedEventDatabase.close()
      }

      const releaseCorruption = new DatabaseSync(path)
      try {
        releaseCorruption
          .prepare(
            `UPDATE registry_events
              SET event_json = ?
              WHERE id = ?`,
          )
          .run(canonicalJson(release.event), release.event.id)
        releaseCorruption
          .prepare(
            `UPDATE releases
              SET manifest_json = ?
              WHERE package_id = ? AND version = ?`,
          )
          .run(
            canonicalJson({
              ...release.manifest,
              createdAt: '2026-06-01T00:00:00Z',
            }),
            release.manifest.id,
            release.manifest.version,
          )
      } finally {
        releaseCorruption.close()
      }

      const corruptedReleaseDatabase = new SQLiteRegistryDatabase(path)
      try {
        expect(() =>
          corruptedReleaseDatabase.getRelease(
            release.manifest.id,
            release.manifest.version,
          ),
        ).toThrow(RegistryEventIntegrityError)
      } finally {
        corruptedReleaseDatabase.close()
      }
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it('rejects non-canonical event values before persistence', () => {
    const database = new SQLiteRegistryDatabase(':memory:')
    const event = publishReleaseEvent({
      artifactDigests: [sha256(bytes('artifact'))],
      channel: 'latest',
      eventType: 'release.published',
      object: 'regesta.event',
      release: {
        id: 'npm:example.com/non-canonical',
        manifestDigest: sha256(bytes('manifest')),
        version: '0.0.1',
      },
      sourceDigest: sha256(bytes('source')),
      timestamp: '2026-06-01T00:00:00.000Z',
    })
    Object.assign(event, {
      timestamp: new Date('2026-06-01T00:00:00.000Z'),
    })

    try {
      expect(() => database.appendEvent(event)).toThrow(
        RegistryEventIntegrityError,
      )
    } finally {
      database.close()
    }
  })

  it('rejects events with invalid package ids before persistence', () => {
    const memory = new MemoryRegistryDatabase()
    const sqlite = new SQLiteRegistryDatabase(':memory:')
    const event = unsignedPublishEvent('invalid package id')
    Object.assign(event.release, {
      id: 'npm:@example.com/invalid',
    })
    Object.assign(event, {
      id: registryEventDigest(event),
    })

    try {
      expect(() => memory.appendEvent(event)).toThrow(
        RegistryEventIntegrityError,
      )
      expect(() => sqlite.appendEvent(event)).toThrow(
        RegistryEventIntegrityError,
      )
    } finally {
      sqlite.close()
    }
  })

  it('rejects events with empty semantic fields before persistence', () => {
    const cases: Array<{
      event: RegistryEvent
      mutate: (event: RegistryEvent) => void
      name: string
    }> = [
      {
        event: unsignedPublishEvent('empty publish channel'),
        mutate: (event) => {
          Object.assign(event, { channel: '' })
        },
        name: 'empty publish channel',
      },
      {
        event: unsignedPublishEvent('empty publish version'),
        mutate: (event) => {
          if (event.eventType !== 'release.published') {
            throw new Error('Expected release.published event')
          }

          Object.assign(event.release, { version: '' })
        },
        name: 'empty publish version',
      },
      {
        event: unsignedPublishEvent('empty publish artifact digests'),
        mutate: (event) => {
          if (event.eventType !== 'release.published') {
            throw new Error('Expected release.published event')
          }

          Object.assign(event, { artifactDigests: [] })
        },
        name: 'empty publish artifact digests',
      },
      {
        event: channelUpdatedEvent('npm:example.com/empty-previous-version'),
        mutate: (event) => {
          Object.assign(event, { previousVersion: '' })
        },
        name: 'empty update previousVersion',
      },
      {
        event: channelDeletedEvent('npm:example.com/empty-previous-version'),
        mutate: (event) => {
          Object.assign(event, { previousVersion: '' })
        },
        name: 'empty delete previousVersion',
      },
    ]

    for (const item of cases) {
      const memory = new MemoryRegistryDatabase()
      const sqlite = new SQLiteRegistryDatabase(':memory:')

      item.mutate(item.event)
      Object.assign(item.event, {
        id: registryEventDigest(item.event),
      })

      try {
        expect(() => memory.appendEvent(item.event), item.name).toThrow(
          RegistryEventIntegrityError,
        )
        expect(() => sqlite.appendEvent(item.event), item.name).toThrow(
          RegistryEventIntegrityError,
        )
      } finally {
        sqlite.close()
      }
    }
  })

  it('rejects unsupported event types before persistence', () => {
    const memory = new MemoryRegistryDatabase()
    const sqlite = new SQLiteRegistryDatabase(':memory:')
    const event = unsignedPublishEvent('unsupported event type')
    Object.assign(event, {
      eventType: 'package.deleted',
    })

    try {
      expect(() => memory.appendEvent(event)).toThrow(
        RegistryEventIntegrityError,
      )
      expect(() => sqlite.appendEvent(event)).toThrow(
        RegistryEventIntegrityError,
      )
    } finally {
      sqlite.close()
    }
  })

  it('rejects events with non-canonical timestamps before persistence', () => {
    const memory = new MemoryRegistryDatabase()
    const sqlite = new SQLiteRegistryDatabase(':memory:')
    const event = unsignedPublishEvent('invalid timestamp')
    Object.assign(event, {
      id: registryEventDigest(event),
      timestamp: '2026-06-01T00:00:00Z',
    })
    Object.assign(event, {
      id: registryEventDigest(event),
    })

    try {
      expect(() => memory.appendEvent(event)).toThrow(
        RegistryEventIntegrityError,
      )
      expect(() => sqlite.appendEvent(event)).toThrow(
        RegistryEventIntegrityError,
      )
    } finally {
      sqlite.close()
    }
  })

  it('rejects events with non-string package state fields before persistence', () => {
    const memory = new MemoryRegistryDatabase()
    const sqlite = new SQLiteRegistryDatabase(':memory:')
    const event = unsignedPublishEvent('invalid event channel')
    Object.assign(event, {
      channel: 1,
    })
    Object.assign(event, {
      id: registryEventDigest(event),
    })

    try {
      expect(() => memory.appendEvent(event)).toThrow(
        'Registry event channel must be a non-empty string',
      )
      expect(() => sqlite.appendEvent(event)).toThrow(
        'Registry event channel must be a non-empty string',
      )
    } finally {
      sqlite.close()
    }
  })

  it('rejects events whose authorization domain does not match the package owner', () => {
    const memory = new MemoryRegistryDatabase()
    const sqlite = new SQLiteRegistryDatabase(':memory:')
    const event = authorizedPublishEvent('wrong auth domain', 'content')
    Object.assign(event.authorization!, {
      domain: 'other.example.com',
    })
    Object.assign(event, {
      id: registryEventDigest(event),
    })

    try {
      expect(() => memory.appendEvent(event)).toThrow(
        RegistryEventIntegrityError,
      )
      expect(() => sqlite.appendEvent(event)).toThrow(
        RegistryEventIntegrityError,
      )
    } finally {
      sqlite.close()
    }
  })

  it('rejects events whose authorization timestamp differs from event timestamp', () => {
    const memory = new MemoryRegistryDatabase()
    const sqlite = new SQLiteRegistryDatabase(':memory:')
    const event = authorizedPublishEvent('wrong auth timestamp', 'content')
    Object.assign(event, {
      timestamp: '2026-06-01T00:01:00.000Z',
    })
    Object.assign(event, {
      id: registryEventDigest(event),
    })

    try {
      expect(() => memory.appendEvent(event)).toThrow(
        RegistryEventIntegrityError,
      )
      expect(() => sqlite.appendEvent(event)).toThrow(
        RegistryEventIntegrityError,
      )
    } finally {
      sqlite.close()
    }
  })

  it('rejects events with invalid authorization proof digests', () => {
    const memory = new MemoryRegistryDatabase()
    const sqlite = new SQLiteRegistryDatabase(':memory:')
    const event = authorizedPublishEvent('invalid auth digest', 'content')
    Object.assign(event.authorization!, {
      payloadDigest: 'sha256:not-a-digest',
    })
    Object.assign(event, {
      id: registryEventDigest(event),
    })

    try {
      expect(() => memory.appendEvent(event)).toThrow(
        RegistryEventIntegrityError,
      )
      expect(() => sqlite.appendEvent(event)).toThrow(
        RegistryEventIntegrityError,
      )
    } finally {
      sqlite.close()
    }
  })

  it('rejects events with malformed authorization proof signatures', () => {
    const memory = new MemoryRegistryDatabase()
    const sqlite = new SQLiteRegistryDatabase(':memory:')

    try {
      for (const signature of ['!!!', `${TEST_ED25519_SIGNATURE}=`, 'YWJj']) {
        const event = authorizedPublishEvent(
          `invalid auth signature ${signature}`,
          signature,
        )
        Object.assign(event.authorization!, {
          signature,
        })
        Object.assign(event, {
          id: registryEventDigest(event),
        })

        expect(() => memory.appendEvent(event)).toThrow(
          RegistryEventIntegrityError,
        )
        expect(() => sqlite.appendEvent(event)).toThrow(
          RegistryEventIntegrityError,
        )
      }
    } finally {
      sqlite.close()
    }
  })

  it('rejects events with malformed authorization proof public keys', () => {
    const memory = new MemoryRegistryDatabase()
    const sqlite = new SQLiteRegistryDatabase(':memory:')

    try {
      for (const x of ['!!!', `${TEST_ED25519_PUBLIC_KEY}=`, 'YWJj']) {
        const event = authorizedPublishEvent(`invalid auth public key ${x}`, x)
        Object.assign(event.authorization!.publicKeyJwk, {
          x,
        })
        Object.assign(event, {
          id: registryEventDigest(event),
        })

        expect(() => memory.appendEvent(event)).toThrow(
          RegistryEventIntegrityError,
        )
        expect(() => sqlite.appendEvent(event)).toThrow(
          RegistryEventIntegrityError,
        )
      }
    } finally {
      sqlite.close()
    }
  })

  it('rejects events with unknown protocol fields', () => {
    const memory = new MemoryRegistryDatabase()
    const sqlite = new SQLiteRegistryDatabase(':memory:')
    const cases: Array<{
      event: () => RegistryEvent
      name: string
    }> = [
      {
        event: () => {
          const event = authorizedPublishEvent(
            'unknown top-level auth field',
            'content',
          )
          Object.assign(event.authorization!, {
            extra: true,
          })
          Object.assign(event, {
            id: registryEventDigest(event),
          })
          return event
        },
        name: 'authorization field',
      },
      {
        event: () => {
          const event = authorizedPublishEvent(
            'unknown public key field',
            'content',
          )
          Object.assign(event.authorization!.publicKeyJwk, {
            key_ops: ['verify'],
          })
          Object.assign(event, {
            id: registryEventDigest(event),
          })
          return event
        },
        name: 'public key field',
      },
      {
        event: () => {
          const event = authorizedPublishEvent(
            'unknown release field',
            'content',
          )
          Object.assign(event.release, {
            extra: true,
          })
          Object.assign(event, {
            id: registryEventDigest(event),
          })
          return event
        },
        name: 'release field',
      },
      {
        event: () => {
          const event = channelUpdatedEvent(
            'npm:example.com/unknown-event-field',
          )
          Object.assign(event, {
            extra: true,
          })
          Object.assign(event, {
            id: registryEventDigest(event),
          })
          return event
        },
        name: 'top-level event field',
      },
    ]

    try {
      for (const item of cases) {
        const event = item.event()

        expect(() => memory.appendEvent(event), item.name).toThrow(
          RegistryEventIntegrityError,
        )
        expect(() => sqlite.appendEvent(event), item.name).toThrow(
          RegistryEventIntegrityError,
        )
      }
    } finally {
      sqlite.close()
    }
  })

  it('rejects event ids that do not match canonical event payloads', () => {
    const memory = new MemoryRegistryDatabase()
    const sqlite = new SQLiteRegistryDatabase(':memory:')
    const event = {
      ...unsignedPublishEvent('wrong event id'),
      id: sha256(bytes('wrong event id')),
    }

    try {
      expect(() => memory.appendEvent(event)).toThrow(
        RegistryEventIntegrityError,
      )
      expect(() => sqlite.appendEvent(event)).toThrow(
        RegistryEventIntegrityError,
      )
    } finally {
      sqlite.close()
    }
  })
})

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value)
}

function hasCanonicalEnqueuedAt(entry: unknown): boolean {
  return (
    Boolean(entry) &&
    typeof entry === 'object' &&
    'enqueuedAt' in entry &&
    typeof entry.enqueuedAt === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(entry.enqueuedAt)
  )
}

function text(value: Uint8Array | undefined): string | undefined {
  return value ? new TextDecoder().decode(value) : undefined
}

async function only<T>(itemsPromise: Promise<T[]>): Promise<T> {
  const items = await itemsPromise
  const [item, ...rest] = items

  if (item === undefined || rest.length > 0) {
    throw new Error('Expected exactly one item')
  }

  return item
}

function publishEvent(event: RegistryEvent | undefined): PublishReleaseEvent {
  if (!event || event.eventType !== 'release.published') {
    throw new Error('Expected release.published event')
  }

  return event
}

function authorizedPublishEvent(
  payload: string,
  content: string,
): RegistryEvent {
  return publishReleaseEvent({
    authorization: {
      alg: 'EdDSA',
      domain: 'example.com',
      kid: 'test-key',
      object: 'regesta.authorization-proof',
      payloadDigest: sha256(bytes(payload)),
      publicKeyJwk: {
        crv: 'Ed25519',
        kty: 'OKP',
        x: TEST_ED25519_PUBLIC_KEY,
      },
      signature: TEST_ED25519_SIGNATURE,
      signedAt: '2026-06-01T00:00:00.000Z',
      wellKnownDigest: sha256(bytes('well-known')),
    },
    artifactDigests: [sha256(bytes(`artifact ${content}`))],
    channel: 'latest',
    eventType: 'release.published',
    object: 'regesta.event',
    release: {
      id: 'npm:example.com/duplicate',
      manifestDigest: sha256(bytes(`manifest ${content}`)),
      version: '0.0.1',
    },
    sourceDigest: sha256(bytes(`source ${content}`)),
    timestamp: '2026-06-01T00:00:00.000Z',
  })
}

function storedRelease(packageId: string, version: string): StoredRelease {
  const parsedPackageId = parsePackageId(packageId)
  const source = {
    digest: sha256(bytes('source')),
    mediaType: 'application/vnd.regesta.source-archive+tgz',
    size: 6,
  }
  const artifact = {
    digest: sha256(bytes('artifact')),
    mediaType: 'application/gzip',
    size: 8,
  }
  const manifest = {
    artifacts: [
      {
        ...artifact,
        role: 'install',
      },
    ],
    configDigest: sha256(bytes('config')),
    createdAt: '2026-06-01T00:00:00.000Z',
    ecosystem: parsedPackageId.ecosystem,
    id: parsedPackageId.id,
    name: parsedPackageId.name,
    object: 'regesta.release-manifest',
    provenance: {
      level: 'source-attached',
      verified: false,
    },
    source,
    version,
  } satisfies StoredRelease['manifest']
  const manifestBytes = bytes(`${canonicalJson(manifest)}\n`)
  const manifestDescriptor = {
    digest: sha256(manifestBytes),
    mediaType: 'application/vnd.regesta.release-manifest.v0+json',
    size: manifestBytes.byteLength,
  }
  const event = publishReleaseEvent({
    artifactDigests: [artifact.digest],
    channel: 'latest',
    eventType: 'release.published',
    object: 'regesta.event',
    release: {
      id: packageId,
      manifestDigest: manifestDescriptor.digest,
      version,
    },
    sourceDigest: source.digest,
    timestamp: '2026-06-01T00:00:00.000Z',
  })

  return {
    event,
    manifest,
    manifestDescriptor,
  }
}

function unsignedPublishEvent(content: string): RegistryEvent {
  return publishReleaseEvent({
    artifactDigests: [sha256(bytes(`artifact ${content}`))],
    channel: 'latest',
    eventType: 'release.published',
    object: 'regesta.event',
    release: {
      id: 'npm:example.com/duplicate-event',
      manifestDigest: sha256(bytes(`manifest ${content}`)),
      version: '0.0.1',
    },
    sourceDigest: sha256(bytes(`source ${content}`)),
    timestamp: '2026-06-01T00:00:00.000Z',
  })
}

function publishEventForPackage(
  packageId: PackageId,
  version: string,
  timestamp: string,
): PublishReleaseEvent {
  return publishReleaseEvent({
    artifactDigests: [sha256(bytes(`artifact ${packageId} ${version}`))],
    channel: 'latest',
    eventType: 'release.published',
    object: 'regesta.event',
    release: {
      id: packageId,
      manifestDigest: sha256(bytes(`manifest ${packageId} ${version}`)),
      version,
    },
    sourceDigest: sha256(bytes(`source ${packageId} ${version}`)),
    timestamp,
  })
}

function channelUpdatedEvent(
  packageId: string,
  options: {
    previousVersion?: string
    version?: string
  } = {},
): ChannelUpdatedEvent {
  const event = {
    channel: 'latest',
    eventType: 'channel.updated',
    object: 'regesta.event',
    package: packageId,
    ...(options.previousVersion
      ? { previousVersion: options.previousVersion }
      : {}),
    timestamp: '2026-06-01T00:01:00.000Z',
    version: options.version ?? '0.0.1',
  } satisfies Omit<ChannelUpdatedEvent, 'id'>

  return {
    ...event,
    id: registryEventDigest(event),
  }
}

function channelDeletedEvent(packageId: string): ChannelDeletedEvent {
  const event = {
    channel: 'latest',
    eventType: 'channel.deleted',
    object: 'regesta.event',
    package: packageId,
    previousVersion: '0.0.1',
    timestamp: '2026-06-01T00:02:00.000Z',
  } satisfies Omit<ChannelDeletedEvent, 'id'>

  return {
    ...event,
    id: registryEventDigest(event),
  }
}

function publishReleaseEvent(
  event: Omit<PublishReleaseEvent, 'id'>,
): PublishReleaseEvent {
  return {
    ...event,
    id: registryEventDigest(event),
  }
}

function objectPath(root: string, digest: string): string {
  const hex = digest.slice('sha256:'.length)
  return join(root, 'objects', hex.slice(0, 2), hex)
}

async function readdirRecursive(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true })
  const paths = await Promise.all(
    entries.map((entry) => {
      const path = join(root, entry.name)

      return entry.isDirectory() ? readdirRecursive(path) : [path]
    }),
  )

  return paths.flat().toSorted()
}
