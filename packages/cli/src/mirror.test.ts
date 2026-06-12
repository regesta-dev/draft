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

  it('mirrors future ecosystem releases by canonical package id', async () => {
    const fixture = releaseFixture({
      artifactBytes: bytes('maven install artifact'),
      artifactFilename: 'artifact-1.0.0.jar',
      artifactFormat: 'maven-artifact',
      artifactMediaType: 'application/octet-stream',
      ecosystem: 'maven',
      id: 'maven:example.com/group/artifact',
      name: 'example.com/group/artifact',
    })
    const outputDir = await mkdtemp(join(tmpdir(), 'regesta-mirror-test-'))

    try {
      const result = await mirrorRegistry({
        fetch: mirrorFetch(fixture),
        outputDir,
        registry: 'https://registry.example/',
      })

      expect(result).toMatchObject({
        events: 1,
        ok: true,
        packages: 1,
        problems: [],
        releases: 1,
      })
      await expect(
        readText(releasePath(outputDir, fixture.manifest.id, '1.0.0')),
      ).resolves.toBe(`${canonicalJson(fixture.releaseEnvelope)}\n`)
      await expect(
        readInventory(join(outputDir, 'inventory.json')),
      ).resolves.toMatchObject({
        packages: ['maven:example.com/group/artifact'],
        releases: [
          {
            id: 'maven:example.com/group/artifact',
            version: '1.0.0',
          },
        ],
      })
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

  it('does not accept immutable as an object Cache-Control substring', async () => {
    const fixture = releaseFixture()
    const outputDir = await mkdtemp(join(tmpdir(), 'regesta-mirror-test-'))

    try {
      const result = await mirrorRegistry({
        fetch: mirrorFetch(fixture, {
          objectCacheControls: new Map([
            [
              fixture.manifest.source.digest,
              'public, max-age=60, not-immutable',
            ],
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

  it('rejects object responses without Accept-Ranges', async () => {
    const fixture = releaseFixture()
    const outputDir = await mkdtemp(join(tmpdir(), 'regesta-mirror-test-'))

    try {
      const result = await mirrorRegistry({
        fetch: mirrorFetch(fixture, {
          objectAcceptRanges: new Map([[fixture.manifest.source.digest, null]]),
        }),
        outputDir,
        registry: 'https://registry.example',
      })

      expect(result.ok).toBe(false)
      expect(result.problems).toEqual([
        `Mirror object request failed: Missing object Accept-Ranges header: ${fixture.manifest.source.digest}`,
      ])
    } finally {
      await rm(outputDir, { force: true, recursive: true })
    }
  })

  it('rejects object responses whose Accept-Ranges is not bytes', async () => {
    const fixture = releaseFixture()
    const outputDir = await mkdtemp(join(tmpdir(), 'regesta-mirror-test-'))

    try {
      const result = await mirrorRegistry({
        fetch: mirrorFetch(fixture, {
          objectAcceptRanges: new Map([
            [fixture.manifest.source.digest, 'none'],
          ]),
        }),
        outputDir,
        registry: 'https://registry.example',
      })

      expect(result.ok).toBe(false)
      expect(result.problems).toEqual([
        `Mirror object request failed: Object Accept-Ranges must be bytes: ${fixture.manifest.source.digest}`,
      ])
    } finally {
      await rm(outputDir, { force: true, recursive: true })
    }
  })

  it('rejects object responses without ETags', async () => {
    const fixture = releaseFixture()
    const outputDir = await mkdtemp(join(tmpdir(), 'regesta-mirror-test-'))

    try {
      const result = await mirrorRegistry({
        fetch: mirrorFetch(fixture, {
          objectEtags: new Map([[fixture.manifest.source.digest, null]]),
        }),
        outputDir,
        registry: 'https://registry.example',
      })

      expect(result.ok).toBe(false)
      expect(result.problems).toEqual([
        `Mirror object request failed: Missing object ETag header: ${fixture.manifest.source.digest}`,
      ])
    } finally {
      await rm(outputDir, { force: true, recursive: true })
    }
  })

  it('rejects object responses whose ETag does not match the digest', async () => {
    const fixture = releaseFixture()
    const outputDir = await mkdtemp(join(tmpdir(), 'regesta-mirror-test-'))

    try {
      const result = await mirrorRegistry({
        fetch: mirrorFetch(fixture, {
          objectEtags: new Map([
            [
              fixture.manifest.source.digest,
              `"${sha256(bytes('different object'))}"`,
            ],
          ]),
        }),
        outputDir,
        registry: 'https://registry.example',
      })

      expect(result.ok).toBe(false)
      expect(result.problems).toEqual([
        `Mirror object request failed: Object ETag does not match digest: ${fixture.manifest.source.digest}`,
      ])
    } finally {
      await rm(outputDir, { force: true, recursive: true })
    }
  })

  it('rejects object responses whose ETag is weak', async () => {
    const fixture = releaseFixture()
    const outputDir = await mkdtemp(join(tmpdir(), 'regesta-mirror-test-'))

    try {
      const result = await mirrorRegistry({
        fetch: mirrorFetch(fixture, {
          objectEtags: new Map([
            [
              fixture.manifest.source.digest,
              `W/"${fixture.manifest.source.digest}"`,
            ],
          ]),
        }),
        outputDir,
        registry: 'https://registry.example/',
      })

      expect(result.ok).toBe(false)
      expect(result.problems).toEqual([
        `Mirror object request failed: Object ETag does not match digest: ${fixture.manifest.source.digest}`,
      ])
    } finally {
      await rm(outputDir, { force: true, recursive: true })
    }
  })

  it('rejects event log pages without ETags', async () => {
    const fixture = releaseFixture()
    const outputDir = await mkdtemp(join(tmpdir(), 'regesta-mirror-test-'))

    try {
      const result = await mirrorRegistry({
        fetch: mirrorFetch(fixture, {
          eventPageEtag: null,
        }),
        outputDir,
        registry: 'https://registry.example',
      })

      expect(result.ok).toBe(false)
      expect(result.problems).toEqual([
        'Mirror event log response is missing ETag',
      ])
    } finally {
      await rm(outputDir, { force: true, recursive: true })
    }
  })

  it('rejects event log pages whose ETag does not match the cursor', async () => {
    const fixture = releaseFixture()
    const outputDir = await mkdtemp(join(tmpdir(), 'regesta-mirror-test-'))

    try {
      const result = await mirrorRegistry({
        fetch: mirrorFetch(fixture, {
          eventPageEtag: `W/"regesta.event-log:${sha256(bytes('other'))}:1"`,
        }),
        outputDir,
        registry: 'https://registry.example',
      })

      expect(result.ok).toBe(false)
      expect(result.problems).toEqual([
        'Mirror event log response ETag does not match page cursor',
      ])
    } finally {
      await rm(outputDir, { force: true, recursive: true })
    }
  })

  it('rejects event log pages without no-cache Cache-Control', async () => {
    const fixture = releaseFixture()
    const outputDir = await mkdtemp(join(tmpdir(), 'regesta-mirror-test-'))

    try {
      const result = await mirrorRegistry({
        fetch: mirrorFetch(fixture, {
          eventPageCacheControl: 'public, max-age=60',
        }),
        outputDir,
        registry: 'https://registry.example',
      })

      expect(result.ok).toBe(false)
      expect(result.problems).toEqual([
        'Mirror event log response Cache-Control must include no-cache',
      ])
    } finally {
      await rm(outputDir, { force: true, recursive: true })
    }
  })

  it('does not accept no-cache as an event log Cache-Control substring', async () => {
    const fixture = releaseFixture()
    const outputDir = await mkdtemp(join(tmpdir(), 'regesta-mirror-test-'))

    try {
      const result = await mirrorRegistry({
        fetch: mirrorFetch(fixture, {
          eventPageCacheControl: 'public, max-age=60, no-cacheable',
        }),
        outputDir,
        registry: 'https://registry.example',
      })

      expect(result.ok).toBe(false)
      expect(result.problems).toEqual([
        'Mirror event log response Cache-Control must include no-cache',
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

  it('rejects object inventory pages without no-cache Cache-Control', async () => {
    const fixture = releaseFixture()
    const outputDir = await mkdtemp(join(tmpdir(), 'regesta-mirror-test-'))

    try {
      const result = await mirrorRegistry({
        fetch: mirrorFetch(fixture, {
          objectInventoryCacheControl: 'public, max-age=60',
        }),
        outputDir,
        registry: 'https://registry.example',
      })

      expect(result.ok).toBe(false)
      expect(result.problems).toEqual([
        'Mirror object inventory response Cache-Control must include no-cache',
      ])
    } finally {
      await rm(outputDir, { force: true, recursive: true })
    }
  })

  it('does not accept no-cache as an object inventory Cache-Control substring', async () => {
    const fixture = releaseFixture()
    const outputDir = await mkdtemp(join(tmpdir(), 'regesta-mirror-test-'))

    try {
      const result = await mirrorRegistry({
        fetch: mirrorFetch(fixture, {
          objectInventoryCacheControl: 'public, max-age=60, no-cacheable',
        }),
        outputDir,
        registry: 'https://registry.example',
      })

      expect(result.ok).toBe(false)
      expect(result.problems).toEqual([
        'Mirror object inventory response Cache-Control must include no-cache',
      ])
    } finally {
      await rm(outputDir, { force: true, recursive: true })
    }
  })

  it('rejects object inventory pages without ETags', async () => {
    const fixture = releaseFixture()
    const outputDir = await mkdtemp(join(tmpdir(), 'regesta-mirror-test-'))

    try {
      const result = await mirrorRegistry({
        fetch: mirrorFetch(fixture, {
          objectInventoryEtag: null,
        }),
        outputDir,
        registry: 'https://registry.example',
      })

      expect(result.ok).toBe(false)
      expect(result.problems).toEqual([
        'Mirror object inventory response is missing ETag',
      ])
    } finally {
      await rm(outputDir, { force: true, recursive: true })
    }
  })

  it('rejects object inventory pages whose ETag does not match the cursor', async () => {
    const fixture = releaseFixture()
    const outputDir = await mkdtemp(join(tmpdir(), 'regesta-mirror-test-'))

    try {
      const result = await mirrorRegistry({
        fetch: mirrorFetch(fixture, {
          objectInventoryEtag: `W/"regesta.object-inventory:${sha256(
            bytes('other'),
          )}:4"`,
        }),
        outputDir,
        registry: 'https://registry.example',
      })

      expect(result.ok).toBe(false)
      expect(result.problems).toEqual([
        'Mirror object inventory response ETag does not match page cursor',
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
        'Mirror JSON request failed: Mirror release manifestDescriptor digest must match canonical manifest',
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

  it('rejects release envelopes with unknown fields', async () => {
    const fixture = releaseFixture()
    const outputDir = await mkdtemp(join(tmpdir(), 'regesta-mirror-test-'))

    try {
      const result = await mirrorRegistry({
        fetch: mirrorFetch(fixture, {
          releaseEnvelope: {
            ...fixture.releaseEnvelope,
            operatorHint: 'not a protocol field',
          },
        }),
        outputDir,
        registry: 'https://registry.example',
      })

      expect(result.ok).toBe(false)
      expect(result.problems).toEqual([
        'Mirror JSON request failed: Mirror release response must not include unknown field: operatorHint',
      ])
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

  it('rejects object inventory JSON responses without Content-Length', async () => {
    const fixture = releaseFixture()
    const outputDir = await mkdtemp(join(tmpdir(), 'regesta-mirror-test-'))

    try {
      const result = await mirrorRegistry({
        fetch: mirrorFetch(fixture, {
          omitObjectInventoryContentLength: true,
        }),
        outputDir,
        registry: 'https://registry.example',
      })

      expect(result.ok).toBe(false)
      expect(result.problems).toEqual([
        'Mirror JSON request failed: Missing JSON Content-Length header: https://registry.example/objects?limit=999',
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

  it('rejects immutable event endpoint responses without Content-Length', async () => {
    const fixture = releaseFixture()
    const outputDir = await mkdtemp(join(tmpdir(), 'regesta-mirror-test-'))

    try {
      const result = await mirrorRegistry({
        fetch: mirrorFetch(fixture, {
          omitEventEndpointContentLength: true,
        }),
        outputDir,
        registry: 'https://registry.example',
      })

      expect(result.ok).toBe(false)
      expect(result.problems).toEqual([
        `Mirror JSON request failed: Missing canonical JSON Content-Length header: https://registry.example${eventRoute(fixture.event.id)}`,
      ])
    } finally {
      await rm(outputDir, { force: true, recursive: true })
    }
  })

  it('rejects immutable release envelope responses without Content-Length', async () => {
    const fixture = releaseFixture()
    const outputDir = await mkdtemp(join(tmpdir(), 'regesta-mirror-test-'))

    try {
      const result = await mirrorRegistry({
        fetch: mirrorFetch(fixture, {
          omitReleaseEnvelopeContentLength: true,
        }),
        outputDir,
        registry: 'https://registry.example',
      })

      expect(result.ok).toBe(false)
      expect(result.problems).toEqual([
        `Mirror JSON request failed: Missing canonical JSON Content-Length header: https://registry.example/packages/${encodeURIComponent(
          fixture.manifest.id,
        )}/releases/${fixture.manifest.version}`,
      ])
    } finally {
      await rm(outputDir, { force: true, recursive: true })
    }
  })

  it('rejects immutable event endpoint responses without immutable Cache-Control', async () => {
    const fixture = releaseFixture()
    const outputDir = await mkdtemp(join(tmpdir(), 'regesta-mirror-test-'))

    try {
      const result = await mirrorRegistry({
        fetch: mirrorFetch(fixture, {
          eventEndpointCacheControl: 'public, max-age=60',
        }),
        outputDir,
        registry: 'https://registry.example',
      })

      expect(result.ok).toBe(false)
      expect(result.problems).toEqual([
        `Mirror JSON request failed: Immutable JSON Cache-Control must include immutable: https://registry.example${eventRoute(
          fixture.event.id,
        )}`,
      ])
    } finally {
      await rm(outputDir, { force: true, recursive: true })
    }
  })

  it('rejects immutable release envelope responses without immutable Cache-Control', async () => {
    const fixture = releaseFixture()
    const outputDir = await mkdtemp(join(tmpdir(), 'regesta-mirror-test-'))

    try {
      const result = await mirrorRegistry({
        fetch: mirrorFetch(fixture, {
          releaseEnvelopeCacheControl: 'public, max-age=60',
        }),
        outputDir,
        registry: 'https://registry.example',
      })

      expect(result.ok).toBe(false)
      expect(result.problems).toEqual([
        `Mirror JSON request failed: Immutable JSON Cache-Control must include immutable: https://registry.example/packages/${encodeURIComponent(
          fixture.manifest.id,
        )}/releases/${fixture.manifest.version}`,
      ])
    } finally {
      await rm(outputDir, { force: true, recursive: true })
    }
  })

  it('does not accept immutable as an immutable release Cache-Control substring', async () => {
    const fixture = releaseFixture()
    const outputDir = await mkdtemp(join(tmpdir(), 'regesta-mirror-test-'))

    try {
      const result = await mirrorRegistry({
        fetch: mirrorFetch(fixture, {
          releaseEnvelopeCacheControl: 'public, max-age=60, not-immutable',
        }),
        outputDir,
        registry: 'https://registry.example',
      })

      expect(result.ok).toBe(false)
      expect(result.problems).toEqual([
        `Mirror JSON request failed: Immutable JSON Cache-Control must include immutable: https://registry.example/packages/${encodeURIComponent(
          fixture.manifest.id,
        )}/releases/${fixture.manifest.version}`,
      ])
    } finally {
      await rm(outputDir, { force: true, recursive: true })
    }
  })

  it('rejects immutable event endpoint responses without ETags', async () => {
    const fixture = releaseFixture()
    const outputDir = await mkdtemp(join(tmpdir(), 'regesta-mirror-test-'))

    try {
      const result = await mirrorRegistry({
        fetch: mirrorFetch(fixture, {
          eventEndpointEtag: null,
        }),
        outputDir,
        registry: 'https://registry.example',
      })

      expect(result.ok).toBe(false)
      expect(result.problems).toEqual([
        `Mirror JSON request failed: Mirror event endpoint is missing ETag: https://registry.example${eventRoute(fixture.event.id)}`,
      ])
    } finally {
      await rm(outputDir, { force: true, recursive: true })
    }
  })

  it('rejects immutable release envelope responses without ETags', async () => {
    const fixture = releaseFixture()
    const outputDir = await mkdtemp(join(tmpdir(), 'regesta-mirror-test-'))

    try {
      const result = await mirrorRegistry({
        fetch: mirrorFetch(fixture, {
          releaseEnvelopeEtag: null,
        }),
        outputDir,
        registry: 'https://registry.example',
      })

      expect(result.ok).toBe(false)
      expect(result.problems).toEqual([
        `Mirror JSON request failed: Mirror release response is missing ETag: https://registry.example/packages/${encodeURIComponent(
          fixture.manifest.id,
        )}/releases/${fixture.manifest.version}`,
      ])
    } finally {
      await rm(outputDir, { force: true, recursive: true })
    }
  })

  it('rejects immutable release envelope responses whose ETag does not match the event id', async () => {
    const fixture = releaseFixture()
    const outputDir = await mkdtemp(join(tmpdir(), 'regesta-mirror-test-'))

    try {
      const result = await mirrorRegistry({
        fetch: mirrorFetch(fixture, {
          releaseEnvelopeEtag: `"${sha256(bytes('other event'))}"`,
        }),
        outputDir,
        registry: 'https://registry.example',
      })

      expect(result.ok).toBe(false)
      expect(result.problems).toEqual([
        `Mirror JSON request failed: Mirror release response ETag does not match event id: https://registry.example/packages/${encodeURIComponent(
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

  it('reports recorded local mirror inventory problems', async () => {
    const fixture = releaseFixture()
    const leftDir = await mirroredDirectory(fixture)
    const rightDir = await mirroredDirectory(fixture)

    try {
      const inventory = await readInventory(join(rightDir, 'inventory.json'))
      await writeFile(
        join(rightDir, 'inventory.json'),
        `${canonicalJson({
          ...inventory,
          ok: false,
          problems: ['Mirror stopped before reaching object inventory tail'],
        })}\n`,
      )

      const result = await compareMirrorDirectories({ leftDir, rightDir })

      expect(result.ok).toBe(false)
      expect(result.problems).toEqual([
        'Right mirror inventory recorded problem: Mirror stopped before reaching object inventory tail',
      ])
      expect(result.right.ok).toBe(false)
      expect(result.right.problems).toEqual([
        'Mirror stopped before reaching object inventory tail',
      ])
    } finally {
      await rm(leftDir, { force: true, recursive: true })
      await rm(rightDir, { force: true, recursive: true })
    }
  })

  it('reports package inventories that do not match event files', async () => {
    const fixture = releaseFixture()
    const leftDir = await mirroredDirectory(fixture)
    const rightDir = await mirroredDirectory(fixture)

    try {
      for (const directory of [leftDir, rightDir]) {
        const inventory = await readInventory(join(directory, 'inventory.json'))
        await writeFile(
          join(directory, 'inventory.json'),
          `${canonicalJson({
            ...inventory,
            packages: [],
          })}\n`,
        )
      }

      const result = await compareMirrorDirectories({ leftDir, rightDir })

      expect(result.ok).toBe(false)
      expect(result.problems).toEqual([
        'Left mirror package inventory length differs from event files: inventory 0, events 1',
        'Right mirror package inventory length differs from event files: inventory 0, events 1',
      ])
    } finally {
      await rm(leftDir, { force: true, recursive: true })
      await rm(rightDir, { force: true, recursive: true })
    }
  })

  it('reports release inventories that do not match event files', async () => {
    const fixture = releaseFixture()
    const leftDir = await mirroredDirectory(fixture)
    const rightDir = await mirroredDirectory(fixture)

    try {
      for (const directory of [leftDir, rightDir]) {
        const inventory = await readInventory(join(directory, 'inventory.json'))
        await writeFile(
          join(directory, 'inventory.json'),
          `${canonicalJson({
            ...inventory,
            releases: [],
          })}\n`,
        )
      }

      const result = await compareMirrorDirectories({ leftDir, rightDir })

      expect(result.ok).toBe(false)
      expect(result.problems).toEqual([
        'Left mirror release inventory length differs from event files: inventory 0, events 1',
        'Right mirror release inventory length differs from event files: inventory 0, events 1',
      ])
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

  it('rejects successful local mirror inventories with recorded problems', async () => {
    const fixture = releaseFixture()
    const leftDir = await mirroredDirectory(fixture)
    const rightDir = await mirroredDirectory(fixture)

    try {
      const inventory = await readInventory(join(rightDir, 'inventory.json'))
      await writeFile(
        join(rightDir, 'inventory.json'),
        `${canonicalJson({
          ...inventory,
          ok: true,
          problems: ['tampered problem'],
        })}\n`,
      )

      const result = await compareMirrorDirectories({ leftDir, rightDir })

      expect(result.ok).toBe(false)
      expect(result.problems).toEqual([
        'Right mirror inventory read failed: Right mirror inventory ok must match problems',
      ])
    } finally {
      await rm(leftDir, { force: true, recursive: true })
      await rm(rightDir, { force: true, recursive: true })
    }
  })

  it('rejects failed local mirror inventories without recorded problems', async () => {
    const fixture = releaseFixture()
    const leftDir = await mirroredDirectory(fixture)
    const rightDir = await mirroredDirectory(fixture)

    try {
      const inventory = await readInventory(join(rightDir, 'inventory.json'))
      await writeFile(
        join(rightDir, 'inventory.json'),
        `${canonicalJson({
          ...inventory,
          ok: false,
          problems: [],
        })}\n`,
      )

      const result = await compareMirrorDirectories({ leftDir, rightDir })

      expect(result.ok).toBe(false)
      expect(result.problems).toEqual([
        'Right mirror inventory read failed: Right mirror inventory ok must match problems',
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

  it('reports local event files whose id no longer matches their path', async () => {
    const fixture = releaseFixture()
    const leftDir = await mirroredDirectory(fixture)
    const rightDir = await mirroredDirectory(fixture)

    try {
      const { id: _id, ...payload } = fixture.event
      const tamperedPayload = {
        ...payload,
        channel: 'beta',
      }
      const tamperedEvent = {
        ...tamperedPayload,
        id: registryEventDigest(tamperedPayload),
      }
      await writeFile(
        eventPath(rightDir, fixture.event.id),
        `${canonicalJson(tamperedEvent)}\n`,
      )

      const result = await compareMirrorDirectories({ leftDir, rightDir })

      expect(result.ok).toBe(false)
      expect(result.problems).toContain(
        `Right mirror event file id does not match path: ${fixture.event.id}`,
      )
    } finally {
      await rm(leftDir, { force: true, recursive: true })
      await rm(rightDir, { force: true, recursive: true })
    }
  })

  it('reports local release files whose event is missing from the mirror', async () => {
    const fixture = releaseFixture()
    const leftDir = await mirroredDirectory(fixture)
    const rightDir = await mirroredDirectory(fixture)

    try {
      const { id: _id, ...payload } = fixture.event
      const tamperedPayload = {
        ...payload,
        channel: 'beta',
      }
      const tamperedEvent = {
        ...tamperedPayload,
        id: registryEventDigest(tamperedPayload),
      }
      await writeFile(
        releasePath(rightDir, fixture.manifest.id, fixture.manifest.version),
        `${canonicalJson({
          ...fixture.releaseEnvelope,
          event: tamperedEvent,
        })}\n`,
      )

      const result = await compareMirrorDirectories({ leftDir, rightDir })

      expect(result.ok).toBe(false)
      expect(result.problems).toEqual([
        `Right mirror release event is missing from mirror: ${fixture.manifest.id}@${fixture.manifest.version}`,
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
        `Right mirror release file read failed: ${fixture.manifest.id}@${fixture.manifest.version}: Mirror release manifestDescriptor digest must match canonical manifest`,
      ])
    } finally {
      await rm(leftDir, { force: true, recursive: true })
      await rm(rightDir, { force: true, recursive: true })
    }
  })
})

function releaseFixture(
  input: {
    artifactBytes?: Uint8Array
    artifactFilename?: string
    artifactFormat?: string
    artifactMediaType?: string
    ecosystem?: string
    id?: string
    name?: string
  } = {},
) {
  const sourceBytes = bytes('source archive')
  const artifactBytes = input.artifactBytes ?? bytes('install artifact')
  const extraObjectBytes = bytes('unreferenced public object')
  const source = objectDescriptor(
    sourceBytes,
    'application/vnd.regesta.source-archive+tgz',
  )
  const artifact = {
    ...objectDescriptor(
      artifactBytes,
      input.artifactMediaType ?? 'application/gzip',
    ),
    filename: input.artifactFilename ?? 'hello-regesta-1.0.0.tgz',
    format: input.artifactFormat ?? 'npm-tarball',
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
    ecosystem: input.ecosystem ?? 'npm',
    id: input.id ?? 'npm:example.com/hello-regesta',
    metadata: {
      description: 'Hello Regesta.',
    },
    name: input.name ?? 'example.com/hello-regesta',
    object: 'regesta.release-manifest',
    provenance: {
      level: 'source-attached',
      verified: false,
    },
    source,
    version: '1.0.0',
  }
  const manifestBytes = bytes(`${canonicalJson(manifest)}\n`)
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
    eventPageCacheControl?: string | null
    eventPageEtag?: string | null
    eventPageExtras?: Record<string, unknown>
    eventEndpointCacheControl?: string | null
    eventEndpointEtag?: string | null
    eventEndpointText?: string
    omitEventEndpointContentLength?: boolean
    omitEventPageContentLength?: boolean
    objectInventoryCacheControl?: string | null
    objectInventoryEtag?: string | null
    objectAcceptRanges?: ReadonlyMap<string, string | null>
    objectCacheControls?: ReadonlyMap<string, string>
    objectEtags?: ReadonlyMap<string, string | null>
    objectMediaTypes?: ReadonlyMap<string, string>
    objectOverrides?: ReadonlyMap<string, Uint8Array>
    omitObjectInventoryContentLength?: boolean
    releaseEnvelopeCacheControl?: string | null
    releaseEnvelopeEtag?: string | null
    releaseEnvelope?: unknown
    releaseEnvelopeText?: string
    omitReleaseEnvelopeContentLength?: boolean
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
    .map((object) => objectInventoryDescriptor(object.descriptor))
    .toSorted((left, right) => {
      return left.digest.localeCompare(right.digest)
    })

  return (input: RequestInfo | URL): Promise<Response> => {
    const url = new URL(String(input))

    if (url.pathname === '/events') {
      if (url.searchParams.has('after')) {
        return Promise.resolve(
          eventLogPageResponse(
            {
              events: [],
              ...(options.emptyEventPageNextAfter
                ? { nextAfter: options.emptyEventPageNextAfter }
                : {}),
            },
            url,
            {
              cacheControl: options.eventPageCacheControl,
              etag: options.eventPageEtag,
            },
          ),
        )
      }

      const events = options.duplicateEventPage
        ? [fixture.event, fixture.event]
        : [fixture.event]

      return Promise.resolve(
        eventLogPageResponse(
          {
            events,
            ...options.eventPageExtras,
            nextAfter: fixture.event.id,
          },
          url,
          {
            cacheControl: options.eventPageCacheControl,
            etag: options.eventPageEtag,
            omitContentLength: options.omitEventPageContentLength,
          },
        ),
      )
    }

    if (url.pathname === eventRoute(fixture.event.id)) {
      const etag =
        options.eventEndpointEtag === undefined
          ? `"${fixture.event.id}"`
          : options.eventEndpointEtag

      return Promise.resolve(
        options.eventEndpointText
          ? rawCanonicalJsonResponse(options.eventEndpointText, etag, {
              cacheControl: options.eventEndpointCacheControl,
              omitContentLength: options.omitEventEndpointContentLength,
            })
          : canonicalJsonResponse(fixture.event, etag, {
              cacheControl: options.eventEndpointCacheControl,
              omitContentLength: options.omitEventEndpointContentLength,
            }),
      )
    }

    if (
      url.pathname ===
      `/packages/${encodeURIComponent(
        fixture.manifest.id,
      )}/releases/${fixture.manifest.version}`
    ) {
      const etag =
        options.releaseEnvelopeEtag === undefined
          ? `W/"${fixture.event.id}"`
          : options.releaseEnvelopeEtag

      return Promise.resolve(
        options.releaseEnvelopeText
          ? rawCanonicalJsonResponse(options.releaseEnvelopeText, etag, {
              cacheControl: options.releaseEnvelopeCacheControl,
              omitContentLength: options.omitReleaseEnvelopeContentLength,
            })
          : canonicalJsonResponse(
              options.releaseEnvelope ?? fixture.releaseEnvelope,
              etag,
              {
                cacheControl: options.releaseEnvelopeCacheControl,
                omitContentLength: options.omitReleaseEnvelopeContentLength,
              },
            ),
      )
    }

    if (url.pathname === '/objects') {
      if (
        url.searchParams.has('after') &&
        options.emptyObjectInventoryNextAfter
      ) {
        return Promise.resolve(
          objectInventoryPageResponse(
            {
              nextAfter: options.emptyObjectInventoryNextAfter,
              object: 'regesta.object-inventory',
              objects: [],
            },
            url,
            {
              cacheControl: options.objectInventoryCacheControl,
              etag: options.objectInventoryEtag,
            },
          ),
        )
      }

      return Promise.resolve(
        objectInventoryResponse(
          options.reverseObjectInventory
            ? descriptors.toReversed()
            : descriptors,
          url,
          {
            cacheControl: options.objectInventoryCacheControl,
            etag: options.objectInventoryEtag,
            omitContentLength: options.omitObjectInventoryContentLength,
          },
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
          options.objectEtags?.has(object.descriptor.digest)
            ? options.objectEtags.get(object.descriptor.digest)
            : `"${object.descriptor.digest}"`,
          options.objectAcceptRanges?.has(object.descriptor.digest)
            ? options.objectAcceptRanges.get(object.descriptor.digest)
            : 'bytes',
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

function objectInventoryDescriptor(
  descriptor: ReturnType<typeof objectDescriptor>,
) {
  return {
    digest: descriptor.digest,
    mediaType: descriptor.mediaType,
    size: descriptor.size,
  }
}

function jsonResponse(
  value: unknown,
  options: { headers?: HeadersInit; omitContentLength?: boolean } = {},
): Response {
  const body = canonicalJson(value)
  const headers = new Headers(options.headers)
  if (!headers.has('content-type')) {
    headers.set('content-type', 'application/json')
  }

  if (!options.omitContentLength) {
    headers.set('content-length', String(bytes(body).byteLength))
  }

  return new Response(body, {
    headers,
  })
}

function eventLogPageResponse(
  page: { events: unknown[]; nextAfter?: string },
  url: URL,
  options: {
    cacheControl?: string | null
    etag?: string | null
    omitContentLength?: boolean
  } = {},
): Response {
  return jsonResponse(page, {
    headers: mutablePageHeaders(
      'regesta.event-log',
      page.nextAfter,
      url.searchParams.get('after'),
      page.events.length,
      options,
    ),
    omitContentLength: options.omitContentLength,
  })
}

function canonicalJsonResponse(
  value: unknown,
  etag?: string | null,
  options: { cacheControl?: string | null; omitContentLength?: boolean } = {},
): Response {
  return rawCanonicalJsonResponse(`${canonicalJson(value)}\n`, etag, options)
}

function rawCanonicalJsonResponse(
  body: string,
  etag?: string | null,
  options: { cacheControl?: string | null; omitContentLength?: boolean } = {},
): Response {
  const headers = new Headers({
    'content-type': 'application/json',
  })

  if (options.cacheControl === undefined) {
    headers.set('cache-control', 'public, max-age=31536000, immutable')
  } else if (options.cacheControl !== null) {
    headers.set('cache-control', options.cacheControl)
  }

  if (!options.omitContentLength) {
    headers.set('content-length', String(bytes(body).byteLength))
  }

  if (etag !== undefined && etag !== null) {
    headers.set('etag', etag)
  }

  return new Response(body, { headers })
}

function objectInventoryResponse(
  descriptors: ReturnType<typeof objectDescriptor>[],
  url: URL,
  options: {
    cacheControl?: string | null
    etag?: string | null
    omitContentLength?: boolean
  } = {},
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

  return objectInventoryPageResponse(
    {
      ...(lastObject ? { nextAfter: lastObject.digest } : {}),
      object: 'regesta.object-inventory',
      objects,
    },
    url,
    options,
  )
}

function objectInventoryPageResponse(
  page: {
    nextAfter?: string
    object: 'regesta.object-inventory'
    objects: unknown[]
  },
  url: URL,
  options: {
    cacheControl?: string | null
    etag?: string | null
    omitContentLength?: boolean
  } = {},
): Response {
  return jsonResponse(page, {
    headers: mutablePageHeaders(
      'regesta.object-inventory',
      page.nextAfter,
      url.searchParams.get('after'),
      page.objects.length,
      options,
    ),
    omitContentLength: options.omitContentLength,
  })
}

function mutablePageHeaders(
  prefix: string,
  nextAfter: string | undefined,
  after: string | null,
  itemCount: number,
  options: {
    cacheControl?: string | null
    etag?: string | null
  },
): Headers {
  const validator = nextAfter ?? after ?? 'head'
  const headers = new Headers()

  if (options.cacheControl === undefined) {
    headers.set('cache-control', 'no-cache')
  } else if (options.cacheControl !== null) {
    headers.set('cache-control', options.cacheControl)
  }

  if (options.etag === undefined) {
    headers.set('etag', `W/"${prefix}:${validator}:${itemCount}"`)
  } else if (options.etag !== null) {
    headers.set('etag', options.etag)
  }

  return headers
}

function binaryResponse(
  bytes: Uint8Array,
  mediaType: string,
  cacheControl = 'public, max-age=31536000, immutable',
  etag: string | null | undefined,
  acceptRanges: string | null | undefined,
): Response {
  const headers = new Headers({
    'cache-control': cacheControl,
    'content-length': String(bytes.byteLength),
    'content-type': mediaType,
  })

  if (etag !== null && etag !== undefined) {
    headers.set('etag', etag)
  }
  if (acceptRanges !== null && acceptRanges !== undefined) {
    headers.set('accept-ranges', acceptRanges)
  }

  return new Response(bytes, { headers })
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
