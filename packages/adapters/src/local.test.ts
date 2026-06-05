import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sha256, type RegistryEvent } from '@regesta/protocol'
import { describe, expect, it } from 'vitest'
import { createLocalRegistryAdapters } from './local.ts'
import type { StoredRelease } from './interfaces.ts'

describe('createLocalRegistryAdapters', () => {
  it('persists releases, channels, events, and objects across adapter instances', async () => {
    const root = await mkdtemp(join(tmpdir(), 'regesta-local-'))

    try {
      const firstAdapters = createLocalRegistryAdapters(root)
      const source = await firstAdapters.objects.put(
        bytes('source archive'),
        'application/vnd.regesta.source-archive+tgz',
      )
      const artifact = await firstAdapters.objects.put(
        bytes('install artifact'),
        'application/gzip',
      )
      const manifestDescriptor = await firstAdapters.objects.put(
        bytes('release manifest'),
        'application/vnd.regesta.release-manifest.v0+json',
      )
      const event: RegistryEvent = {
        artifactDigests: [artifact.digest],
        channel: 'latest',
        eventType: 'release.published',
        id: sha256(bytes('event')),
        object: 'regesta.event',
        release: {
          id: 'npm:example.com/persisted',
          manifestDigest: manifestDescriptor.digest,
          version: '0.0.1',
        },
        sourceDigest: source.digest,
        specVersion: 0,
        timestamp: '2026-06-01T00:00:00.000Z',
      }
      const release: StoredRelease = {
        event,
        manifest: {
          artifacts: [
            {
              ...artifact,
              format: 'test-tarball',
              role: 'install',
            },
          ],
          configDigest: sha256(bytes('config')),
          createdAt: '2026-06-01T00:00:00.000Z',
          ecosystem: 'npm',
          id: 'npm:example.com/persisted',
          name: 'example.com/persisted',
          object: 'regesta.release-manifest',
          provenance: {
            level: 'source-attached',
            verified: false,
          },
          source,
          specVersion: 0,
          version: '0.0.1',
        },
        manifestDescriptor,
      }

      await firstAdapters.database.putRelease(release)
      await firstAdapters.database.setPackageChannel(
        'npm:example.com/persisted',
        'latest',
        '0.0.1',
      )
      await firstAdapters.database.appendEvent(event)

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
        event,
      ])
      await expect(
        secondAdapters.objects.get(source.digest),
      ).resolves.toMatchObject({
        descriptor: source,
      })
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })
})

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value)
}
