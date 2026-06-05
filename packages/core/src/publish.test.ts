import { createMemoryRegistryAdapters } from '@regesta/adapters'
import { describe, expect, it } from 'vitest'
import { getPackageState, updatePackageChannel } from './channels.ts'
import { publishRelease, type PublishInput } from './publish.ts'
import { verifyRelease } from './verify.ts'

describe('publishRelease', () => {
  it('publishes and verifies one tarball-backed package', async () => {
    const adapters = createMemoryRegistryAdapters()

    const result = await publishRelease(
      {
        ...createPublishInput(),
        createdAt: '2026-06-01T00:00:00.000Z',
      },
      adapters,
    )

    const verification = await verifyRelease(
      adapters,
      'npm:@example.com/hello-regesta',
      '0.0.1',
    )
    const state = await getPackageState(
      adapters,
      'npm:@example.com/hello-regesta',
    )

    expect(result.channel).toBe('latest')
    expect(result.manifest.id).toBe('npm:@example.com/hello-regesta')
    expect(result.manifest.ecosystem).toBe('npm')
    expect(result.manifest.name).toBe('@example.com/hello-regesta')
    expect(result.manifest.object).toBe('regesta.release-manifest')
    expect(result.manifest.specVersion).toBe(0)
    expect(result.manifest.artifacts).toEqual([
      expect.objectContaining({
        ecosystem: 'npm',
        format: 'npm-tarball',
        mediaType: 'application/gzip',
        role: 'install',
      }),
    ])
    expect(result.manifest.metadata?.exports).toEqual({
      '.': './src/index.ts',
    })
    expect('dependencies' in result.manifest).toBe(false)
    expect(result.manifest.ecosystemMetadata).toBeUndefined()
    expect(result.manifest.provenance).toEqual({
      level: 'source-attached',
      verified: false,
    })
    expect(result.manifest.compatibility).toEqual({
      modules: ['esm'],
      runtimes: ['node', 'bun'],
    })
    expect(state.channels).toEqual({ latest: '0.0.1' })
    expect(verification.ok).toBe(true)
  })

  it('maps package channels without changing releases', async () => {
    const adapters = createMemoryRegistryAdapters()

    await publishRelease(
      {
        ...createPublishInput(),
        createdAt: '2026-06-01T00:00:00.000Z',
      },
      adapters,
    )
    const update = await updatePackageChannel(adapters, {
      channel: 'beta',
      packageId: 'npm:@example.com/hello-regesta',
      timestamp: '2026-06-01T00:01:00.000Z',
      version: '0.0.1',
    })
    const state = await getPackageState(
      adapters,
      'npm:@example.com/hello-regesta',
    )

    expect(update.event.eventType).toBe('channel.updated')
    expect(state.channels).toEqual({ beta: '0.0.1', latest: '0.0.1' })
    expect(state.releases).toEqual([
      expect.objectContaining({
        createdAt: '2026-06-01T00:00:00.000Z',
        version: '0.0.1',
      }),
    ])
  })

  it('rejects release manifests that claim trusted build verification in v0', async () => {
    const adapters = createMemoryRegistryAdapters()

    await publishRelease(
      {
        ...createPublishInput(),
        createdAt: '2026-06-01T00:00:00.000Z',
      },
      adapters,
    )

    const release = await adapters.database.getRelease(
      'npm:@example.com/hello-regesta',
      '0.0.1',
    )

    Object.assign(release!.manifest, {
      provenance: {
        level: 'trusted-builder',
        verified: true,
      },
    })

    const verification = await verifyRelease(
      adapters,
      'npm:@example.com/hello-regesta',
      '0.0.1',
    )

    expect(verification.ok).toBe(false)
    expect(verification.problems).toContain(
      'Release provenance must be source-attached',
    )
    expect(verification.problems).toContain(
      'V0 release provenance must not claim verified build status',
    )
  })
})

function createPublishInput(): PublishInput {
  return {
    artifacts: [
      {
        bytes: bytes('install artifact'),
        ecosystem: 'npm',
        format: 'npm-tarball',
        mediaType: 'application/gzip',
        role: 'install',
      },
    ],
    config: {
      compatibility: {
        modules: ['esm'],
        runtimes: ['node', 'bun'],
      },
      description: 'Test package',
      exports: {
        '.': './src/index.ts',
      },
      id: 'npm:@example.com/hello-regesta',
      languages: ['typescript'],
      provenance: {
        level: 'source-attached',
      },
      source: {
        include: ['regesta.json'],
      },
      version: '0.0.1',
    },
    source: bytes('source archive'),
  }
}

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value)
}
