import { createMemoryRegistryAdapters } from '@regesta/adapters'
import {
  parsePackageId,
  registryEventDigest,
  sha256,
  type PublishReleaseEventPayload,
  type RegistryEvent,
  type ReleaseManifest,
} from '@regesta/protocol'
import { describe, expect, it, vi } from 'vitest'
import { createNpmRegistryRoutes } from './app.ts'
import { createNpmProjectionApp } from './projection-app.ts'
import { npmDistTagsEtag, npmVersionManifestEtag } from './projection.ts'
import type { NpmRegistryReader } from './reader.ts'
import type { PackageStateSnapshot } from '@regesta/core'

const packageId = parsePackageId('npm:example.com/hello-regesta').id

describe('createNpmProjectionApp', () => {
  it('constructs npm projection routes with upstream fallback options', async () => {
    const upstreamFetch = vi.fn<typeof fetch>((input, init) => {
      expect(input).toBe('https://registry.npmjs.org/%40upstream%2Fpkg')
      expect(init?.credentials).toBe('omit')
      expect(init?.method).toBe('GET')
      expect(init?.redirect).toBe('error')

      return Promise.resolve(
        Response.json(
          {
            'dist-tags': {
              latest: '1.0.0',
            },
            name: '@upstream/pkg',
            versions: {
              '1.0.0': {
                dist: {
                  tarball:
                    'https://registry.npmjs.org/@upstream/pkg/-/pkg-1.0.0.tgz',
                },
                name: '@upstream/pkg',
                version: '1.0.0',
              },
            },
          },
          {
            headers: {
              etag: '"upstream-packument"',
            },
          },
        ),
      )
    })
    const app = createNpmProjectionApp(createMemoryRegistryAdapters(), {
      upstreamFetch,
      upstreamTimeoutMs: 0,
    })

    const response = await app.request('/@upstream/pkg')

    expect(response.status).toBe(200)
    expect(response.headers.get('etag')).toBe('"upstream-packument"')
    await expect(response.json()).resolves.toEqual({
      'dist-tags': {
        latest: '1.0.0',
      },
      name: '@upstream/pkg',
      versions: {
        '1.0.0': {
          dist: {
            tarball: 'https://registry.npmjs.org/@upstream/pkg/-/pkg-1.0.0.tgz',
          },
          name: '@upstream/pkg',
          version: '1.0.0',
        },
      },
    })
    expect(upstreamFetch).toHaveBeenCalledTimes(1)
  })
})

