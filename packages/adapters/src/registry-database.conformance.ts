import { Buffer } from 'node:buffer'
import {
  PackageChannelConflictError,
  PackageReleaseCursorNotFoundError,
  RegistryEventAlreadyExistsError,
  RegistryEventCursorNotFoundError,
  ReleaseAlreadyExistsError,
  WriteAuthorizationReplayError,
  type RegistryDatabase,
  type StoredRelease,
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
  type WriteAuthorizationProof,
} from '@regesta/protocol'
import { describe, expect, it } from 'vitest'

const TEST_ED25519_PUBLIC_KEY = Buffer.alloc(32, 1).toString('base64url')
const TEST_ED25519_SIGNATURE = Buffer.alloc(64, 2).toString('base64url')

export interface RegistryDatabaseConformanceTarget<
  TDatabase extends RegistryDatabase,
> {
  create: () => Promise<TDatabase> | TDatabase
  destroy?: (database: TDatabase) => Promise<void> | void
  name: string
}

export function describeRegistryDatabaseConformance<
  TDatabase extends RegistryDatabase,
>(target: RegistryDatabaseConformanceTarget<TDatabase>): void {
  describe(`${target.name} RegistryDatabase conformance`, () => {
    it('rejects duplicate event ids', async () => {
      await withDatabase(target, async (database) => {
        const firstEvent = unsignedPublishEvent('same event')
        const secondEvent = unsignedPublishEvent('same event')

        await database.appendEvent(firstEvent)
        await expectRegistryEventAlreadyExists(() =>
          database.appendEvent(secondEvent),
        )
      })
    })

    it('does not commit duplicate release versions', async () => {
      await withDatabase(target, async (database) => {
        const firstRelease = storedRelease(
          'npm:example.com/duplicate-release',
          '0.0.1',
        )
        const duplicateRelease = authorizedStoredRelease(
          'npm:example.com/duplicate-release',
          '0.0.1',
          'duplicate release authorization',
        )

        await database.commitPublishedRelease(firstRelease, 'latest')
        await expectReleaseAlreadyExists(() =>
          database.commitPublishedRelease(duplicateRelease, 'latest'),
        )
        await expect(
          database.getEvent(duplicateRelease.event.id),
        ).resolves.toBeUndefined()
        await expect(
          database.getRelease(
            duplicateRelease.manifest.id,
            duplicateRelease.manifest.version,
          ),
        ).resolves.toEqual(firstRelease)
        await expect(
          database.getPackageChannels(duplicateRelease.manifest.id),
        ).resolves.toEqual({ latest: firstRelease.manifest.version })
        await expect(database.countPackages()).resolves.toBe(1)
      })
    })

    it('commits only one concurrent publish for duplicate release versions', async () => {
      await withDatabase(target, async (database) => {
        const firstRelease = storedRelease(
          'npm:example.com/concurrent-duplicate-release',
          '0.0.1',
        )
        const duplicateRelease = authorizedStoredRelease(
          'npm:example.com/concurrent-duplicate-release',
          '0.0.1',
          'concurrent duplicate release authorization',
        )

        const results = await Promise.allSettled([
          Promise.resolve().then(() =>
            database.commitPublishedRelease(firstRelease, 'latest'),
          ),
          Promise.resolve().then(() =>
            database.commitPublishedRelease(duplicateRelease, 'latest'),
          ),
        ])
        const fulfilled = results.filter((result) => {
          return result.status === 'fulfilled'
        })
        const rejected = results.filter((result) => {
          return result.status === 'rejected'
        })

        expect(fulfilled).toHaveLength(1)
        expect(rejected).toHaveLength(1)
        expect(rejected[0]).toMatchObject({
          reason: expect.any(ReleaseAlreadyExistsError),
        })
        await expect(database.listEvents({ limit: 1 })).resolves.toHaveLength(1)
        await expect(
          database.getPackageChannels(firstRelease.manifest.id),
        ).resolves.toEqual({ latest: firstRelease.manifest.version })
        await expect(
          database.getRelease(
            firstRelease.manifest.id,
            firstRelease.manifest.version,
          ),
        ).resolves.toMatchObject({
          manifest: {
            id: firstRelease.manifest.id,
            version: firstRelease.manifest.version,
          },
        })
        await expect(database.countPackages()).resolves.toBe(1)
      })
    })

    it('counts packages with at least one stored release', async () => {
      await withDatabase(target, async (database) => {
        const firstRelease = storedRelease(
          'npm:example.com/package-count',
          '0.0.1',
        )
        const secondRelease = storedRelease(
          'npm:example.com/package-count',
          '0.0.2',
        )
        const otherPackageRelease = storedRelease(
          'npm:example.com/other-package-count',
          '0.0.1',
        )

        await expect(database.countPackages()).resolves.toBe(0)
        await expect(
          database.getPackageReleaseHead(firstRelease.manifest.id),
        ).resolves.toEqual({ releaseCount: 0 })
        await database.commitPublishedRelease(firstRelease, 'latest')
        await expect(database.countPackages()).resolves.toBe(1)
        await expect(
          database.getPackageReleaseHead(firstRelease.manifest.id),
        ).resolves.toEqual({
          modifiedAt: firstRelease.manifest.createdAt,
          releaseCount: 1,
        })
        await database.commitPublishedRelease(secondRelease, 'latest')
        await expect(database.countPackages()).resolves.toBe(1)
        await database.commitPublishedRelease(otherPackageRelease, 'latest')
        await expect(database.countPackages()).resolves.toBe(2)
      })
    })

    it('reads package release heads from indexed release state', async () => {
      await withDatabase(target, async (database) => {
        const firstRelease = storedRelease(
          'npm:example.com/release-head',
          '0.0.1',
        )
        const secondRelease = storedRelease(
          'npm:example.com/release-head',
          '0.0.2',
        )

        await expect(
          database.getPackageReleaseHead(firstRelease.manifest.id),
        ).resolves.toEqual({
          releaseCount: 0,
        })
        await database.commitPublishedRelease(firstRelease, 'latest')
        await expect(
          database.getPackageReleaseHead(firstRelease.manifest.id),
        ).resolves.toEqual({
          modifiedAt: firstRelease.manifest.createdAt,
          releaseCount: 1,
        })
        await database.commitPublishedRelease(secondRelease, 'latest')
        await expect(
          database.getPackageReleaseHead(firstRelease.manifest.id),
        ).resolves.toEqual({
          modifiedAt: secondRelease.manifest.createdAt,
          releaseCount: 2,
        })
      })
    })

    it('lists package releases with bounded cursor pagination', async () => {
      await withDatabase(target, async (database) => {
        const packageId: PackageId = 'npm:example.com/release-pages'
        const firstRelease = storedRelease(packageId, '0.0.1')
        const secondRelease = storedRelease(packageId, '0.0.2')
        const thirdRelease = storedRelease(packageId, '0.0.3')

        await database.commitPublishedRelease(firstRelease, 'latest')
        await database.commitPublishedRelease(secondRelease, 'latest')
        await database.commitPublishedRelease(thirdRelease, 'latest')

        await expect(
          database.listPackageReleases(packageId, { limit: 2 }),
        ).resolves.toEqual([firstRelease, secondRelease])
        await expect(
          database.listPackageReleases(packageId, {
            after: secondRelease.manifest.version,
            limit: 1,
          }),
        ).resolves.toEqual([thirdRelease])
        await expect(
          database.listPackageReleases(packageId, {
            after: '9.9.9',
            limit: 1,
          }),
        ).rejects.toThrow(PackageReleaseCursorNotFoundError)
      })
    })

    it('stores package state for future ecosystem keys without adapter-specific assumptions', async () => {
      await withDatabase(target, async (database) => {
        const release = storedRelease(
          'maven:example.com/group/artifact',
          '1.0.0',
        )

        await database.commitPublishedRelease(release, 'latest')

        await expect(
          database.getPackageReleaseHead(release.manifest.id),
        ).resolves.toEqual({
          modifiedAt: release.manifest.createdAt,
          releaseCount: 1,
        })
        await expect(database.countPackages()).resolves.toBe(1)
        await expect(
          database.getPackageChannels(release.manifest.id),
        ).resolves.toEqual({ latest: '1.0.0' })
        await expect(
          database.getPackageEventState(release.manifest.id),
        ).resolves.toMatchObject({
          state: {
            ecosystem: 'maven',
            id: 'maven:example.com/group/artifact',
            name: 'example.com/group/artifact',
          },
        })
        await expect(
          database.listPackageReleases(release.manifest.id, { limit: 1 }),
        ).resolves.toEqual([release])
      })
    })

    it('reads package state from event-derived registry state', async () => {
      await withDatabase(target, async (database) => {
        const packageId: PackageId = 'npm:example.com/event-state'
        const firstEvent = publishEventForPackage(
          packageId,
          '0.0.1',
          '2026-06-01T00:00:00.000Z',
        )
        const secondEvent = publishEventForPackage(
          packageId,
          '0.0.2',
          '2026-06-01T00:01:00.000Z',
        )
        const updateEvent = channelUpdatedEvent(packageId, {
          previousVersion: '0.0.2',
          version: '0.0.1',
        })

        await database.appendEvent(firstEvent)
        await database.appendEvent(secondEvent)
        await database.appendEvent(updateEvent)

        await expect(database.getPackageEventState(packageId)).resolves.toEqual(
          {
            lastEventId: updateEvent.id,
            lastEventTimestamp: updateEvent.timestamp,
            state: {
              channels: {
                latest: '0.0.1',
              },
              ecosystem: 'npm',
              id: packageId,
              name: 'example.com/event-state',
              object: 'regesta.package-state',
              releases: [
                {
                  createdAt: '2026-06-01T00:00:00.000Z',
                  manifestDigest: firstEvent.release.manifestDigest,
                  version: '0.0.1',
                },
                {
                  createdAt: '2026-06-01T00:01:00.000Z',
                  manifestDigest: secondEvent.release.manifestDigest,
                  version: '0.0.2',
                },
              ],
            },
          },
        )
      })
    })

    it('reads package event heads from indexed package state', async () => {
      await withDatabase(target, async (database) => {
        const packageId: PackageId = 'npm:example.com/event-head'
        const firstEvent = publishEventForPackage(
          packageId,
          '0.0.1',
          '2026-06-01T00:00:00.000Z',
        )
        const secondEvent = publishEventForPackage(
          packageId,
          '0.0.2',
          '2026-06-01T00:01:00.000Z',
        )
        const updateEvent = channelUpdatedEvent(packageId, {
          previousVersion: '0.0.2',
          version: '0.0.1',
        })

        await expect(database.getPackageEventHead(packageId)).resolves.toEqual({
          releaseCount: 0,
        })

        await database.appendEvent(firstEvent)
        await database.appendEvent(secondEvent)
        await database.appendEvent(updateEvent)

        await expect(database.getPackageEventHead(packageId)).resolves.toEqual({
          lastEventId: updateEvent.id,
          lastEventTimestamp: updateEvent.timestamp,
          modifiedAt: '2026-06-01T00:01:00.000Z',
          releaseCount: 2,
        })
      })
    })

    it('returns isolated package event state snapshots', async () => {
      await withDatabase(target, async (database) => {
        const packageId: PackageId = 'npm:example.com/isolated-event-state'
        const event = publishEventForPackage(
          packageId,
          '0.0.1',
          '2026-06-01T00:00:00.000Z',
        )

        await database.appendEvent(event)

        const expected = await database.getPackageEventState(packageId)
        const firstRead = await database.getPackageEventState(packageId)
        firstRead.state.channels!.latest = '9.9.9'
        firstRead.state.releases[0]!.createdAt = '2099-01-01T00:00:00.000Z'
        firstRead.state.releases[0]!.manifestDigest = sha256(
          bytes('mutated manifest'),
        )
        firstRead.state.releases[0]!.version = '9.9.9'

        await expect(database.getPackageEventState(packageId)).resolves.toEqual(
          expected,
        )
      })
    })

    it('lists event pages in sequence order and rejects unknown cursors', async () => {
      await withDatabase(target, async (database) => {
        const firstEvent = publishEventForPackage(
          'npm:example.com/events',
          '0.0.1',
          '2026-06-01T00:00:00.000Z',
        )
        const secondEvent = publishEventForPackage(
          'npm:example.com/events',
          '0.0.2',
          '2026-06-01T00:01:00.000Z',
        )
        const thirdEvent = publishEventForPackage(
          'npm:example.com/events',
          '0.0.3',
          '2026-06-01T00:02:00.000Z',
        )
        const missingCursor = sha256(bytes('missing event cursor'))

        for (const event of [firstEvent, secondEvent, thirdEvent]) {
          await database.appendEvent(event)
        }

        await expect(database.listEvents({ limit: 2 })).resolves.toEqual([
          firstEvent,
          secondEvent,
        ])
        await expect(
          database.listEvents({ after: firstEvent.id, limit: 1 }),
        ).resolves.toEqual([secondEvent])
        await expect(
          database.listEvents({ after: secondEvent.id, limit: 1 }),
        ).resolves.toEqual([thirdEvent])
        await expect(
          database.listEvents({ after: missingCursor, limit: 1 }),
        ).rejects.toThrow(RegistryEventCursorNotFoundError)
      })
    })

    it('returns isolated event copies from public event reads', async () => {
      await withDatabase(target, async (database) => {
        const event = publishEventForPackage(
          'npm:example.com/isolated-event-reads',
          '0.0.1',
          '2026-06-01T00:00:00.000Z',
        )

        await database.appendEvent(event)

        const byId = await database.getEvent(event.id)
        const page = await database.listEvents({ limit: 1 })
        const byPage = page[0]

        if (
          byId?.eventType !== 'release.published' ||
          byPage?.eventType !== 'release.published'
        ) {
          throw new Error('Expected release.published event reads')
        }
        byId.release.version = '9.9.9'
        byPage.release.version = '8.8.8'

        await expect(database.getEvent(event.id)).resolves.toEqual(event)
        await expect(database.listEvents({ limit: 1 })).resolves.toEqual([
          event,
        ])
      })
    })

    it('returns isolated release copies from public release reads', async () => {
      await withDatabase(target, async (database) => {
        const packageId: PackageId = 'npm:example.com/isolated-release-reads'
        const release = storedRelease(packageId, '0.0.1')
        const expected = structuredClone(release)

        await database.commitPublishedRelease(release, 'latest')

        release.manifest.version = '9.9.9'
        publishEvent(release.event).release.version = '9.9.9'
        release.manifest.artifacts[0]!.role = 'mutated-input'

        const byKey = await database.getRelease(packageId, '0.0.1')
        const byList = (
          await database.listPackageReleases(packageId, { limit: 1 })
        )[0]

        if (!byKey || !byList) {
          throw new Error('Expected release reads')
        }

        byKey.manifest.version = '8.8.8'
        publishEvent(byKey.event).release.version = '8.8.8'
        byKey.manifest.artifacts[0]!.role = 'mutated-by-key'
        byList.manifest.version = '7.7.7'
        publishEvent(byList.event).release.version = '7.7.7'
        byList.manifest.artifacts[0]!.role = 'mutated-by-list'

        await expect(database.getRelease(packageId, '0.0.1')).resolves.toEqual(
          expected,
        )
        await expect(
          database.listPackageReleases(packageId, { limit: 1 }),
        ).resolves.toEqual([expected])
      })
    })

    it('returns single package channel versions from indexed channel state', async () => {
      await withDatabase(target, async (database) => {
        const packageId: PackageId = 'npm:example.com/single-channel-read'
        const firstRelease = storedRelease(packageId, '0.0.1')
        const secondRelease = storedRelease(packageId, '0.0.2')

        await expect(
          database.getPackageChannelVersion(packageId, 'latest'),
        ).resolves.toBeUndefined()

        await database.commitPublishedRelease(firstRelease, 'latest')
        await expect(
          database.getPackageChannelVersion(packageId, 'latest'),
        ).resolves.toBe('0.0.1')
        await expect(
          database.getPackageChannelVersion(packageId, 'beta'),
        ).resolves.toBeUndefined()

        await database.commitPublishedRelease(secondRelease, 'latest')
        await database.commitPackageChannelUpdate(
          channelUpdatedEvent(packageId, {
            channel: 'next',
            version: '0.0.2',
          }),
        )
        await expect(
          database.getPackageChannelVersion(packageId, 'latest'),
        ).resolves.toBe('0.0.2')
        await expect(
          database.getPackageChannelVersion(packageId, 'next'),
        ).resolves.toBe('0.0.2')

        await database.commitPackageChannelDelete(
          channelDeletedEvent(packageId, {
            channel: 'latest',
            previousVersion: '0.0.2',
          }),
        )
        await expect(
          database.getPackageChannelVersion(packageId, 'latest'),
        ).resolves.toBeUndefined()
        await expect(database.getPackageChannels(packageId)).resolves.toEqual({
          next: '0.0.2',
        })
      })
    })

    it('rejects invalid event page limits', async () => {
      await withDatabase(target, async (database) => {
        for (const limit of [0, 1000, 1.5]) {
          await expectEventPageLimitRejection(() =>
            database.listEvents({ limit }),
          )
        }
      })
    })

    it('rejects invalid package release page limits', async () => {
      await withDatabase(target, async (database) => {
        for (const limit of [0, 1000, 1.5]) {
          await expectPackageReleasePageLimitRejection(() =>
            database.listPackageReleases('npm:example.com/releases', {
              limit,
            }),
          )
        }
      })
    })

    it('does not commit publish state when authorization payloads are replayed', async () => {
      await withDatabase(target, async (database) => {
        const firstRelease = authorizedStoredRelease(
          'npm:example.com/replayed-publish',
          '0.0.1',
          'same publish authorization',
        )
        const replayedRelease = authorizedStoredRelease(
          'npm:example.com/replayed-publish',
          '0.0.2',
          'same publish authorization',
        )

        await database.commitPublishedRelease(firstRelease, 'latest')
        await expectWriteAuthorizationReplay(() =>
          database.commitPublishedRelease(replayedRelease, 'latest'),
        )
        await expect(
          database.getEvent(replayedRelease.event.id),
        ).resolves.toBeUndefined()
        await expect(
          database.getRelease(
            replayedRelease.manifest.id,
            replayedRelease.manifest.version,
          ),
        ).resolves.toBeUndefined()
        await expect(
          database.getPackageChannels(replayedRelease.manifest.id),
        ).resolves.toEqual({ latest: firstRelease.manifest.version })
      })
    })

    it('does not update channels when channel update authorization is replayed', async () => {
      await withDatabase(target, async (database) => {
        const packageId: PackageId = 'npm:example.com/replayed-channel-update'
        const firstRelease = storedRelease(packageId, '0.0.1')
        const secondRelease = storedRelease(packageId, '0.0.2')
        const firstUpdate = authorizedChannelUpdatedEvent(
          packageId,
          {
            previousVersion: '0.0.2',
            version: '0.0.1',
          },
          'same channel update authorization',
        )
        const replayedUpdate = authorizedChannelUpdatedEvent(
          packageId,
          {
            previousVersion: '0.0.1',
            version: '0.0.2',
          },
          'same channel update authorization',
        )

        await database.commitPublishedRelease(firstRelease, 'latest')
        await database.commitPublishedRelease(secondRelease, 'latest')
        await database.commitPackageChannelUpdate(firstUpdate)
        await expectWriteAuthorizationReplay(() =>
          database.commitPackageChannelUpdate(replayedUpdate),
        )
        await expect(
          database.getEvent(replayedUpdate.id),
        ).resolves.toBeUndefined()
        await expect(database.getPackageChannels(packageId)).resolves.toEqual({
          latest: '0.0.1',
        })
      })
    })

    it('commits only one concurrent update from the same channel version', async () => {
      await withDatabase(target, async (database) => {
        const packageId: PackageId = 'npm:example.com/concurrent-channel-update'
        const firstRelease = storedRelease(packageId, '0.0.1')
        const secondRelease = storedRelease(packageId, '0.0.2')
        const thirdRelease = storedRelease(packageId, '0.0.3')
        const firstUpdate = authorizedChannelUpdatedEvent(
          packageId,
          {
            previousVersion: '0.0.3',
            version: '0.0.1',
          },
          'concurrent channel update authorization 1',
        )
        const secondUpdate = authorizedChannelUpdatedEvent(
          packageId,
          {
            previousVersion: '0.0.3',
            version: '0.0.2',
          },
          'concurrent channel update authorization 2',
        )

        await database.commitPublishedRelease(firstRelease, 'latest')
        await database.commitPublishedRelease(secondRelease, 'latest')
        await database.commitPublishedRelease(thirdRelease, 'latest')

        const results = await Promise.allSettled([
          Promise.resolve().then(() =>
            database.commitPackageChannelUpdate(firstUpdate),
          ),
          Promise.resolve().then(() =>
            database.commitPackageChannelUpdate(secondUpdate),
          ),
        ])
        const fulfilled = results.filter((result) => {
          return result.status === 'fulfilled'
        })
        const rejected = results.filter((result) => {
          return result.status === 'rejected'
        })
        const channels = await database.getPackageChannels(packageId)
        const events = await database.listEvents({ limit: 4 })

        expect(fulfilled).toHaveLength(1)
        expect(rejected).toHaveLength(1)
        expect(rejected[0]).toMatchObject({
          reason: expect.any(PackageChannelConflictError),
        })
        expect(channels.latest).toMatch(/^0\.0\.[12]$/u)
        expect(events).toHaveLength(4)
        expect(
          events.filter((event) => {
            return event.eventType === 'channel.updated'
          }),
        ).toHaveLength(1)
      })
    })

    it('does not delete channels when channel delete authorization is replayed', async () => {
      await withDatabase(target, async (database) => {
        const release = storedRelease(
          'npm:example.com/replayed-channel-delete',
          '0.0.1',
        )
        const firstDelete = authorizedChannelDeletedEvent(
          release.manifest.id,
          {
            previousVersion: '0.0.1',
          },
          'same channel delete authorization',
        )
        const replayedDelete = authorizedChannelDeletedEvent(
          release.manifest.id,
          {},
          'same channel delete authorization',
        )

        await database.commitPublishedRelease(release, 'latest')
        await database.commitPackageChannelDelete(firstDelete)
        await expectWriteAuthorizationReplay(() =>
          database.commitPackageChannelDelete(replayedDelete),
        )
        await expect(
          database.getEvent(replayedDelete.id),
        ).resolves.toBeUndefined()
        await expect(
          database.getPackageChannels(release.manifest.id),
        ).resolves.toEqual({})
      })
    })

    it('commits only one concurrent delete from the same channel version', async () => {
      await withDatabase(target, async (database) => {
        const release = storedRelease(
          'npm:example.com/concurrent-channel-delete',
          '0.0.1',
        )
        const firstDelete = authorizedChannelDeletedEvent(
          release.manifest.id,
          {
            previousVersion: '0.0.1',
          },
          'concurrent channel delete authorization 1',
        )
        const secondDelete = authorizedChannelDeletedEvent(
          release.manifest.id,
          {
            previousVersion: '0.0.1',
          },
          'concurrent channel delete authorization 2',
        )

        await database.commitPublishedRelease(release, 'latest')

        const results = await Promise.allSettled([
          Promise.resolve().then(() =>
            database.commitPackageChannelDelete(firstDelete),
          ),
          Promise.resolve().then(() =>
            database.commitPackageChannelDelete(secondDelete),
          ),
        ])
        const fulfilled = results.filter((result) => {
          return result.status === 'fulfilled'
        })
        const rejected = results.filter((result) => {
          return result.status === 'rejected'
        })
        const events = await database.listEvents({ limit: 2 })

        expect(fulfilled).toHaveLength(1)
        expect(rejected).toHaveLength(1)
        expect(rejected[0]).toMatchObject({
          reason: expect.any(PackageChannelConflictError),
        })
        await expect(
          database.getPackageChannels(release.manifest.id),
        ).resolves.toEqual({})
        expect(events).toHaveLength(2)
        expect(
          events.filter((event) => {
            return event.eventType === 'channel.deleted'
          }),
        ).toHaveLength(1)
      })
    })
  })
}

