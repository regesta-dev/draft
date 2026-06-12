import {
  parsePackageId,
  registryEventDigest,
  sha256,
  type ChannelUpdatedEventPayload,
  type PublishReleaseEvent,
  type PublishReleaseEventPayload,
  type RegistryEvent,
  type ReleaseManifest,
} from '@regesta/protocol'
import { describe, expect, it, vi } from 'vitest'
import {
  createLocalNpmPackageProjectionCache,
  localNpmPackageId,
  npmVersionManifestEtag,
  readLocalNpmPackageProjection,
  type NpmPackageStateSnapshot,
  type NpmProjectionStateReader,
} from './projection.ts'

const packageId = parsePackageId('npm:example.com/hello-regesta').id

describe('local npm projection', () => {
  it('maps native npm names to local package ids when they are domain-scoped', () => {
    expect(localNpmPackageId('@example.com/hello-regesta')).toBe(packageId)
    expect(localNpmPackageId('hello-regesta')).toBeUndefined()
  })

  it('projects local releases and replayed channels into npm metadata', async () => {
    const first = release('1.0.0', '2025-01-01T00:00:00.000Z')
    const second = release('2.0.0', '2025-01-02T00:00:00.000Z')
    const firstPublished = publish(first, 'latest', '2025-01-01T00:00:00.000Z')
    const secondPublished = publish(second, 'next', '2025-01-02T00:00:00.000Z')
    const latestUpdated = channelUpdated(
      'latest',
      '2.0.0',
      '2025-01-03T00:00:00.000Z',
      '1.0.0',
    )
    const projection = await readLocalNpmPackageProjection(
      {
        database: {
          getPackageEventHead: () =>
            Promise.resolve({
              lastEventId: latestUpdated.id,
              lastEventTimestamp: latestUpdated.timestamp,
              modifiedAt: latestUpdated.timestamp,
              releaseCount: 2,
            }),
          getPackageReleaseHead: () =>
            Promise.resolve({
              modifiedAt: second.createdAt,
              releaseCount: 2,
            }),
          getPackageEventState: () =>
            Promise.resolve({
              lastEventId: latestUpdated.id,
              lastEventTimestamp: latestUpdated.timestamp,
              state: {
                channels: {
                  latest: '2.0.0',
                  next: '2.0.0',
                },
                ecosystem: 'npm',
                id: packageId,
                name: 'example.com/hello-regesta',
                object: 'regesta.package-state',
                releases: [
                  {
                    createdAt: firstPublished.timestamp,
                    manifestDigest: firstPublished.release.manifestDigest,
                    version: firstPublished.release.version,
                  },
                  {
                    createdAt: secondPublished.timestamp,
                    manifestDigest: secondPublished.release.manifestDigest,
                    version: secondPublished.release.version,
                  },
                ],
              },
            }),
          listPackageReleases: () =>
            Promise.resolve([
              {
                event: firstPublished,
                manifest: first,
              },
              {
                event: secondPublished,
                manifest: second,
              },
            ]),
        },
      },
      packageId,
      new URL('https://npm.registry.test/@example.com/hello-regesta'),
    )

    if (!projection) {
      throw new Error('Expected local npm projection')
    }

    expect(projection.channels).toEqual({
      latest: '2.0.0',
      next: '2.0.0',
    })
    expect(projection.etag).toBe(
      `W/"regesta.npm-projection:${latestUpdated.id}"`,
    )
    expect(projection.modifiedAt).toBe('2025-01-03T00:00:00.000Z')
    expect(projection.packument).toMatchObject({
      'dist-tags': {
        latest: '2.0.0',
        next: '2.0.0',
      },
      description: 'Regesta hello package',
      name: '@example.com/hello-regesta',
      time: {
        '1.0.0': '2025-01-01T00:00:00.000Z',
        '2.0.0': '2025-01-02T00:00:00.000Z',
        created: '2025-01-01T00:00:00.000Z',
        modified: '2025-01-03T00:00:00.000Z',
      },
      versions: {
        '1.0.0': {
          description: 'Regesta hello package',
          dist: {
            tarball:
              'https://npm.registry.test/@example.com/hello-regesta/-/hello-regesta-1.0.0.tgz',
          },
        },
        '2.0.0': {
          dist: {
            tarball:
              'https://npm.registry.test/@example.com/hello-regesta/-/hello-regesta-2.0.0.tgz',
          },
        },
      },
    })
  })

  it('rejects invalid adapter package states before projecting npm metadata', async () => {
    const first = release('1.0.0', '2025-01-01T00:00:00.000Z')
    const firstPublished = publish(first, 'latest', '2025-01-01T00:00:00.000Z')
    const snapshot = packageStateSnapshot(firstPublished)
    const reader = {
      database: {
        getPackageEventHead: vi.fn(() => {
          throw new Error('uncached reads should not read package event heads')
        }),
        getPackageEventState: vi.fn(() =>
          Promise.resolve({
            ...snapshot,
            state: {
              ...snapshot.state,
              channels: {
                latest: '9.9.9',
              },
            },
          }),
        ),
        getPackageReleaseHead: vi.fn(() =>
          Promise.resolve({
            modifiedAt: first.createdAt,
            releaseCount: 1,
          }),
        ),
        listPackageReleases: vi.fn(() =>
          Promise.resolve([
            {
              event: firstPublished,
              manifest: first,
            },
          ]),
        ),
      },
    } satisfies NpmProjectionStateReader

    await expect(
      readLocalNpmPackageProjection(
        reader,
        packageId,
        new URL('https://npm.registry.test/@example.com/hello-regesta'),
      ),
    ).rejects.toThrow(
      'Adapter package state channels latest must target an existing release version: 9.9.9',
    )
  })

  it('builds version manifest etags from release event ids', () => {
    expect(npmVersionManifestEtag(sha256('release-event'))).toBe(
      `W/"regesta.npm-version:${sha256('release-event')}"`,
    )
  })

  it('skips full projection reads when the package has no local releases', async () => {
    const getPackageReleaseHead = vi
      .fn<NpmProjectionStateReader['database']['getPackageReleaseHead']>()
      .mockResolvedValue({
        releaseCount: 0,
      })
    const listPackageReleases = vi.fn(() => {
      throw new Error('missing package projection should not list releases')
    })
    const getPackageEventState = vi.fn(() => {
      throw new Error('missing package projection should not read event state')
    })
    const reader = {
      database: {
        getPackageEventHead: vi.fn(() => {
          throw new Error('uncached reads should not read package event heads')
        }),
        getPackageEventState,
        getPackageReleaseHead,
        listPackageReleases,
      },
    } satisfies NpmProjectionStateReader

    await expect(
      readLocalNpmPackageProjection(
        reader,
        packageId,
        new URL('https://npm.registry.test/@example.com/hello-regesta'),
      ),
    ).resolves.toBeUndefined()

    expect(getPackageReleaseHead).toHaveBeenCalledOnce()
    expect(getPackageReleaseHead).toHaveBeenCalledWith(packageId)
    expect(listPackageReleases).not.toHaveBeenCalled()
    expect(getPackageEventState).not.toHaveBeenCalled()
  })

  it('does not read an extra empty release page at the page-size boundary', async () => {
    const releases = Array.from({ length: 999 }, (_, index) => {
      const version = `1.0.${index}`
      const manifest = release(
        version,
        new Date(Date.UTC(2025, 0, 1, 0, 0, index)).toISOString(),
      )
      const event = publish(manifest, 'latest', manifest.createdAt)

      return {
        event,
        manifest,
      }
    })
    const last = releases.at(-1)!
    const getPackageReleaseHead = vi.fn(() =>
      Promise.resolve({
        modifiedAt: last.manifest.createdAt,
        releaseCount: releases.length,
      }),
    )
    const listPackageReleases = vi.fn(() => Promise.resolve(releases))
    const reader = {
      database: {
        getPackageEventHead: vi.fn(() => {
          throw new Error('uncached reads should not read package event heads')
        }),
        getPackageEventState: vi.fn(() =>
          Promise.resolve(
            packageStateSnapshotFromEvents(
              releases.map((item) => item.event),
              {
                latest: last.manifest.version,
              },
              last.event,
            ),
          ),
        ),
        getPackageReleaseHead,
        listPackageReleases,
      },
    } satisfies NpmProjectionStateReader

    const projection = await readLocalNpmPackageProjection(
      reader,
      packageId,
      new URL('https://npm.registry.test/@example.com/hello-regesta'),
    )

    if (!projection) {
      throw new Error('Expected local npm projection')
    }

    expect(projection.packument.versions).toHaveProperty('1.0.998')
    expect(getPackageReleaseHead).toHaveBeenCalledOnce()
    expect(listPackageReleases).toHaveBeenCalledOnce()
    expect(listPackageReleases).toHaveBeenCalledWith(packageId, {
      limit: 999,
    })
  })

  it('reuses cached packuments while the package event id is unchanged', async () => {
    const first = release('1.0.0', '2025-01-01T00:00:00.000Z')
    const firstPublished = publish(first, 'latest', '2025-01-01T00:00:00.000Z')
    const cache = createLocalNpmPackageProjectionCache()
    const listPackageReleases = vi.fn(() =>
      Promise.resolve([
        {
          event: firstPublished,
          manifest: first,
        },
      ]),
    )
    const getPackageEventState = vi.fn(() =>
      Promise.resolve(packageStateSnapshot(firstPublished)),
    )
    const getPackageEventHead = vi.fn(() =>
      Promise.resolve({
        lastEventId: firstPublished.id,
        lastEventTimestamp: firstPublished.timestamp,
        modifiedAt: firstPublished.timestamp,
        releaseCount: 1,
      }),
    )
    const getPackageReleaseHead = vi.fn(() =>
      Promise.resolve({
        modifiedAt: first.createdAt,
        releaseCount: 1,
      }),
    )
    const reader = {
      database: {
        getPackageEventHead,
        getPackageEventState,
        getPackageReleaseHead,
        listPackageReleases,
      },
    } satisfies NpmProjectionStateReader

    const firstProjection = await readLocalNpmPackageProjection(
      reader,
      packageId,
      new URL('https://npm.registry.test/@example.com/hello-regesta'),
      cache,
    )
    const cachedProjection = await readLocalNpmPackageProjection(
      reader,
      packageId,
      new URL('https://npm.registry.test/@example.com/hello-regesta'),
      cache,
    )

    if (!firstProjection) {
      throw new Error('Expected first local npm projection')
    }

    expect(cachedProjection).toBe(firstProjection)
    expect(listPackageReleases).toHaveBeenCalledOnce()
    expect(getPackageEventState).toHaveBeenCalledOnce()
    expect(getPackageEventHead).toHaveBeenCalledOnce()
    expect(getPackageReleaseHead).toHaveBeenCalledTimes(2)
  })

  it('retries before caching when package state changes during projection reads', async () => {
    const first = release('1.0.0', '2025-01-01T00:00:00.000Z')
    const second = release('2.0.0', '2025-01-02T00:00:00.000Z')
    const firstPublished = publish(first, 'latest', '2025-01-01T00:00:00.000Z')
    const secondPublished = publish(
      second,
      'latest',
      '2025-01-02T00:00:00.000Z',
    )
    const cache = createLocalNpmPackageProjectionCache()
    const latestSnapshot = packageStateSnapshotFromEvents(
      [firstPublished, secondPublished],
      { latest: '2.0.0' },
      secondPublished,
    )
    const listPackageReleases = vi
      .fn<NpmProjectionStateReader['database']['listPackageReleases']>()
      .mockResolvedValueOnce([
        {
          event: firstPublished,
          manifest: first,
        },
      ])
      .mockResolvedValue([
        {
          event: firstPublished,
          manifest: first,
        },
        {
          event: secondPublished,
          manifest: second,
        },
      ])
    const getPackageEventState = vi
      .fn<NpmProjectionStateReader['database']['getPackageEventState']>()
      .mockResolvedValue(latestSnapshot)
    const getPackageEventHead = vi
      .fn<NpmProjectionStateReader['database']['getPackageEventHead']>()
      .mockResolvedValue({
        lastEventId: secondPublished.id,
        lastEventTimestamp: secondPublished.timestamp,
        modifiedAt: secondPublished.timestamp,
        releaseCount: 2,
      })
    const getPackageReleaseHead = vi
      .fn<NpmProjectionStateReader['database']['getPackageReleaseHead']>()
      .mockResolvedValue({
        modifiedAt: second.createdAt,
        releaseCount: 2,
      })
    const reader = {
      database: {
        getPackageEventHead,
        getPackageEventState,
        getPackageReleaseHead,
        listPackageReleases,
      },
    } satisfies NpmProjectionStateReader

    const projection = await readLocalNpmPackageProjection(
      reader,
      packageId,
      new URL('https://npm.registry.test/@example.com/hello-regesta'),
      cache,
    )
    const cachedProjection = await readLocalNpmPackageProjection(
      reader,
      packageId,
      new URL('https://npm.registry.test/@example.com/hello-regesta'),
      cache,
    )

    if (!projection) {
      throw new Error('Expected retried local npm projection')
    }

    expect(projection.packument.versions).toHaveProperty('2.0.0')
    expect(projection.etag).toBe(
      `W/"regesta.npm-projection:${secondPublished.id}"`,
    )
    expect(cachedProjection).toBe(projection)
    expect(listPackageReleases).toHaveBeenCalledTimes(2)
    expect(getPackageEventState).toHaveBeenCalledTimes(2)
    expect(getPackageEventHead).toHaveBeenCalledOnce()
    expect(getPackageReleaseHead).toHaveBeenCalledTimes(3)
  })

  it('does not cache packuments when stored releases and event state disagree', async () => {
    const first = release('1.0.0', '2025-01-01T00:00:00.000Z')
    const second = release('2.0.0', '2025-01-02T00:00:00.000Z')
    const firstPublished = publish(first, 'latest', '2025-01-01T00:00:00.000Z')
    const secondPublished = publish(
      second,
      'latest',
      '2025-01-02T00:00:00.000Z',
    )
    const cache = createLocalNpmPackageProjectionCache()
    const getPackageEventState = vi
      .fn<NpmProjectionStateReader['database']['getPackageEventState']>()
      .mockResolvedValue(packageStateSnapshot(firstPublished))
    const getPackageEventHead = vi
      .fn<NpmProjectionStateReader['database']['getPackageEventHead']>()
      .mockResolvedValue({
        lastEventId: firstPublished.id,
        lastEventTimestamp: firstPublished.timestamp,
        modifiedAt: firstPublished.timestamp,
        releaseCount: 1,
      })
    const getPackageReleaseHead = vi
      .fn<NpmProjectionStateReader['database']['getPackageReleaseHead']>()
      .mockResolvedValueOnce({
        modifiedAt: first.createdAt,
        releaseCount: 2,
      })
      .mockResolvedValue({
        modifiedAt: second.createdAt,
        releaseCount: 2,
      })
    const listPackageReleases = vi
      .fn<NpmProjectionStateReader['database']['listPackageReleases']>()
      .mockResolvedValueOnce([
        {
          event: firstPublished,
          manifest: first,
        },
      ])
      .mockResolvedValue([
        {
          event: firstPublished,
          manifest: first,
        },
        {
          event: secondPublished,
          manifest: second,
        },
      ])
    const reader = {
      database: {
        getPackageEventHead,
        getPackageEventState,
        getPackageReleaseHead,
        listPackageReleases,
      },
    } satisfies NpmProjectionStateReader

    const firstProjection = await readLocalNpmPackageProjection(
      reader,
      packageId,
      new URL('https://npm.registry.test/@example.com/hello-regesta'),
      cache,
    )
    const refreshedProjection = await readLocalNpmPackageProjection(
      reader,
      packageId,
      new URL('https://npm.registry.test/@example.com/hello-regesta'),
      cache,
    )

    if (!firstProjection || !refreshedProjection) {
      throw new Error('Expected local npm projections')
    }

    expect(refreshedProjection).not.toBe(firstProjection)
    expect(refreshedProjection.packument.versions).toHaveProperty('2.0.0')
    expect(listPackageReleases).toHaveBeenCalledTimes(6)
    expect(getPackageEventState).toHaveBeenCalledTimes(6)
    expect(getPackageEventHead).not.toHaveBeenCalled()
    expect(getPackageReleaseHead).toHaveBeenCalledTimes(6)
  })

  it('does not retry direct projection-only package reads', async () => {
    const first = release('1.0.0', '2025-01-01T00:00:00.000Z')
    const firstPublished = publish(first, 'latest', '2025-01-01T00:00:00.000Z')
    const cache = createLocalNpmPackageProjectionCache()
    const listPackageReleases = vi.fn(() =>
      Promise.resolve([
        {
          event: firstPublished,
          manifest: first,
        },
      ]),
    )
    const getPackageEventState = vi.fn(() =>
      Promise.resolve({
        state: {
          ecosystem: 'npm',
          id: packageId,
          name: 'example.com/hello-regesta',
          object: 'regesta.package-state',
          releases: [],
        },
      } satisfies NpmPackageStateSnapshot),
    )
    const reader = {
      database: {
        getPackageEventHead: vi.fn(() => {
          throw new Error('uncached reads should not read package event heads')
        }),
        getPackageEventState,
        getPackageReleaseHead: vi.fn(() =>
          Promise.resolve({
            modifiedAt: first.createdAt,
            releaseCount: 1,
          }),
        ),
        listPackageReleases,
      },
    } satisfies NpmProjectionStateReader

    const projection = await readLocalNpmPackageProjection(
      reader,
      packageId,
      new URL('https://npm.registry.test/@example.com/hello-regesta'),
      cache,
    )

    if (!projection) {
      throw new Error('Expected direct projection-only npm projection')
    }

    expect(projection.packument.versions).toHaveProperty('1.0.0')
    expect(projection.etag).toBe('W/"regesta.npm-projection:empty"')
    expect(listPackageReleases).toHaveBeenCalledOnce()
    expect(getPackageEventState).toHaveBeenCalledOnce()
    expect(reader.database.getPackageReleaseHead).toHaveBeenCalledOnce()
  })
})

