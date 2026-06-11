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
import type { NpmRegistryReader } from './reader.ts'

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
  it('serves local npm packuments from the narrow registry reader', async () => {
    const manifest = releaseManifest()
    const event = publishEvent(manifest)
    const upstreamFetch = vi.fn<typeof fetch>(() => {
      throw new Error('upstream fallback should not be used for local packages')
    })
    const reader = {
      database: {
        listPackageEvents: vi.fn(() => Promise.resolve([event])),
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

    expect(response.status).toBe(200)
    expect(response.headers.get('etag')).toBe(
      `W/"regesta.npm-projection:${event.id}"`,
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
    expect(reader.database.listPackageReleases).toHaveBeenCalledWith(packageId)
    expect(reader.database.listPackageEvents).toHaveBeenCalledWith(packageId)
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
