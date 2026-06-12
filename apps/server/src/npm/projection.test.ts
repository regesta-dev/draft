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

  it('builds version manifest etags from release event ids', () => {
    expect(npmVersionManifestEtag(sha256('release-event'))).toBe(
      `W/"regesta.npm-version:${sha256('release-event')}"`,
    )
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
    const reader = {
      database: {
        getPackageEventHead,
        getPackageEventState,
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
      .fn<
        NonNullable<NpmProjectionStateReader['database']['getPackageEventHead']>
      >()
      .mockResolvedValue({
        lastEventId: secondPublished.id,
        lastEventTimestamp: secondPublished.timestamp,
        modifiedAt: secondPublished.timestamp,
        releaseCount: 2,
      })
    const reader = {
      database: {
        getPackageEventHead,
        getPackageEventState,
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
