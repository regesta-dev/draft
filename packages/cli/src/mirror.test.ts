import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  canonicalJson,
  registryEventDigest,
  sha256,
  type ReleaseManifest,
} from '@regesta/protocol'
import { describe, expect, it } from 'vitest'
import { compareMirrorDirectories, mirrorRegistry } from './mirror.ts'

describe('mirrorRegistry', () => {
  it('mirrors public events, release envelopes, and objects', async () => {
    const fixture = releaseFixture()
    const outputDir = await mkdtemp(join(tmpdir(), 'regesta-mirror-test-'))

    try {
      const result = await mirrorRegistry({
        fetch: mirrorFetch(fixture),
        limit: 1,
        outputDir,
        registry: 'https://registry.example/',
      })

      expect(result).toEqual({
        events: 1,
        lastEventId: fixture.event.id,
        objects: 4,
        ok: true,
        outputDir,
        packages: 1,
        problems: [],
        registry: 'https://registry.example',
        releases: 1,
      })
      await expect(
        readText(eventPath(outputDir, fixture.event.id)),
      ).resolves.toBe(`${canonicalJson(fixture.event)}\n`)
      await expect(
        readText(
          join(
            outputDir,
            'releases',
            encodeURIComponent(fixture.manifest.id),
            '1.0.0.json',
          ),
        ),
      ).resolves.toBe(`${canonicalJson(fixture.releaseEnvelope)}\n`)
      expect(
        new Uint8Array(
          await readFile(objectPath(outputDir, fixture.manifest.source.digest)),
        ),
      ).toEqual(fixture.sourceBytes)
      expect(
        new Uint8Array(
          await readFile(objectPath(outputDir, fixture.artifact.digest)),
        ),
      ).toEqual(fixture.artifactBytes)
      expect(
        new Uint8Array(
          await readFile(objectPath(outputDir, fixture.extraObject.digest)),
        ),
      ).toEqual(fixture.extraObjectBytes)

      const inventory = JSON.parse(
        await readText(join(outputDir, 'inventory.json')),
      )
      expect(inventory).toMatchObject({
        events: [fixture.event.id],
        kind: 'regesta.local-mirror.inventory',
        lastEventId: fixture.event.id,
        objects: [
          fixture.artifact.digest,
          fixture.extraObject.digest,
          fixture.manifest.source.digest,
          fixture.manifestDescriptor.digest,
        ].toSorted(),
        packages: [fixture.manifest.id],
        registry: 'https://registry.example',
        releases: [
          { id: fixture.manifest.id, version: fixture.manifest.version },
        ],
      })
      expect(typeof inventory.mirroredAt).toBe('string')
    } finally {
      await rm(outputDir, { force: true, recursive: true })
    }
  })

  it('reports object digest mismatches', async () => {
    const fixture = releaseFixture()
    const outputDir = await mkdtemp(join(tmpdir(), 'regesta-mirror-test-'))

    try {
      const result = await mirrorRegistry({
        fetch: mirrorFetch(fixture, {
          objectOverrides: new Map([
            [fixture.manifest.source.digest, bytes('tampered source')],
          ]),
        }),
        outputDir,
        registry: 'https://registry.example',
      })

      expect(result.ok).toBe(false)
      expect(result.problems).toEqual([
        `Mirror object request failed: Object size does not match descriptor: ${fixture.manifest.source.digest}`,
      ])
    } finally {
      await rm(outputDir, { force: true, recursive: true })
    }
  })

  it('rejects release envelopes that do not match their manifest descriptor', async () => {
    const fixture = releaseFixture()
    const outputDir = await mkdtemp(join(tmpdir(), 'regesta-mirror-test-'))

    try {
      const result = await mirrorRegistry({
        fetch: mirrorFetch(fixture, {
          releaseEnvelope: {
            ...fixture.releaseEnvelope,
            manifest: {
              ...fixture.manifest,
              metadata: {
                description: 'Tampered description.',
              },
            },
          },
        }),
        outputDir,
        registry: 'https://registry.example',
      })

      expect(result.ok).toBe(false)
      expect(result.problems).toEqual([
        'Mirror release manifest digest does not match manifestDescriptor',
      ])
      await expect(
        readFile(
          join(
            outputDir,
            'releases',
            encodeURIComponent(fixture.manifest.id),
            '1.0.0.json',
          ),
        ),
      ).rejects.toThrow('ENOENT')
    } finally {
      await rm(outputDir, { force: true, recursive: true })
    }
  })

  it('rejects public JSON responses without Content-Length', async () => {
    const fixture = releaseFixture()
    const outputDir = await mkdtemp(join(tmpdir(), 'regesta-mirror-test-'))

    try {
      const result = await mirrorRegistry({
        fetch: mirrorFetch(fixture, {
          omitEventPageContentLength: true,
        }),
        outputDir,
        registry: 'https://registry.example',
      })

      expect(result.ok).toBe(false)
      expect(result.problems).toEqual([
        'Mirror JSON request failed: Missing JSON Content-Length header: https://registry.example/events?limit=999',
      ])
    } finally {
      await rm(outputDir, { force: true, recursive: true })
    }
  })
})

