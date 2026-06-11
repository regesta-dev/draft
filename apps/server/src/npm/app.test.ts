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
import { npmVersionManifestEtag } from './projection.ts'
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
    expect(pingHead.headers.get('content-length')).toBe('15')
    await expect(pingHead.text()).resolves.toBe('')
    expect(root.status).toBe(200)
    expect(root.headers.get('cache-control')).toBe('no-cache')
    expect(root.headers.get('content-length')).toBe('2')
    await expect(root.json()).resolves.toEqual({})
    expect(rootHead.status).toBe(200)
    expect(rootHead.headers.get('cache-control')).toBe('no-cache')
    expect(rootHead.headers.get('content-length')).toBe('2')
    await expect(rootHead.text()).resolves.toBe('')
  })

  it('serves local npm packuments from the narrow registry reader', async () => {
    const manifest = releaseManifest()
    const event = publishEvent(manifest)
    const upstreamFetch = vi.fn<typeof fetch>(() => {
      throw new Error('upstream fallback should not be used for local packages')
    })
    const reader = {
      database: {
        getPackageChannels: vi.fn(() =>
          Promise.resolve({
            latest: '1.0.0',
          }),
        ),
        getPackageEventState: vi.fn(() =>
          Promise.resolve(packageStateSnapshot(event)),
        ),
        getRelease: vi.fn(() => Promise.resolve(undefined)),
        hasPackage: vi.fn(() => Promise.resolve(true)),
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
            tarball: `https://registry.test/objects/${installArtifactDigest(manifest)}`,
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
    expect(reader.database.listPackageReleases).toHaveBeenCalledWith(packageId)
    expect(reader.database.getPackageEventState).toHaveBeenCalledWith(packageId)
    expect(upstreamFetch).not.toHaveBeenCalled()
  })

  it('serves local npm dist-tags from indexed channel state', async () => {
    const upstreamFetch = vi.fn<typeof fetch>(() => {
      throw new Error('upstream fallback should not be used for local packages')
    })
    const reader = {
      database: {
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
        getRelease: vi.fn(() => Promise.resolve(undefined)),
        hasPackage: vi.fn(() => Promise.resolve(true)),
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

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      latest: '1.0.0',
      next: '2.0.0',
    })
    expect(reader.database.getPackageChannels).toHaveBeenCalledWith(packageId)
    expect(reader.database.hasPackage).not.toHaveBeenCalled()
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
        getRelease: vi.fn(() =>
          Promise.resolve({
            event,
            manifest,
          }),
        ),
        hasPackage: vi.fn(() => Promise.resolve(true)),
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
        tarball: `https://registry.test/objects/${installArtifactDigest(manifest)}`,
      },
      name: '@example.com/hello-regesta',
      version: '1.0.0',
    })
    expect(reader.database.getPackageChannels).toHaveBeenCalledWith(packageId)
    expect(reader.database.getRelease).toHaveBeenCalledWith(packageId, '1.0.0')
    expect(reader.database.hasPackage).not.toHaveBeenCalled()
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
        getRelease: vi.fn(() =>
          Promise.resolve({
            event,
            manifest,
          }),
        ),
        hasPackage: vi.fn(() => Promise.resolve(true)),
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
    expect(conditional.headers.get('last-modified')).toBe(
      'Wed, 01 Jan 2025 00:00:00 GMT',
    )
    expect(await conditional.text()).toBe('')
    expect(conditionalSince.status).toBe(304)
    expect(conditionalSince.headers.get('cache-control')).toBe(
      'public, max-age=31536000, immutable',
    )
    expect(conditionalSince.headers.get('last-modified')).toBe(
      'Wed, 01 Jan 2025 00:00:00 GMT',
    )
    expect(await conditionalSince.text()).toBe('')
    expect(reader.database.getPackageChannels).toHaveBeenCalledWith(packageId)
    expect(reader.database.getRelease).toHaveBeenCalledWith(packageId, '1.0.0')
    expect(reader.database.hasPackage).not.toHaveBeenCalled()
    expect(reader.database.getPackageEventState).not.toHaveBeenCalled()
    expect(reader.database.listPackageReleases).not.toHaveBeenCalled()
    expect(upstreamFetch).not.toHaveBeenCalled()
  })

  it('returns 404 for missing versions when indexed local package exists', async () => {
    const upstreamFetch = vi.fn<typeof fetch>(() => {
      throw new Error('upstream fallback should not be used for local packages')
    })
    const reader = {
      database: {
        getPackageChannels: vi.fn(() => Promise.resolve({})),
        getPackageEventState: vi.fn(() =>
          Promise.reject(
            new Error('missing versions should not read package event state'),
          ),
        ),
        getRelease: vi.fn(() => Promise.resolve(undefined)),
        hasPackage: vi.fn(() => Promise.resolve(true)),
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
    expect(reader.database.getPackageChannels).toHaveBeenCalledWith(packageId)
    expect(reader.database.getRelease).toHaveBeenCalledWith(
      packageId,
      'missing',
    )
    expect(reader.database.hasPackage).toHaveBeenCalledWith(packageId)
    expect(reader.database.getPackageEventState).not.toHaveBeenCalled()
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

function installArtifactDigest(manifest: ReleaseManifest): string {
  const artifact = manifest.artifacts.find((item) => item.role === 'install')
  if (!artifact) {
    throw new Error('Expected install artifact')
  }

  return artifact.digest
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