async function withDatabase<TDatabase extends RegistryDatabase>(
  target: RegistryDatabaseConformanceTarget<TDatabase>,
  run: (database: TDatabase) => Promise<void>,
): Promise<void> {
  const database = await target.create()

  try {
    await run(database)
  } finally {
    await target.destroy?.(database)
  }
}

async function expectWriteAuthorizationReplay(
  write: () => Promise<void>,
): Promise<void> {
  try {
    await write()
  } catch (error) {
    expect(error).toBeInstanceOf(WriteAuthorizationReplayError)
    return
  }

  throw new Error('Expected write authorization replay')
}

async function expectRegistryEventAlreadyExists(
  write: () => Promise<void>,
): Promise<void> {
  try {
    await write()
  } catch (error) {
    expect(error).toBeInstanceOf(RegistryEventAlreadyExistsError)
    return
  }

  throw new Error('Expected duplicate registry event rejection')
}

async function expectReleaseAlreadyExists(
  write: () => Promise<void>,
): Promise<void> {
  try {
    await write()
  } catch (error) {
    expect(error).toBeInstanceOf(ReleaseAlreadyExistsError)
    return
  }

  throw new Error('Expected duplicate release rejection')
}

async function expectEventPageLimitRejection(
  read: () => Promise<unknown>,
): Promise<void> {
  try {
    await read()
  } catch (error) {
    expectEventPageLimitError(error)
    return
  }

  throw new Error('Expected event page limit rejection')
}

