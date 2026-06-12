import { describe, expect, it } from 'vitest'
import { regestaAppOptionsFromRuntimeOptions } from './runtime-app-options.ts'
import type { ProcessPublishArtifactsInput } from './app.ts'

describe('regestaAppOptionsFromRuntimeOptions', () => {
  it('passes runtime app options through without deployment-only switches', () => {
    expect(
      regestaAppOptionsFromRuntimeOptions({
        deploymentStatistics: {
          cacheTtlMs: 500,
        },
        npmArtifactProcessing: true,
        npmProjection: false,
        npmUpstream: {
          upstreamFallback: false,
          upstreamTimeoutMs: 350,
        },
        readiness: {
          timeoutMs: 400,
        },
      }),
    ).toEqual({
      deploymentStatistics: {
        cacheTtlMs: 500,
      },
      npmProjection: false,
      npmUpstream: {
        upstreamFallback: false,
        upstreamTimeoutMs: 350,
      },
      readiness: {
        timeoutMs: 400,
      },
    })
  })

  it('disables npm artifact processing with a no-op processor pipeline', async () => {
    const options = regestaAppOptionsFromRuntimeOptions({
      npmArtifactProcessing: false,
    })
    const input: ProcessPublishArtifactsInput = {
      artifacts: [
        {
          bytes: new Uint8Array([1, 2, 3]),
          mediaType: 'application/octet-stream',
          role: 'install',
        },
      ],
      config: {
        id: 'demo:example.com/raw',
        provenance: {
          level: 'source-attached',
        },
        source: {
          include: ['regesta.json'],
        },
        version: '0.0.1',
      },
    }

    expect(options.processPublishArtifacts).toBeTypeOf('function')
    if (!options.processPublishArtifacts) {
      throw new Error('Expected no-op publish artifact processor')
    }
    await expect(options.processPublishArtifacts(input)).resolves.toBe(input)
  })
})
