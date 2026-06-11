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
        mirroredAt: expect.any(String),
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
        ok: true,
        packages: [fixture.manifest.id],
        problems: [],
        registry: 'https://registry.example',
        releases: [
          { id: fixture.manifest.id, version: fixture.manifest.version },
        ],
      })
      expect(inventory.mirroredAt).toBe(result.mirroredAt)
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
      await expect(
        readText(join(outputDir, 'inventory.json')).then((text) =>
          JSON.parse(text),
        ),
      ).resolves.toMatchObject({
        ok: false,
        problems: result.problems,
      })
    } finally {
      await rm(outputDir, { force: true, recursive: true })
    }
  })

  it('rejects object responses whose Content-Type does not match the descriptor', async () => {
    const fixture = releaseFixture()
    const outputDir = await mkdtemp(join(tmpdir(), 'regesta-mirror-test-'))

    try {
      const result = await mirrorRegistry({
        fetch: mirrorFetch(fixture, {
          objectMediaTypes: new Map([
            [fixture.manifest.source.digest, 'application/octet-stream'],
          ]),
        }),
        outputDir,
        registry: 'https://registry.example',
      })

      expect(result.ok).toBe(false)
      expect(result.problems).toEqual([
        `Mirror object request failed: Object Content-Type mismatch: ${fixture.manifest.source.digest}`,
      ])
    } finally {
      await rm(outputDir, { force: true, recursive: true })
    }
  })

  it('rejects object responses without immutable Cache-Control', async () => {
    const fixture = releaseFixture()
    const outputDir = await mkdtemp(join(tmpdir(), 'regesta-mirror-test-'))

    try {
      const result = await mirrorRegistry({
        fetch: mirrorFetch(fixture, {
          objectCacheControls: new Map([
            [fixture.manifest.source.digest, 'public, max-age=60'],
          ]),
        }),
        outputDir,
        registry: 'https://registry.example',
      })

      expect(result.ok).toBe(false)
      expect(result.problems).toEqual([
        `Mirror object request failed: Object Cache-Control must include immutable: ${fixture.manifest.source.digest}`,
      ])
    } finally {
      await rm(outputDir, { force: true, recursive: true })
    }
  })

  it('rejects object inventory pages that are not digest ordered', async () => {
    const fixture = releaseFixture()
    const outputDir = await mkdtemp(join(tmpdir(), 'regesta-mirror-test-'))

    try {
      const result = await mirrorRegistry({
        fetch: mirrorFetch(fixture, {
          reverseObjectInventory: true,
        }),
        outputDir,
        registry: 'https://registry.example',
      })

      expect(result.ok).toBe(false)
      expect(result.problems).toEqual([
        'Mirror object inventory page must be strictly ordered by digest',
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

  it('reports duplicate event ids in public event log pages', async () => {
    const fixture = releaseFixture()
    const outputDir = await mkdtemp(join(tmpdir(), 'regesta-mirror-test-'))

    try {
      const result = await mirrorRegistry({
        fetch: mirrorFetch(fixture, {
          duplicateEventPage: true,
        }),
        outputDir,
        registry: 'https://registry.example',
      })

      expect(result.ok).toBe(false)
      expect(result.problems).toEqual([
        `Mirror event log contains duplicate event id: ${fixture.event.id}`,
      ])
    } finally {
      await rm(outputDir, { force: true, recursive: true })
    }
  })

  it('rejects event log pages with unknown fields', async () => {
    const fixture = releaseFixture()
    const outputDir = await mkdtemp(join(tmpdir(), 'regesta-mirror-test-'))

    try {
      const result = await mirrorRegistry({
        fetch: mirrorFetch(fixture, {
          eventPageExtras: {
            operatorHint: 'trust me',
          },
        }),
        outputDir,
        registry: 'https://registry.example',
      })

      expect(result.ok).toBe(false)
      expect(result.problems).toEqual([
        'Mirror JSON request failed: Mirror event log page must not include unknown field: operatorHint',
      ])
    } finally {
      await rm(outputDir, { force: true, recursive: true })
    }
  })

  it('rejects empty event log pages that include nextAfter', async () => {
    const fixture = releaseFixture()
    const outputDir = await mkdtemp(join(tmpdir(), 'regesta-mirror-test-'))

    try {
      const result = await mirrorRegistry({
        fetch: mirrorFetch(fixture, {
          emptyEventPageNextAfter: fixture.event.id,
        }),
        outputDir,
        registry: 'https://registry.example',
      })

      expect(result.ok).toBe(false)
      expect(result.problems).toEqual([
        'Mirror event log empty page must not include nextAfter',
      ])
    } finally {
      await rm(outputDir, { force: true, recursive: true })
    }
  })

  it('rejects empty object inventory pages that include nextAfter', async () => {
    const fixture = releaseFixture()
    const outputDir = await mkdtemp(join(tmpdir(), 'regesta-mirror-test-'))

    try {
      const result = await mirrorRegistry({
        fetch: mirrorFetch(fixture, {
          emptyObjectInventoryNextAfter: fixture.extraObject.digest,
        }),
        outputDir,
        registry: 'https://registry.example',
      })

      expect(result.ok).toBe(false)
      expect(result.problems).toEqual([
        'Mirror object inventory empty page must not include nextAfter',
      ])
    } finally {
      await rm(outputDir, { force: true, recursive: true })
    }
  })

  it('rejects non-canonical immutable event endpoint responses', async () => {
    const fixture = releaseFixture()
    const outputDir = await mkdtemp(join(tmpdir(), 'regesta-mirror-test-'))

    try {
      const result = await mirrorRegistry({
        fetch: mirrorFetch(fixture, {
          eventEndpointText: JSON.stringify(fixture.event),
        }),
        outputDir,
        registry: 'https://registry.example',
      })

      expect(result.ok).toBe(false)
      expect(result.problems).toEqual([
        `Mirror JSON request failed: Response body is not canonical JSON: https://registry.example${eventRoute(fixture.event.id)}`,
      ])
    } finally {
      await rm(outputDir, { force: true, recursive: true })
    }
  })

  it('rejects non-canonical immutable release envelope responses', async () => {
    const fixture = releaseFixture()
    const outputDir = await mkdtemp(join(tmpdir(), 'regesta-mirror-test-'))

    try {
      const result = await mirrorRegistry({
        fetch: mirrorFetch(fixture, {
          releaseEnvelopeText: JSON.stringify(fixture.releaseEnvelope),
        }),
        outputDir,
        registry: 'https://registry.example',
      })

      expect(result.ok).toBe(false)
      expect(result.problems).toEqual([
        `Mirror JSON request failed: Response body is not canonical JSON: https://registry.example/packages/${encodeURIComponent(
          fixture.manifest.id,
        )}/releases/${fixture.manifest.version}`,
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
          mirroredAt: expect.any(String),
          objects: 4,
          ok: true,
          packages: 1,
          problems: [],
          releases: 1,
        },
        ok: true,
        problems: [],
        right: {
          directory: rightDir,
          events: 1,
          lastEventId: fixture.event.id,
          mirroredAt: expect.any(String),
          objects: 4,
          ok: true,
          packages: 1,
          problems: [],
          releases: 1,
        },
      })
    } finally {
      await rm(leftDir, { force: true, recursive: true })
      await rm(rightDir, { force: true, recursive: true })
    }
  })

  it('rejects local mirror inventories with non-canonical mirroredAt timestamps', async () => {
    const fixture = releaseFixture()
    const leftDir = await mirroredDirectory(fixture)
    const rightDir = await mirroredDirectory(fixture)

    try {
      const inventory = JSON.parse(
        await readText(join(rightDir, 'inventory.json')),
      )
      await writeFile(
        join(rightDir, 'inventory.json'),
        `${canonicalJson({
          ...inventory,
          mirroredAt: '2026-06-10T00:00:00Z',
        })}\n`,
      )

      const result = await compareMirrorDirectories({ leftDir, rightDir })

      expect(result.ok).toBe(false)
      expect(result.problems).toEqual([
        'Right mirror inventory read failed: Right mirror inventory mirroredAt must be canonical ISO 8601',
      ])
    } finally {
      await rm(leftDir, { force: true, recursive: true })
      await rm(rightDir, { force: true, recursive: true })
    }
  })

  it('rejects local mirror inventories with unknown fields', async () => {
    const fixture = releaseFixture()
    const leftDir = await mirroredDirectory(fixture)
    const rightDir = await mirroredDirectory(fixture)

    try {
      const inventory = JSON.parse(
        await readText(join(rightDir, 'inventory.json')),
      )
      await writeFile(
        join(rightDir, 'inventory.json'),
        `${canonicalJson({
          ...inventory,
          operatorHint: 'trust me',
        })}\n`,
      )

      const result = await compareMirrorDirectories({ leftDir, rightDir })

      expect(result.ok).toBe(false)
      expect(result.problems).toEqual([
        'Right mirror inventory read failed: Right mirror inventory must not include unknown field: operatorHint',
      ])
    } finally {
      await rm(leftDir, { force: true, recursive: true })
      await rm(rightDir, { force: true, recursive: true })
    }
  })

  it('rejects local mirror inventories whose lastEventId does not match events', async () => {
    const fixture = releaseFixture()
    const leftDir = await mirroredDirectory(fixture)
    const rightDir = await mirroredDirectory(fixture)

    try {
      const inventory = await readInventory(join(rightDir, 'inventory.json'))
      await writeFile(
        join(rightDir, 'inventory.json'),
        `${canonicalJson({
          ...inventory,
          lastEventId: sha256(bytes('different event')),
        })}\n`,
      )

      const result = await compareMirrorDirectories({ leftDir, rightDir })

      expect(result.ok).toBe(false)
      expect(result.problems).toEqual([
        'Right mirror inventory read failed: Right mirror inventory lastEventId must match final event id',
      ])
    } finally {
      await rm(leftDir, { force: true, recursive: true })
      await rm(rightDir, { force: true, recursive: true })
    }
  })

  it('rejects local mirror inventory release entries with unknown fields', async () => {
    const fixture = releaseFixture()
    const leftDir = await mirroredDirectory(fixture)
    const rightDir = await mirroredDirectory(fixture)

    try {
      const inventory = JSON.parse(
        await readText(join(rightDir, 'inventory.json')),
      )
      await writeFile(
        join(rightDir, 'inventory.json'),
        `${canonicalJson({
          ...inventory,
          releases: inventory.releases.map(
            (release: Record<string, unknown>) => {
              return {
                ...release,
                operatorHint: 'trust me',
              }
            },
          ),
        })}\n`,
      )

      const result = await compareMirrorDirectories({ leftDir, rightDir })

      expect(result.ok).toBe(false)
      expect(result.problems).toEqual([
        'Right mirror inventory read failed: Right mirror inventory releases[0] must not include unknown field: operatorHint',
      ])
    } finally {
      await rm(leftDir, { force: true, recursive: true })
      await rm(rightDir, { force: true, recursive: true })
    }
  })

  it('rejects local mirror inventories with unsorted object lists', async () => {
    const fixture = releaseFixture()
    const leftDir = await mirroredDirectory(fixture)
    const rightDir = await mirroredDirectory(fixture)

    try {
      const inventory = await readInventory(join(rightDir, 'inventory.json'))
      const objects = readUnknownArray(inventory, 'objects')
      await writeFile(
        join(rightDir, 'inventory.json'),
        `${canonicalJson({
          ...inventory,
          objects: objects.toReversed(),
        })}\n`,
      )

      const result = await compareMirrorDirectories({ leftDir, rightDir })

      expect(result.ok).toBe(false)
      expect(result.problems).toEqual([
        'Right mirror inventory read failed: Right mirror inventory objects must be sorted and unique',
      ])
    } finally {
      await rm(leftDir, { force: true, recursive: true })
      await rm(rightDir, { force: true, recursive: true })
    }
  })

  it('rejects local mirror inventories with duplicate event lists', async () => {
    const fixture = releaseFixture()
    const leftDir = await mirroredDirectory(fixture)
    const rightDir = await mirroredDirectory(fixture)

    try {
      const inventory = await readInventory(join(rightDir, 'inventory.json'))
      const events = readUnknownArray(inventory, 'events')
      await writeFile(
        join(rightDir, 'inventory.json'),
        `${canonicalJson({
          ...inventory,
          events: [...events, events[0]],
        })}\n`,
      )

      const result = await compareMirrorDirectories({ leftDir, rightDir })

      expect(result.ok).toBe(false)
      expect(result.problems).toEqual([
        'Right mirror inventory read failed: Right mirror inventory events must be unique',
      ])
    } finally {
      await rm(leftDir, { force: true, recursive: true })
      await rm(rightDir, { force: true, recursive: true })
    }
  })

  it('rejects local mirror inventories with duplicate package lists', async () => {
    const fixture = releaseFixture()
    const leftDir = await mirroredDirectory(fixture)
    const rightDir = await mirroredDirectory(fixture)

    try {
      const inventory = await readInventory(join(rightDir, 'inventory.json'))
      const packages = readUnknownArray(inventory, 'packages')
      await writeFile(
        join(rightDir, 'inventory.json'),
        `${canonicalJson({
          ...inventory,
          packages: [...packages, packages[0]],
        })}\n`,
      )

      const result = await compareMirrorDirectories({ leftDir, rightDir })

      expect(result.ok).toBe(false)
      expect(result.problems).toEqual([
        'Right mirror inventory read failed: Right mirror inventory packages must be sorted and unique',
      ])
    } finally {
      await rm(leftDir, { force: true, recursive: true })
      await rm(rightDir, { force: true, recursive: true })
    }
  })

  it('rejects local mirror inventories with duplicate release lists', async () => {
    const fixture = releaseFixture()
    const leftDir = await mirroredDirectory(fixture)
    const rightDir = await mirroredDirectory(fixture)

    try {
      const inventory = await readInventory(join(rightDir, 'inventory.json'))
      const releases = readUnknownArray(inventory, 'releases')
      await writeFile(
        join(rightDir, 'inventory.json'),
        `${canonicalJson({
          ...inventory,
          releases: [...releases, releases[0]],
        })}\n`,
      )

      const result = await compareMirrorDirectories({ leftDir, rightDir })

      expect(result.ok).toBe(false)
      expect(result.problems).toEqual([
        'Right mirror inventory read failed: Right mirror inventory releases must be unique',
      ])
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

  it('reports local release files that no longer match mirrored events', async () => {
    const fixture = releaseFixture()
    const leftDir = await mirroredDirectory(fixture)
    const rightDir = await mirroredDirectory(fixture)

    try {
      await writeFile(
        releasePath(rightDir, fixture.manifest.id, fixture.manifest.version),
        `${canonicalJson({
          ...fixture.releaseEnvelope,
          manifest: {
            ...fixture.manifest,
            metadata: {
              description: 'Locally tampered description.',
            },
          },
        })}\n`,
      )

      const result = await compareMirrorDirectories({ leftDir, rightDir })

      expect(result.ok).toBe(false)
      expect(result.problems).toEqual([
        `Right mirror release file is inconsistent with event: ${fixture.manifest.id}@${fixture.manifest.version}: Mirror release manifest digest does not match manifestDescriptor`,
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
    duplicateEventPage?: boolean
    emptyEventPageNextAfter?: string
    emptyObjectInventoryNextAfter?: string
    eventPageExtras?: Record<string, unknown>
    eventEndpointText?: string
    omitEventPageContentLength?: boolean
    objectCacheControls?: ReadonlyMap<string, string>
    objectMediaTypes?: ReadonlyMap<string, string>
    objectOverrides?: ReadonlyMap<string, Uint8Array>
    releaseEnvelope?: unknown
    releaseEnvelopeText?: string
    reverseObjectInventory?: boolean
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
        return Promise.resolve(
          jsonResponse({
            events: [],
            ...(options.emptyEventPageNextAfter
              ? { nextAfter: options.emptyEventPageNextAfter }
              : {}),
          }),
        )
      }

      const events = options.duplicateEventPage
        ? [fixture.event, fixture.event]
        : [fixture.event]

      return Promise.resolve(
        jsonResponse(
          {
            events,
            ...options.eventPageExtras,
            nextAfter: fixture.event.id,
          },
          { omitContentLength: options.omitEventPageContentLength },
        ),
      )
    }

    if (url.pathname === eventRoute(fixture.event.id)) {
      return Promise.resolve(
        options.eventEndpointText
          ? rawCanonicalJsonResponse(options.eventEndpointText)
          : canonicalJsonResponse(fixture.event),
      )
    }

    if (
      url.pathname ===
      `/packages/${encodeURIComponent(
        fixture.manifest.id,
      )}/releases/${fixture.manifest.version}`
    ) {
      return Promise.resolve(
        options.releaseEnvelopeText
          ? rawCanonicalJsonResponse(options.releaseEnvelopeText)
          : canonicalJsonResponse(
              options.releaseEnvelope ?? fixture.releaseEnvelope,
            ),
      )
    }

    if (url.pathname === '/objects') {
      if (
        url.searchParams.has('after') &&
        options.emptyObjectInventoryNextAfter
      ) {
        return Promise.resolve(
          jsonResponse({
            nextAfter: options.emptyObjectInventoryNextAfter,
            object: 'regesta.object-inventory',
            objects: [],
          }),
        )
      }

      return Promise.resolve(
        objectInventoryResponse(
          options.reverseObjectInventory
            ? descriptors.toReversed()
            : descriptors,
          url,
        ),
      )
    }

    const object = objects.get(digestFromObjectRoute(url.pathname))
    if (object) {
      return Promise.resolve(
        binaryResponse(
          object.bytes,
          options.objectMediaTypes?.get(object.descriptor.digest) ??
            object.descriptor.mediaType,
          options.objectCacheControls?.get(object.descriptor.digest),
        ),
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

function canonicalJsonResponse(value: unknown): Response {
  return rawCanonicalJsonResponse(`${canonicalJson(value)}\n`)
}

function rawCanonicalJsonResponse(body: string): Response {
  return new Response(body, {
    headers: {
      'cache-control': 'public, max-age=31536000, immutable',
      'content-length': String(bytes(body).byteLength),
      'content-type': 'application/json',
    },
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

function binaryResponse(
  bytes: Uint8Array,
  mediaType: string,
  cacheControl = 'public, max-age=31536000, immutable',
): Response {
  return new Response(bytes, {
    headers: {
      'cache-control': cacheControl,
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

function releasePath(outputDir: string, packageId: string, version: string) {
  return join(
    outputDir,
    'releases',
    encodeURIComponent(packageId),
    `${encodeURIComponent(version)}.json`,
  )
}

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value)
}

async function readInventory(path: string): Promise<Record<string, unknown>> {
  const value: unknown = JSON.parse(await readText(path))
  if (!isRecord(value)) {
    throw new TypeError('Expected mirror inventory to be an object')
  }

  return value
}

function readUnknownArray(
  record: Record<string, unknown>,
  key: string,
): unknown[] {
  const value = record[key]
  if (!Array.isArray(value)) {
    throw new TypeError(`Expected mirror inventory ${key} to be an array`)
  }

  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function readText(path: string): Promise<string> {
  return readFile(path, 'utf8')
}