describe('createNpmRegistryRoutes', () => {
  it('serves npm utility JSON routes with explicit cache headers', async () => {
    const app = createNpmRegistryRoutes(createMemoryRegistryAdapters())

    const ping = await app.request('https://npm.registry.test/-/ping')
    const pingHead = await app.request('https://npm.registry.test/-/ping', {
      method: 'HEAD',
    })
    const root = await app.request('https://npm.registry.test/')
    const rootHead = await app.request('https://npm.registry.test/', {
      method: 'HEAD',
    })

    expect(ping.status).toBe(200)
    expect(ping.headers.get('cache-control')).toBe('no-cache')
    expect(ping.headers.get('content-length')).toBe('15')
    await expect(ping.json()).resolves.toEqual({ ping: 'pong' })
    expect(pingHead.status).toBe(200)
    expect(pingHead.headers.get('cache-control')).toBe('no-cache')
    expect(pingHead.headers.get('content-length')).toBeNull()
    await expect(pingHead.text()).resolves.toBe('')
    expect(root.status).toBe(200)
    expect(root.headers.get('cache-control')).toBe('no-cache')
    expect(root.headers.get('content-length')).toBe('2')
    await expect(root.json()).resolves.toEqual({})
    expect(rootHead.status).toBe(200)
    expect(rootHead.headers.get('cache-control')).toBe('no-cache')
    expect(rootHead.headers.get('content-length')).toBeNull()
    await expect(rootHead.text()).resolves.toBe('')
  })

  it('falls back to upstream npm metadata without rewriting native fields', async () => {
    const fallbackPackageId = parsePackageId('npm:fallback.dev/pkg').id
    const upstreamTarball =
      'https://registry.npmjs.org/@fallback.dev/pkg/-/pkg-1.0.0.tgz'
    const upstreamFetch = vi.fn<typeof fetch>((input, init) => {
      expect(init?.credentials).toBe('omit')
      expect(init?.redirect).toBe('error')

      if (input === 'https://registry.npmjs.org/%40fallback.dev%2Fpkg') {
        return Promise.resolve(
          Response.json({
            'dist-tags': {
              latest: '1.0.0',
            },
            name: '@fallback.dev/pkg',
            versions: {
              '1.0.0': {
                dist: {
                  tarball: upstreamTarball,
                },
                name: '@fallback.dev/pkg',
                version: '1.0.0',
              },
            },
          }),
        )
      }

      if (input === 'https://registry.npmjs.org/%40fallback.dev%2Fpkg/latest') {
        return Promise.resolve(
          Response.json({
            dist: {
              tarball: upstreamTarball,
            },
            name: '@fallback.dev/pkg',
            version: '1.0.0',
          }),
        )
      }

      if (
        input ===
        'https://registry.npmjs.org/-/package/%40fallback.dev%2Fpkg/dist-tags'
      ) {
        return Promise.resolve(
          Response.json({
            latest: '1.0.0',
          }),
        )
      }

      throw new Error(`Unexpected upstream npm metadata request: ${input}`)
    })
    const reader = missingNpmPackageReader()
    const app = createNpmRegistryRoutes(reader, {
      upstreamFetch,
      upstreamTimeoutMs: 0,
    })

    const packument = await app.request(
      'https://npm.registry.test/@fallback.dev/pkg',
    )
    const packumentHead = await app.request(
      'https://npm.registry.test/@fallback.dev/pkg',
      {
        method: 'HEAD',
      },
    )
    const version = await app.request(
      'https://npm.registry.test/@fallback.dev/pkg/latest',
    )
    const versionHead = await app.request(
      'https://npm.registry.test/@fallback.dev/pkg/latest',
      {
        method: 'HEAD',
      },
    )
    const distTags = await app.request(
      'https://npm.registry.test/-/package/@fallback.dev/pkg/dist-tags',
    )
    const distTagsHead = await app.request(
      'https://npm.registry.test/-/package/@fallback.dev/pkg/dist-tags',
      {
        method: 'HEAD',
      },
    )

    expect(packument.status).toBe(200)
    await expect(packument.json()).resolves.toMatchObject({
      name: '@fallback.dev/pkg',
      versions: {
        '1.0.0': {
          dist: {
            tarball: upstreamTarball,
          },
        },
      },
    })
    expect(packumentHead.status).toBe(200)
    await expect(packumentHead.text()).resolves.toBe('')
    expect(version.status).toBe(200)
    await expect(version.json()).resolves.toEqual({
      dist: {
        tarball: upstreamTarball,
      },
      name: '@fallback.dev/pkg',
      version: '1.0.0',
    })
    expect(versionHead.status).toBe(200)
    await expect(versionHead.text()).resolves.toBe('')
    expect(distTags.status).toBe(200)
    await expect(distTags.json()).resolves.toEqual({
      latest: '1.0.0',
    })
    expect(distTagsHead.status).toBe(200)
    await expect(distTagsHead.text()).resolves.toBe('')

    expect(reader.database.getPackageChannelVersion).not.toHaveBeenCalled()
    expect(reader.database.getPackageChannels).not.toHaveBeenCalled()
    expect(reader.database.getRelease).not.toHaveBeenCalled()
    expect(reader.database.getPackageReleaseHead).toHaveBeenCalledTimes(6)
    expect(reader.database.getPackageReleaseHead).toHaveBeenCalledWith(
      fallbackPackageId,
    )
    expect(reader.database.listPackageReleases).not.toHaveBeenCalled()
    expect(reader.database.getPackageEventState).not.toHaveBeenCalled()
    expect(upstreamFetch).toHaveBeenCalledTimes(6)
    expect(
      upstreamFetch.mock.calls.map(([input, init]) => ({
        method: init?.method,
        url: String(input),
      })),
    ).toEqual([
      {
        method: 'GET',
        url: 'https://registry.npmjs.org/%40fallback.dev%2Fpkg',
      },
      {
        method: 'HEAD',
        url: 'https://registry.npmjs.org/%40fallback.dev%2Fpkg',
      },
      {
        method: 'GET',
        url: 'https://registry.npmjs.org/%40fallback.dev%2Fpkg/latest',
      },
      {
        method: 'HEAD',
        url: 'https://registry.npmjs.org/%40fallback.dev%2Fpkg/latest',
      },
      {
        method: 'GET',
        url: 'https://registry.npmjs.org/-/package/%40fallback.dev%2Fpkg/dist-tags',
      },
      {
        method: 'HEAD',
        url: 'https://registry.npmjs.org/-/package/%40fallback.dev%2Fpkg/dist-tags',
      },
    ])
  })

  it('can disable upstream npm fallback for missing projection packages', async () => {
    const upstreamFetch = vi.fn<typeof fetch>(() => {
      throw new Error('disabled npm fallback must not fetch upstream')
    })
    const app = createNpmProjectionApp(createMemoryRegistryAdapters(), {
      upstreamFallback: false,
      upstreamFetch,
    })

    const packument = await app.request('https://npm.registry.test/not-local')
    const packumentHead = await app.request(
      'https://npm.registry.test/not-local',
      {
        method: 'HEAD',
      },
    )
    const manifest = await app.request(
      'https://npm.registry.test/not-local/latest',
    )
    const distTags = await app.request(
      'https://npm.registry.test/-/package/not-local/dist-tags',
    )
    const tarball = await app.request(
      'https://npm.registry.test/not-local/-/not-local-1.0.0.tgz',
    )

    for (const response of [packument, manifest, distTags, tarball]) {
      expect(response.status).toBe(404)
      expect(response.headers.get('cache-control')).toBe('no-cache')
      await expect(response.json()).resolves.toMatchObject({
        code: 'package_not_found',
        error: 'Package not found',
        message: 'Package not found',
      })
    }
    expect(packumentHead.status).toBe(404)
    expect(packumentHead.headers.get('cache-control')).toBe('no-cache')
    await expect(packumentHead.text()).resolves.toBe('')
    expect(tarball.headers.get('location')).toBeNull()
    expect(upstreamFetch).not.toHaveBeenCalled()
  })

  it('serves local npm packuments from the narrow registry reader', async () => {
    const manifest = releaseManifest()
    const event = publishEvent(manifest)
    const upstreamFetch = vi.fn<typeof fetch>(() => {
      throw new Error('upstream fallback should not be used for local packages')
    })
    const reader = {
      database: {
        getPackageChannelVersion: vi.fn(() => {
          throw new Error('packuments should not read package channel versions')
        }),
        getPackageChannels: vi.fn(() =>
          Promise.resolve({
            latest: '1.0.0',
          }),
        ),
        getPackageEventState: vi.fn(() =>
          Promise.resolve(packageStateSnapshot(event)),
        ),
        getPackageEventHead: vi.fn(() =>
          Promise.resolve({
            lastEventId: event.id,
            lastEventTimestamp: event.timestamp,
            modifiedAt: event.timestamp,
            releaseCount: 1,
          }),
        ),
        getPackageReleaseHead: vi.fn(() =>
          Promise.resolve({
            modifiedAt: manifest.createdAt,
            releaseCount: 1,
          }),
        ),
        getRelease: vi.fn(() => Promise.resolve(undefined)),
        listPackageReleases: vi.fn(() =>
          Promise.resolve([
            {
              event,
              manifest,
            },
          ]),
        ),
      },
    } satisfies NpmRegistryReader
    const app = createNpmRegistryRoutes(reader, {
      upstreamFetch,
      upstreamTimeoutMs: 0,
    })

    const response = await app.request(
      'https://npm.registry.test/@example.com/hello-regesta',
    )
    const conditionalSince = await app.request(
      'https://npm.registry.test/@example.com/hello-regesta',
      {
        headers: {
          'if-modified-since': 'Wed, 01 Jan 2025 00:00:00 GMT',
        },
      },
    )
    const nonMatchingEtagTakesPrecedence = await app.request(
      'https://npm.registry.test/@example.com/hello-regesta',
      {
        headers: {
          'if-modified-since': 'Thu, 01 Jan 2037 00:00:00 GMT',
          'if-none-match': '"not-current"',
        },
      },
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('etag')).toBe(
      `W/"regesta.npm-projection:${event.id}"`,
    )
    expect(response.headers.get('last-modified')).toBe(
      'Wed, 01 Jan 2025 00:00:00 GMT',
    )
    await expect(response.json()).resolves.toMatchObject({
      'dist-tags': {
        latest: '1.0.0',
      },
      name: '@example.com/hello-regesta',
      versions: {
        '1.0.0': {
          dist: {
            tarball:
              'https://npm.registry.test/@example.com/hello-regesta/-/hello-regesta-1.0.0.tgz',
          },
          name: '@example.com/hello-regesta',
          version: '1.0.0',
        },
      },
    })
    expect(conditionalSince.status).toBe(304)
    expect(conditionalSince.headers.get('etag')).toBe(
      `W/"regesta.npm-projection:${event.id}"`,
    )
    expect(conditionalSince.headers.get('last-modified')).toBe(
      'Wed, 01 Jan 2025 00:00:00 GMT',
    )
    expect(conditionalSince.headers.get('content-length')).toBeNull()
    expect(await conditionalSince.text()).toBe('')
    expect(nonMatchingEtagTakesPrecedence.status).toBe(200)
    await expect(nonMatchingEtagTakesPrecedence.json()).resolves.toMatchObject({
      name: '@example.com/hello-regesta',
    })
    expect(reader.database.listPackageReleases).toHaveBeenCalledWith(
      packageId,
      { limit: 999 },
    )
    expect(reader.database.getPackageEventState).toHaveBeenCalledWith(packageId)
    expect(upstreamFetch).not.toHaveBeenCalled()
  })

  it('serves conditional local npm packument hits from package event heads', async () => {
    const manifest = releaseManifest()
    const event = publishEvent(manifest)
    const upstreamFetch = vi.fn<typeof fetch>(() => {
      throw new Error('upstream fallback should not be used for local packages')
    })
    const reader = {
      database: {
        getPackageChannelVersion: vi.fn(() => {
          throw new Error(
            'conditional packuments should not read channel versions',
          )
        }),
        getPackageChannels: vi.fn(() => {
          throw new Error('conditional packuments should not read channels')
        }),
        getPackageEventHead: vi.fn(() =>
          Promise.resolve({
            lastEventId: event.id,
            lastEventTimestamp: event.timestamp,
            modifiedAt: event.timestamp,
            releaseCount: 1,
          }),
        ),
        getPackageReleaseHead: vi.fn(() =>
          Promise.resolve({
            modifiedAt: manifest.createdAt,
            releaseCount: 1,
          }),
        ),
        getPackageEventState: vi.fn(() => {
          throw new Error(
            'conditional packuments should not read package event state',
          )
        }),
        getRelease: vi.fn(() => {
          throw new Error('conditional packuments should not read releases')
        }),
        listPackageReleases: vi.fn(() => {
          throw new Error('conditional packuments should not list releases')
        }),
      },
    } satisfies NpmRegistryReader
    const app = createNpmRegistryRoutes(reader, {
      upstreamFetch,
      upstreamTimeoutMs: 0,
    })

    const etagResponse = await app.request(
      'https://npm.registry.test/@example.com/hello-regesta',
      {
        headers: {
          'if-none-match': `W/"regesta.npm-projection:${event.id}"`,
        },
      },
    )
    const modifiedSinceResponse = await app.request(
      'https://npm.registry.test/@example.com/hello-regesta',
      {
        headers: {
          'if-modified-since': 'Wed, 01 Jan 2025 00:00:00 GMT',
        },
      },
    )

    expect(etagResponse.status).toBe(304)
    expect(etagResponse.headers.get('etag')).toBe(
      `W/"regesta.npm-projection:${event.id}"`,
    )
    expect(etagResponse.headers.get('content-type')).toBe(
      'application/json; charset=UTF-8',
    )
    expect(etagResponse.headers.get('last-modified')).toBe(
      'Wed, 01 Jan 2025 00:00:00 GMT',
    )
    expect(await etagResponse.text()).toBe('')
    expect(modifiedSinceResponse.status).toBe(304)
    expect(modifiedSinceResponse.headers.get('etag')).toBe(
      `W/"regesta.npm-projection:${event.id}"`,
    )
    expect(modifiedSinceResponse.headers.get('content-type')).toBe(
      'application/json; charset=UTF-8',
    )
    expect(modifiedSinceResponse.headers.get('last-modified')).toBe(
      'Wed, 01 Jan 2025 00:00:00 GMT',
    )
    expect(await modifiedSinceResponse.text()).toBe('')
    expect(reader.database.getPackageEventHead).toHaveBeenCalledTimes(2)
    expect(reader.database.getPackageReleaseHead).toHaveBeenCalledTimes(2)
    expect(upstreamFetch).not.toHaveBeenCalled()
  })

  it('serves local npm packument HEAD requests from package heads', async () => {
    const manifest = releaseManifest()
    const event = publishEvent(manifest)
    const upstreamFetch = vi.fn<typeof fetch>(() => {
      throw new Error('upstream fallback should not be used for local packages')
    })
    const reader = {
      database: {
        getPackageChannelVersion: vi.fn(() => {
          throw new Error('packument HEAD should not read channel versions')
        }),
        getPackageChannels: vi.fn(() => {
          throw new Error('packument HEAD should not read channels')
        }),
        getPackageEventHead: vi.fn(() =>
          Promise.resolve({
            lastEventId: event.id,
            lastEventTimestamp: event.timestamp,
            modifiedAt: event.timestamp,
            releaseCount: 1,
          }),
        ),
        getPackageReleaseHead: vi.fn(() =>
          Promise.resolve({
            modifiedAt: manifest.createdAt,
            releaseCount: 1,
          }),
        ),
        getPackageEventState: vi.fn(() => {
          throw new Error('packument HEAD should not read package event state')
        }),
        getRelease: vi.fn(() => {
          throw new Error('packument HEAD should not read releases')
        }),
        listPackageReleases: vi.fn(() => {
          throw new Error('packument HEAD should not list releases')
        }),
      },
    } satisfies NpmRegistryReader
    const app = createNpmRegistryRoutes(reader, {
      upstreamFetch,
      upstreamTimeoutMs: 0,
    })

    const response = await app.request(
      'https://npm.registry.test/@example.com/hello-regesta',
      {
        method: 'HEAD',
      },
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-cache')
    expect(response.headers.get('content-type')).toBe(
      'application/json; charset=UTF-8',
    )
    expect(response.headers.get('etag')).toBe(
      `W/"regesta.npm-projection:${event.id}"`,
    )
    expect(response.headers.get('last-modified')).toBe(
      'Wed, 01 Jan 2025 00:00:00 GMT',
    )
    expect(response.headers.get('content-length')).toBeNull()
    expect(await response.text()).toBe('')
    expect(reader.database.getPackageReleaseHead).toHaveBeenCalledOnce()
    expect(reader.database.getPackageReleaseHead).toHaveBeenCalledWith(
      packageId,
    )
    expect(reader.database.getPackageEventHead).toHaveBeenCalledOnce()
    expect(reader.database.getPackageEventHead).toHaveBeenCalledWith(packageId)
    expect(upstreamFetch).not.toHaveBeenCalled()
  })

  it('serves local npm dist-tags from indexed channel state', async () => {
    const upstreamFetch = vi.fn<typeof fetch>(() => {
      throw new Error('upstream fallback should not be used for local packages')
    })
    const reader = {
      database: {
        getPackageChannelVersion: vi.fn(() => {
          throw new Error('dist-tags should not read channel versions')
        }),
        getPackageChannels: vi.fn(() =>
          Promise.resolve({
            latest: '1.0.0',
            next: '2.0.0',
          }),
        ),
        getPackageEventState: vi.fn(() =>
          Promise.reject(
            new Error('dist-tags should not read package event state'),
          ),
        ),
        getPackageEventHead: vi.fn(() => {
          throw new Error('dist-tags should not read package event head')
        }),
        getPackageReleaseHead: vi.fn(() =>
          Promise.resolve({
            releaseCount: 1,
          }),
        ),
        getRelease: vi.fn(() => Promise.resolve(undefined)),
        listPackageReleases: vi.fn(() => Promise.resolve([])),
      },
    } satisfies NpmRegistryReader
    const app = createNpmRegistryRoutes(reader, {
      upstreamFetch,
      upstreamTimeoutMs: 0,
    })

    const response = await app.request(
      'https://npm.registry.test/-/package/@example.com/hello-regesta/dist-tags',
    )
    const head = await app.request(
      'https://npm.registry.test/-/package/@example.com/hello-regesta/dist-tags',
      {
        method: 'HEAD',
      },
    )
    const etag = npmDistTagsEtag({
      latest: '1.0.0',
      next: '2.0.0',
    })

    expect(response.status).toBe(200)
    expect(response.headers.get('etag')).toBe(etag)
    await expect(response.json()).resolves.toEqual({
      latest: '1.0.0',
      next: '2.0.0',
    })
    expect(head.status).toBe(200)
    expect(head.headers.get('cache-control')).toBe('no-cache')
    expect(head.headers.get('content-type')).toBe(
      'application/json; charset=UTF-8',
    )
    expect(head.headers.get('content-length')).toBeNull()
    expect(head.headers.get('etag')).toBe(etag)
    expect(await head.text()).toBe('')
    expect(reader.database.getPackageChannels).toHaveBeenCalledTimes(2)
    expect(reader.database.getPackageChannels).toHaveBeenCalledWith(packageId)
    expect(reader.database.getPackageReleaseHead).toHaveBeenCalledWith(
      packageId,
    )
    expect(reader.database.getPackageEventState).not.toHaveBeenCalled()
    expect(reader.database.listPackageReleases).not.toHaveBeenCalled()
    expect(upstreamFetch).not.toHaveBeenCalled()
  })

  it('serves local npm tagged manifests from indexed channel and release state', async () => {
    const manifest = releaseManifest()
    const event = publishEvent(manifest)
    const upstreamFetch = vi.fn<typeof fetch>(() => {
      throw new Error('upstream fallback should not be used for local packages')
    })
    const reader = {
      database: {
        getPackageChannelVersion: vi.fn(() => Promise.resolve('1.0.0')),
        getPackageChannels: vi.fn(() =>
          Promise.resolve({
            latest: '1.0.0',
          }),
        ),
        getPackageEventState: vi.fn(() =>
          Promise.reject(
            new Error('tagged manifests should not read package event state'),
          ),
        ),
        getPackageEventHead: vi.fn(() => {
          throw new Error('tagged manifests should not read package event head')
        }),
        getPackageReleaseHead: vi.fn(() =>
          Promise.resolve({
            releaseCount: 1,
          }),
        ),
        getRelease: vi.fn(() =>
          Promise.resolve({
            event,
            manifest,
          }),
        ),
        listPackageReleases: vi.fn(() => Promise.resolve([])),
      },
    } satisfies NpmRegistryReader
    const app = createNpmRegistryRoutes(reader, {
      upstreamFetch,
      upstreamTimeoutMs: 0,
    })

    const response = await app.request(
      'https://npm.registry.test/@example.com/hello-regesta/latest',
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-cache')
    expect(response.headers.get('last-modified')).toBeNull()
    await expect(response.json()).resolves.toMatchObject({
      dist: {
        tarball:
          'https://npm.registry.test/@example.com/hello-regesta/-/hello-regesta-1.0.0.tgz',
      },
      name: '@example.com/hello-regesta',
      version: '1.0.0',
    })
    expect(reader.database.getPackageChannelVersion).toHaveBeenCalledWith(
      packageId,
      'latest',
    )
    expect(reader.database.getPackageChannels).not.toHaveBeenCalled()
    expect(reader.database.getRelease).toHaveBeenCalledWith(packageId, '1.0.0')
    expect(reader.database.getPackageReleaseHead).toHaveBeenCalledWith(
      packageId,
    )
    expect(reader.database.getPackageEventState).not.toHaveBeenCalled()
    expect(reader.database.listPackageReleases).not.toHaveBeenCalled()
    expect(upstreamFetch).not.toHaveBeenCalled()
  })

  it('serves local npm version HEAD errors without JSON bodies', async () => {
    const upstreamFetch = vi.fn<typeof fetch>(() => {
      throw new Error('local package version errors should not use upstream')
    })
    const reader = {
      database: {
        getPackageChannelVersion: vi.fn(() => Promise.resolve(undefined)),
        getPackageChannels: vi.fn(() => Promise.resolve({})),
        getPackageEventHead: vi.fn(() => {
          throw new Error('version errors should not read package event head')
        }),
        getPackageEventState: vi.fn(() =>
          Promise.reject(
            new Error('version errors should not read package event state'),
          ),
        ),
        getPackageReleaseHead: vi.fn(() =>
          Promise.resolve({
            releaseCount: 1,
          }),
        ),
        getRelease: vi.fn(() => Promise.resolve(undefined)),
        listPackageReleases: vi.fn(() => Promise.resolve([])),
      },
    } satisfies NpmRegistryReader
    const app = createNpmRegistryRoutes(reader, {
      upstreamFetch,
      upstreamTimeoutMs: 0,
    })

    const response = await app.request(
      'https://npm.registry.test/@example.com/hello-regesta/9.9.9',
      {
        method: 'HEAD',
      },
    )

    expect(response.status).toBe(404)
    expect(response.headers.get('content-type')).toBe(
      'application/json; charset=UTF-8',
    )
    expect(response.headers.get('content-length')).toBeNull()
    await expect(response.text()).resolves.toBe('')
    expect(reader.database.getPackageReleaseHead).toHaveBeenCalledWith(
      packageId,
    )
    expect(reader.database.getRelease).toHaveBeenCalledWith(packageId, '9.9.9')
    expect(reader.database.getPackageEventState).not.toHaveBeenCalled()
    expect(reader.database.listPackageReleases).not.toHaveBeenCalled()
    expect(upstreamFetch).not.toHaveBeenCalled()
  })

  it('serves local npm direct version manifests as immutable timestamped metadata', async () => {
    const manifest = releaseManifest()
    const event = publishEvent(manifest)
    const upstreamFetch = vi.fn<typeof fetch>(() => {
      throw new Error('upstream fallback should not be used for local packages')
    })
    const reader = {
      database: {
        getPackageChannelVersion: vi.fn(() => Promise.resolve(undefined)),
        getPackageChannels: vi.fn(() =>
          Promise.resolve({
            latest: '1.0.0',
          }),
        ),
        getPackageEventState: vi.fn(() =>
          Promise.reject(
            new Error('direct manifests should not read package event state'),
          ),
        ),
        getPackageEventHead: vi.fn(() => {
          throw new Error('direct manifests should not read package event head')
        }),
        getPackageReleaseHead: vi.fn(() =>
          Promise.resolve({
            releaseCount: 1,
          }),
        ),
        getRelease: vi.fn(() =>
          Promise.resolve({
            event,
            manifest,
          }),
        ),
        listPackageReleases: vi.fn(() => Promise.resolve([])),
      },
    } satisfies NpmRegistryReader
    const app = createNpmRegistryRoutes(reader, {
      upstreamFetch,
      upstreamTimeoutMs: 0,
    })

    const response = await app.request(
      'https://npm.registry.test/@example.com/hello-regesta/1.0.0',
    )
    const conditional = await app.request(
      'https://npm.registry.test/@example.com/hello-regesta/1.0.0',
      {
        headers: {
          'if-none-match': npmVersionManifestEtag(event.id),
        },
      },
    )
    const conditionalSince = await app.request(
      'https://npm.registry.test/@example.com/hello-regesta/1.0.0',
      {
        headers: {
          'if-modified-since': 'Wed, 01 Jan 2025 00:00:00 GMT',
        },
      },
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe(
      'public, max-age=31536000, immutable',
    )
    expect(response.headers.get('last-modified')).toBe(
      'Wed, 01 Jan 2025 00:00:00 GMT',
    )
    await expect(response.json()).resolves.toMatchObject({
      name: '@example.com/hello-regesta',
      version: '1.0.0',
    })
    expect(conditional.status).toBe(304)
    expect(conditional.headers.get('cache-control')).toBe(
      'public, max-age=31536000, immutable',
    )
    expect(conditional.headers.get('content-type')).toBe(
      'application/json; charset=UTF-8',
    )
    expect(conditional.headers.get('last-modified')).toBe(
      'Wed, 01 Jan 2025 00:00:00 GMT',
    )
    expect(await conditional.text()).toBe('')
    expect(conditionalSince.status).toBe(304)
    expect(conditionalSince.headers.get('cache-control')).toBe(
      'public, max-age=31536000, immutable',
    )
    expect(conditionalSince.headers.get('content-type')).toBe(
      'application/json; charset=UTF-8',
    )
    expect(conditionalSince.headers.get('last-modified')).toBe(
      'Wed, 01 Jan 2025 00:00:00 GMT',
    )
    expect(await conditionalSince.text()).toBe('')
    expect(reader.database.getPackageChannelVersion).toHaveBeenCalledWith(
      packageId,
      '1.0.0',
    )
    expect(reader.database.getPackageChannels).not.toHaveBeenCalled()
    expect(reader.database.getRelease).toHaveBeenCalledWith(packageId, '1.0.0')
    expect(reader.database.getPackageReleaseHead).toHaveBeenCalledTimes(3)
    expect(reader.database.getPackageReleaseHead).toHaveBeenCalledWith(
      packageId,
    )
    expect(reader.database.getPackageEventState).not.toHaveBeenCalled()
    expect(reader.database.listPackageReleases).not.toHaveBeenCalled()
    expect(upstreamFetch).not.toHaveBeenCalled()
  })

  it('serves local npm version manifest HEAD without materializing body projection', async () => {
    const manifest = {
      ...releaseManifest(),
      artifacts: [],
    }
    const event = publishEvent(manifest)
    const upstreamFetch = vi.fn<typeof fetch>(() => {
      throw new Error('upstream fallback should not be used for local packages')
    })
    const reader = {
      database: {
        getPackageChannelVersion: vi.fn(() => Promise.resolve(undefined)),
        getPackageChannels: vi.fn(() => {
          throw new Error('version manifest HEAD should not read channels')
        }),
        getPackageEventState: vi.fn(() => {
          throw new Error(
            'version manifest HEAD should not read package event state',
          )
        }),
        getPackageEventHead: vi.fn(() => {
          throw new Error(
            'version manifest HEAD should not read package event head',
          )
        }),
        getPackageReleaseHead: vi.fn(() =>
          Promise.resolve({
            releaseCount: 1,
          }),
        ),
        getRelease: vi.fn(() =>
          Promise.resolve({
            event,
            manifest,
          }),
        ),
        listPackageReleases: vi.fn(() => {
          throw new Error('version manifest HEAD should not list releases')
        }),
      },
    } satisfies NpmRegistryReader
    const app = createNpmRegistryRoutes(reader, {
      upstreamFetch,
      upstreamTimeoutMs: 0,
    })

    const response = await app.request(
      'https://npm.registry.test/@example.com/hello-regesta/1.0.0',
      {
        method: 'HEAD',
      },
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe(
      'public, max-age=31536000, immutable',
    )
    expect(response.headers.get('content-type')).toBe(
      'application/json; charset=UTF-8',
    )
    expect(response.headers.get('content-length')).toBeNull()
    expect(response.headers.get('etag')).toBe(npmVersionManifestEtag(event.id))
    expect(response.headers.get('last-modified')).toBe(
      'Wed, 01 Jan 2025 00:00:00 GMT',
    )
    expect(await response.text()).toBe('')
    expect(reader.database.getPackageChannelVersion).toHaveBeenCalledWith(
      packageId,
      '1.0.0',
    )
    expect(reader.database.getRelease).toHaveBeenCalledWith(packageId, '1.0.0')
    expect(reader.database.getPackageReleaseHead).toHaveBeenCalledWith(
      packageId,
    )
    expect(upstreamFetch).not.toHaveBeenCalled()
  })

  it('returns 404 for missing versions when indexed local package exists', async () => {
    const upstreamFetch = vi.fn<typeof fetch>(() => {
      throw new Error('upstream fallback should not be used for local packages')
    })
    const reader = {
      database: {
        getPackageChannelVersion: vi.fn(() => Promise.resolve(undefined)),
        getPackageChannels: vi.fn(() => Promise.resolve({})),
        getPackageEventState: vi.fn(() =>
          Promise.reject(
            new Error('missing versions should not read package event state'),
          ),
        ),
        getPackageEventHead: vi.fn(() => {
          throw new Error('missing versions should not read package event head')
        }),
        getPackageReleaseHead: vi.fn(() =>
          Promise.resolve({
            releaseCount: 1,
          }),
        ),
        getRelease: vi.fn(() => Promise.resolve(undefined)),
        listPackageReleases: vi.fn(() => Promise.resolve([])),
      },
    } satisfies NpmRegistryReader
    const app = createNpmRegistryRoutes(reader, {
      upstreamFetch,
      upstreamTimeoutMs: 0,
    })

    const response = await app.request(
      'https://npm.registry.test/@example.com/hello-regesta/missing',
    )

    expect(response.status).toBe(404)
    expect(reader.database.getPackageChannelVersion).toHaveBeenCalledWith(
      packageId,
      'missing',
    )
    expect(reader.database.getPackageChannels).not.toHaveBeenCalled()
    expect(reader.database.getRelease).toHaveBeenCalledWith(
      packageId,
      'missing',
    )
    expect(reader.database.getPackageReleaseHead).toHaveBeenCalledWith(
      packageId,
    )
    expect(reader.database.getPackageEventState).not.toHaveBeenCalled()
    expect(reader.database.listPackageReleases).not.toHaveBeenCalled()
    expect(upstreamFetch).not.toHaveBeenCalled()
  })

  it('redirects direct npm tarball routes without fetching bytes or listing release state', async () => {
    const upstreamFetch = vi.fn<typeof fetch>(() => {
      throw new Error('tarball routes must not proxy upstream bytes')
    })
    const reader = storageFreeNpmTarballReader()
    const app = createNpmRegistryRoutes(reader, {
      upstreamFetch,
      upstreamTimeoutMs: 0,
    })

    const unscoped = await app.request(
      'https://npm.registry.test/tinyexec/-/tinyexec-0.0.1.tgz',
    )
    const scoped = await app.request(
      'https://npm.registry.test/@example.com/hello-regesta/-/hello-regesta-1.0.0.tgz',
    )
    const scopedHead = await app.request(
      'https://npm.registry.test/@example.com/hello-regesta/-/hello-regesta-1.0.0.tgz',
      {
        method: 'HEAD',
      },
    )

    expect(unscoped.status).toBe(302)
    expect(unscoped.headers.get('cache-control')).toBe('no-cache')
    expect(unscoped.headers.get('location')).toBe(
      'https://registry.npmjs.org/tinyexec/-/tinyexec-0.0.1.tgz',
    )
    await expect(unscoped.text()).resolves.toBe('')

    expect(scoped.status).toBe(302)
    expect(scoped.headers.get('cache-control')).toBe('no-cache')
    expect(scoped.headers.get('location')).toBe(
      `https://registry.test/objects/${sha256('install-artifact')}`,
    )
    await expect(scoped.text()).resolves.toBe('')

    expect(scopedHead.status).toBe(302)
    expect(scopedHead.headers.get('location')).toBe(
      `https://registry.test/objects/${sha256('install-artifact')}`,
    )
    await expect(scopedHead.text()).resolves.toBe('')

    expect(reader.database.getPackageChannels).not.toHaveBeenCalled()
    expect(reader.database.getPackageEventState).not.toHaveBeenCalled()
    expect(reader.database.getRelease).toHaveBeenCalledTimes(2)
    expect(reader.database.getRelease).toHaveBeenCalledWith(packageId, '1.0.0')
    expect(reader.database.listPackageReleases).not.toHaveBeenCalled()
    expect(upstreamFetch).not.toHaveBeenCalled()
  })
})

function releaseManifest(): ReleaseManifest {
  return {
    artifacts: [
      {
        digest: sha256('install-artifact'),
        mediaType: 'application/gzip',
        role: 'install',
        size: 16,
      },
    ],
    configDigest: sha256('config'),
    createdAt: '2025-01-01T00:00:00.000Z',
    ecosystem: 'npm',
    id: packageId,
    name: 'example.com/hello-regesta',
    object: 'regesta.release-manifest',
    provenance: {
      level: 'source-attached',
      verified: false,
    },
    source: {
      digest: sha256('source'),
      mediaType: 'application/gzip',
      size: 32,
    },
    version: '1.0.0',
  }
}

function publishEvent(manifest: ReleaseManifest): RegistryEvent {
  const payload = {
    artifactDigests: manifest.artifacts.map((artifact) => artifact.digest),
    channel: 'latest',
    eventType: 'release.published',
    object: 'regesta.event',
    release: {
      id: manifest.id,
      manifestDigest: sha256('manifest'),
      version: manifest.version,
    },
    sourceDigest: manifest.source.digest,
    timestamp: manifest.createdAt,
  } satisfies PublishReleaseEventPayload

  return {
    ...payload,
    id: registryEventDigest(payload),
  }
}

function packageStateSnapshot(event: RegistryEvent): PackageStateSnapshot {
  if (event.eventType !== 'release.published') {
    throw new Error('Expected publish event')
  }

  return {
    lastEventId: event.id,
    lastEventTimestamp: event.timestamp,
    state: {
      channels: {
        latest: event.release.version,
      },
      ecosystem: 'npm',
      id: event.release.id,
      name: 'example.com/hello-regesta',
      object: 'regesta.package-state',
      releases: [
        {
          createdAt: event.timestamp,
          manifestDigest: event.release.manifestDigest,
          version: event.release.version,
        },
      ],
    },
  }
}

function missingNpmPackageReader() {
  return {
    database: {
      getPackageChannelVersion: vi.fn(() => Promise.resolve(undefined)),
      getPackageChannels: vi.fn(() => Promise.resolve({})),
      getPackageEventHead: vi.fn(() =>
        Promise.reject(
          new Error('fallback metadata should not read package event head'),
        ),
      ),
      getPackageReleaseHead: vi.fn(() =>
        Promise.resolve({
          releaseCount: 0,
        }),
      ),
      getPackageEventState: vi.fn(() =>
        Promise.reject(
          new Error('fallback metadata should not read package event state'),
        ),
      ),
      getRelease: vi.fn(() => Promise.resolve(undefined)),
      listPackageReleases: vi.fn(() => Promise.resolve([])),
    },
  } satisfies NpmRegistryReader
}

function storageFreeNpmTarballReader() {
  const manifest = releaseManifest()
  const event = publishEvent(manifest)

  return {
    database: {
      getPackageChannelVersion: vi.fn(() => {
        throw new Error('tarball routes must not read channel versions')
      }),
      getPackageChannels: vi.fn(() => {
        throw new Error('tarball routes must not read channels')
      }),
      getPackageEventHead: vi.fn(() => {
        throw new Error('tarball routes must not read package event head')
      }),
      getPackageReleaseHead: vi.fn(() => {
        throw new Error('tarball routes must not read package release head')
      }),
      getPackageEventState: vi.fn(() => {
        throw new Error('tarball routes must not read package event state')
      }),
      getRelease: vi.fn((id, version) => {
        if (id === packageId && version === manifest.version) {
          return Promise.resolve({ event, manifest })
        }

        return Promise.resolve(undefined)
      }),
      listPackageReleases: vi.fn(() => {
        throw new Error('tarball routes must not list releases')
      }),
    },
  } satisfies NpmRegistryReader
}