async function expectPackageReleasePageLimitRejection(
  read: () => Promise<unknown>,
): Promise<void> {
  try {
    await read()
  } catch (error) {
    expectPackageReleasePageLimitError(error)
    return
  }

  throw new Error('Expected package release page limit rejection')
}

function expectEventPageLimitError(error: unknown): void {
  expect(error).toBeInstanceOf(TypeError)
  expect(error).toMatchObject({
    message: 'Registry event page limit must be an integer from 1 to 999',
  })
}

function expectPackageReleasePageLimitError(error: unknown): void {
  expect(error).toBeInstanceOf(TypeError)
  expect(error).toMatchObject({
    message: 'Package release page limit must be an integer from 1 to 999',
  })
}

function publishEvent(event: StoredRelease['event']): PublishReleaseEvent {
  if (event.eventType !== 'release.published') {
    throw new Error('Expected release.published event')
  }

  return event
}

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value)
}

function storedRelease(packageId: PackageId, version: string): StoredRelease {
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

function authorizedStoredRelease(
  packageId: PackageId,
  version: string,
  authorizationPayload: string,
): StoredRelease {
  const release = storedRelease(packageId, version)
  const event = publishEvent(release.event)

  release.event = publishReleaseEvent({
    authorization: authorizationProof(
      packageId,
      event.timestamp,
      authorizationPayload,
    ),
    artifactDigests: event.artifactDigests,
    channel: event.channel,
    eventType: 'release.published',
    object: 'regesta.event',
    release: event.release,
    sourceDigest: event.sourceDigest,
    timestamp: event.timestamp,
  })

  return release
}

function authorizedChannelUpdatedEvent(
  packageId: PackageId,
  options: {
    previousVersion?: string
    version?: string
  },
  authorizationPayload: string,
): ChannelUpdatedEvent {
  const base = channelUpdatedEvent(packageId, options)
  const event = {
    authorization: authorizationProof(
      packageId,
      base.timestamp,
      authorizationPayload,
    ),
    channel: base.channel,
    eventType: base.eventType,
    object: base.object,
    package: base.package,
    ...(base.previousVersion ? { previousVersion: base.previousVersion } : {}),
    timestamp: base.timestamp,
    version: base.version,
  } satisfies Omit<ChannelUpdatedEvent, 'id'>

  return {
    ...event,
    id: registryEventDigest(event),
  }
}

function authorizedChannelDeletedEvent(
  packageId: PackageId,
  options: {
    previousVersion?: string
  },
  authorizationPayload: string,
): ChannelDeletedEvent {
  const base = channelDeletedEvent(packageId, options)
  const event = {
    authorization: authorizationProof(
      packageId,
      base.timestamp,
      authorizationPayload,
    ),
    channel: base.channel,
    eventType: base.eventType,
    object: base.object,
    package: base.package,
    ...(base.previousVersion ? { previousVersion: base.previousVersion } : {}),
    timestamp: base.timestamp,
  } satisfies Omit<ChannelDeletedEvent, 'id'>

  return {
    ...event,
    id: registryEventDigest(event),
  }
}

function unsignedPublishEvent(content: string): PublishReleaseEvent {
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
  packageId: PackageId,
  options: {
    channel?: string
    previousVersion?: string
    version?: string
  } = {},
): ChannelUpdatedEvent {
  const event = {
    channel: options.channel ?? 'latest',
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

function channelDeletedEvent(
  packageId: PackageId,
  options?: {
    channel?: string
    previousVersion?: string
  },
): ChannelDeletedEvent {
  const previousVersion =
    options === undefined ? '0.0.1' : options.previousVersion
  const event = {
    channel: options?.channel ?? 'latest',
    eventType: 'channel.deleted',
    object: 'regesta.event',
    package: packageId,
    ...(previousVersion ? { previousVersion } : {}),
    timestamp: '2026-06-01T00:02:00.000Z',
  } satisfies Omit<ChannelDeletedEvent, 'id'>

  return {
    ...event,
    id: registryEventDigest(event),
  }
}

function authorizationProof(
  packageId: PackageId,
  signedAt: string,
  authorizationPayload: string,
): WriteAuthorizationProof {
  return {
    alg: 'EdDSA',
    domain: ownerDomainFromPackageId(packageId),
    kid: 'test-key',
    object: 'regesta.authorization-proof',
    payloadDigest: sha256(bytes(authorizationPayload)),
    publicKeyJwk: {
      crv: 'Ed25519',
      kty: 'OKP',
      x: TEST_ED25519_PUBLIC_KEY,
    },
    signature: TEST_ED25519_SIGNATURE,
    signedAt,
    wellKnownDigest: sha256(bytes('well-known')),
  }
}

function ownerDomainFromPackageId(packageId: PackageId): string {
  return parsePackageId(packageId).ownerDomain
}

function publishReleaseEvent(
  event: Omit<PublishReleaseEvent, 'id'>,
): PublishReleaseEvent {
  return {
    ...event,
    id: registryEventDigest(event),
  }
}