describe('compareMirrorDirectories', () => {
  it('compares matching local mirror directories', async () => {
    const fixture = releaseFixture()
    const leftDir = await mirroredDirectory(fixture)
    const rightDir = await mirroredDirectory(fixture)

    try {
      const result = await compareMirrorDirectories({ leftDir, rightDir })

      expect(result).toEqual({
        checkedEvents: 1,
        checkedObjects: 4,
        checkedReleases: 1,
        left: {
          directory: leftDir,
          events: 1,
          lastEventId: fixture.event.id,
          objects: 4,
          packages: 1,
          releases: 1,
        },
        ok: true,
        problems: [],
        right: {
          directory: rightDir,
          events: 1,
          lastEventId: fixture.event.id,
          objects: 4,
          packages: 1,
          releases: 1,
        },
      })
    } finally {
      await rm(leftDir, { force: true, recursive: true })
      await rm(rightDir, { force: true, recursive: true })
    }
  })

  it('reports corrupted local mirror objects', async () => {
    const fixture = releaseFixture()
    const leftDir = await mirroredDirectory(fixture)
    const rightDir = await mirroredDirectory(fixture)

    try {
      await writeFile(
        objectPath(rightDir, fixture.artifact.digest),
        bytes('tampered artifact'),
      )

      const result = await compareMirrorDirectories({ leftDir, rightDir })

      expect(result.ok).toBe(false)
      expect(result.problems).toEqual([
        `Right mirror object bytes do not match digest: ${fixture.artifact.digest}`,
      ])
    } finally {
      await rm(leftDir, { force: true, recursive: true })
      await rm(rightDir, { force: true, recursive: true })
    }
  })
})

function releaseFixture() {
  const sourceBytes = bytes('source archive')
  const artifactBytes = bytes('install artifact')
  const extraObjectBytes = bytes('unreferenced public object')
  const source = objectDescriptor(
    sourceBytes,
    'application/vnd.regesta.source-archive+tgz',
  )
  const artifact = {
    ...objectDescriptor(artifactBytes, 'application/gzip'),
    filename: 'hello-regesta-1.0.0.tgz',
    format: 'npm-tarball',
    role: 'install',
  } satisfies ReleaseManifest['artifacts'][number]
  const extraObject = objectDescriptor(
    extraObjectBytes,
    'application/octet-stream',
  )
  const manifest: ReleaseManifest = {
    artifacts: [artifact],
    configDigest: sha256(bytes('config')),
    createdAt: '2026-06-10T00:00:00.000Z',
    ecosystem: 'npm',
    id: 'npm:example.com/hello-regesta',
    metadata: {
      description: 'Hello Regesta.',
    },
    name: 'example.com/hello-regesta',
    object: 'regesta.release-manifest',
    provenance: {
      level: 'source-attached',
      verified: false,
    },
    source,
    version: '1.0.0',
  }
  const manifestBytes = bytes(canonicalJson(manifest))
  const manifestDescriptor = objectDescriptor(
    manifestBytes,
    'application/vnd.regesta.release-manifest.v0+json',
  )
  const eventPayload = {
    artifactDigests: [artifact.digest],
    channel: 'latest',
    eventType: 'release.published',
    object: 'regesta.event',
    release: {
      id: manifest.id,
      manifestDigest: manifestDescriptor.digest,
      version: manifest.version,
    },
    sourceDigest: source.digest,
    timestamp: '2026-06-10T00:00:00.000Z',
  } as const
  const event = {
    ...eventPayload,
    id: registryEventDigest(eventPayload),
  }
  const releaseEnvelope = {
    event,
    manifest,
    manifestDescriptor,
  }

  return {
    artifact,
    artifactBytes,
    event,
    extraObject,
    extraObjectBytes,
    manifest,
    manifestBytes,
    manifestDescriptor,
    releaseEnvelope,
    sourceBytes,
  }
}

async function mirroredDirectory(
  fixture: ReturnType<typeof releaseFixture>,
): Promise<string> {
  const outputDir = await mkdtemp(join(tmpdir(), 'regesta-mirror-test-'))
  const result = await mirrorRegistry({
    fetch: mirrorFetch(fixture),
    outputDir,
    registry: 'https://registry.example',
  })

  if (!result.ok) {
    throw new Error(result.problems.join('\n'))
  }

  return outputDir
}