function packageStateSnapshot(
  event: PublishReleaseEvent,
): NpmPackageStateSnapshot {
  return packageStateSnapshotFromEvents(
    [event],
    {
      latest: event.release.version,
    },
    event,
  )
}

function packageStateSnapshotFromEvents(
  events: PublishReleaseEvent[],
  channels: Record<string, string>,
  lastEvent: RegistryEvent,
): NpmPackageStateSnapshot {
  return {
    lastEventId: lastEvent.id,
    lastEventTimestamp: lastEvent.timestamp,
    state: {
      channels,
      ecosystem: 'npm',
      id: packageId,
      name: 'example.com/hello-regesta',
      object: 'regesta.package-state',
      releases: events.map((event) => ({
        createdAt: event.timestamp,
        manifestDigest: event.release.manifestDigest,
        version: event.release.version,
      })),
    },
  }
}

function release(version: string, createdAt: string): ReleaseManifest {
  return {
    artifacts: [
      {
        digest: sha256(`install-${version}`),
        mediaType: 'application/gzip',
        role: 'install',
        size: 10,
      },
    ],
    configDigest: sha256(`config-${version}`),
    createdAt,
    ecosystem: 'npm',
    id: packageId,
    metadata: {
      description: 'Regesta hello package',
    },
    name: 'example.com/hello-regesta',
    object: 'regesta.release-manifest',
    provenance: {
      level: 'source-attached',
      verified: false,
    },
    source: {
      digest: sha256(`source-${version}`),
      mediaType: 'application/gzip',
      size: 20,
    },
    version,
  }
}

function publish(
  manifest: ReleaseManifest,
  channel: string,
  timestamp: string,
): PublishReleaseEvent {
  const payload = {
    artifactDigests: manifest.artifacts.map((artifact) => artifact.digest),
    channel,
    eventType: 'release.published',
    object: 'regesta.event',
    release: {
      id: manifest.id,
      manifestDigest: sha256(`manifest-${manifest.version}`),
      version: manifest.version,
    },
    sourceDigest: manifest.source.digest,
    timestamp,
  } satisfies PublishReleaseEventPayload

  return {
    ...payload,
    id: registryEventDigest(payload),
  }
}

function channelUpdated(
  channel: string,
  version: string,
  timestamp: string,
  previousVersion: string,
): RegistryEvent {
  const payload = {
    channel,
    eventType: 'channel.updated',
    object: 'regesta.event',
    package: packageId,
    previousVersion,
    timestamp,
    version,
  } satisfies ChannelUpdatedEventPayload

  return {
    ...payload,
    id: registryEventDigest(payload),
  }
}