function mirrorFetch(
  fixture: ReturnType<typeof releaseFixture>,
  options: {
    omitEventPageContentLength?: boolean
    objectOverrides?: ReadonlyMap<string, Uint8Array>
    releaseEnvelope?: unknown
  } = {},
): typeof fetch {
  const objects = new Map<
    string,
    { bytes: Uint8Array; descriptor: ReturnType<typeof objectDescriptor> }
  >([
    [
      fixture.manifestDescriptor.digest,
      {
        bytes:
          options.objectOverrides?.get(fixture.manifestDescriptor.digest) ??
          fixture.manifestBytes,
        descriptor: fixture.manifestDescriptor,
      },
    ],
    [
      fixture.manifest.source.digest,
      {
        bytes:
          options.objectOverrides?.get(fixture.manifest.source.digest) ??
          fixture.sourceBytes,
        descriptor: fixture.manifest.source,
      },
    ],
    [
      fixture.artifact.digest,
      {
        bytes:
          options.objectOverrides?.get(fixture.artifact.digest) ??
          fixture.artifactBytes,
        descriptor: fixture.artifact,
      },
    ],
    [
      fixture.extraObject.digest,
      {
        bytes:
          options.objectOverrides?.get(fixture.extraObject.digest) ??
          fixture.extraObjectBytes,
        descriptor: fixture.extraObject,
      },
    ],
  ])
  const descriptors = [...objects.values()]
    .map((object) => object.descriptor)
    .toSorted((left, right) => {
      return left.digest.localeCompare(right.digest)
    })

  return (input: RequestInfo | URL): Promise<Response> => {
    const url = new URL(String(input))

    if (url.pathname === '/events') {
      if (url.searchParams.has('after')) {
        return Promise.resolve(jsonResponse({ events: [] }))
      }

      return Promise.resolve(
        jsonResponse(
          {
            events: [fixture.event],
            nextAfter: fixture.event.id,
          },
          { omitContentLength: options.omitEventPageContentLength },
        ),
      )
    }

    if (url.pathname === eventRoute(fixture.event.id)) {
      return Promise.resolve(jsonResponse(fixture.event))
    }

    if (
      url.pathname ===
      `/packages/${encodeURIComponent(
        fixture.manifest.id,
      )}/releases/${fixture.manifest.version}`
    ) {
      return Promise.resolve(
        jsonResponse(options.releaseEnvelope ?? fixture.releaseEnvelope),
      )
    }

    if (url.pathname === '/objects') {
      return Promise.resolve(objectInventoryResponse(descriptors, url))
    }

    const object = objects.get(digestFromObjectRoute(url.pathname))
    if (object) {
      return Promise.resolve(
        binaryResponse(object.bytes, object.descriptor.mediaType),
      )
    }

    return Promise.resolve(new Response('Not found', { status: 404 }))
  }
}

function objectDescriptor(bytes: Uint8Array, mediaType: string) {
  return {
    digest: sha256(bytes),
    mediaType,
    size: bytes.byteLength,
  }
}

function jsonResponse(
  value: unknown,
  options: { omitContentLength?: boolean } = {},
): Response {
  const body = canonicalJson(value)
  const headers = new Headers({
    'content-type': 'application/json',
  })

  if (!options.omitContentLength) {
    headers.set('content-length', String(bytes(body).byteLength))
  }

  return new Response(body, {
    headers,
  })
}

function objectInventoryResponse(
  descriptors: ReturnType<typeof objectDescriptor>[],
  url: URL,
): Response {
  const after = url.searchParams.get('after')
  const limit = Number(url.searchParams.get('limit') ?? descriptors.length)
  const afterIndex = after
    ? descriptors.findIndex((descriptor) => descriptor.digest === after)
    : -1

  if (after && afterIndex === -1) {
    return new Response('Not found', { status: 404 })
  }

  const objects = descriptors.slice(afterIndex + 1, afterIndex + 1 + limit)
  const lastObject = objects.at(-1)

  return jsonResponse({
    ...(lastObject ? { nextAfter: lastObject.digest } : {}),
    object: 'regesta.object-inventory',
    objects,
  })
}

function binaryResponse(bytes: Uint8Array, mediaType: string): Response {
  return new Response(bytes, {
    headers: {
      'content-length': String(bytes.byteLength),
      'content-type': mediaType,
    },
  })
}

function eventRoute(digest: string): string {
  return `/events/${digest.replace(':', '/')}`
}

function digestFromObjectRoute(pathname: string): string {
  const match = /^\/objects\/([^/]+)\/([^/]+)$/u.exec(pathname)
  return match ? `${match[1]}:${match[2]}` : ''
}

function eventPath(outputDir: string, digest: string): string {
  const [algorithm, hex] = digest.split(':')
  return join(outputDir, 'events', algorithm!, `${hex}.json`)
}

function objectPath(outputDir: string, digest: string): string {
  const [algorithm, hex] = digest.split(':')
  return join(outputDir, 'objects', algorithm!, hex!)
}

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value)
}

function readText(path: string): Promise<string> {
  return readFile(path, 'utf8')
}
