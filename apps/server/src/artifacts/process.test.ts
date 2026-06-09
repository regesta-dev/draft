import { execFile } from 'node:child_process'
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import {
  createPublishArtifactProcessor,
  processPublishArtifacts,
  type ProcessPublishArtifactsInput,
} from './process.ts'
import type { RegestaConfig } from '@regesta/protocol'

const execFileAsync = promisify(execFile)

describe('processPublishArtifacts', () => {
  it('returns unchanged input when no ecosystem processors are configured', async () => {
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
    const processor = createPublishArtifactProcessor([])

    await expect(processor(input)).resolves.toBe(input)
  })

  it('runs ecosystem processors in order and passes through their output', async () => {
    const calls: string[] = []
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
    const processor = createPublishArtifactProcessor([
      (current) => {
        calls.push(current.config.version)

        return {
          artifacts: current.artifacts,
          config: {
            ...current.config,
            description: 'First processor description',
          },
        }
      },
      (current) => {
        calls.push(current.config.description ?? 'missing')

        return {
          artifacts: current.artifacts.map((artifact) => ({
            ...artifact,
            ecosystemMetadata: {
              demo: {
                processed: true,
              },
            },
          })),
          config: current.config,
        }
      },
    ])

    await expect(processor(input)).resolves.toEqual({
      artifacts: [
        {
          bytes: new Uint8Array([1, 2, 3]),
          ecosystemMetadata: {
            demo: {
              processed: true,
            },
          },
          mediaType: 'application/octet-stream',
          role: 'install',
        },
      ],
      config: {
        ...input.config,
        description: 'First processor description',
      },
    })
    expect(calls).toEqual(['0.0.1', 'First processor description'])
  })

  it('leaves non-npm artifacts untouched without reading install bytes', async () => {
    const artifacts = [
      {
        bytes: new Uint8Array([1, 2, 3]),
        ecosystemMetadata: {
          cargo: {
            checksum: 'existing',
          },
        },
        mediaType: 'application/gzip',
        role: 'install',
      },
    ]

    await expect(
      processPublishArtifacts({
        artifacts,
        config: {
          id: 'cargo:example.com/hello-regesta',
          provenance: {
            level: 'source-attached',
          },
          source: {
            include: ['Cargo.toml', 'src'],
          },
          version: '0.0.1',
        },
      }),
    ).resolves.toEqual({
      artifacts,
      config: {
        id: 'cargo:example.com/hello-regesta',
        provenance: {
          level: 'source-attached',
        },
        source: {
          include: ['Cargo.toml', 'src'],
        },
        version: '0.0.1',
      },
    })
  })

  it('adds npm metadata and description without discarding existing artifact metadata', async () => {
    const tarball = await createNpmTarball()

    await expect(
      processPublishArtifacts({
        artifacts: [
          {
            bytes: tarball,
            ecosystemMetadata: {
              custom: {
                retained: true,
              },
            },
            mediaType: 'application/gzip',
            role: 'install',
          },
        ],
        config: npmConfig(),
      }),
    ).resolves.toEqual({
      artifacts: [
        expect.objectContaining({
          ecosystemMetadata: {
            custom: {
              retained: true,
            },
            npm: {
              dependencies: {
                '@example.com/base': '^1.0.0',
              },
            },
          },
        }),
      ],
      config: {
        ...npmConfig(),
        description: 'Fixture package',
      },
    })
  })

  it('keeps explicit config description over npm artifact description', async () => {
    const tarball = await createNpmTarball()
    const config = {
      ...npmConfig(),
      description: 'Explicit config description',
    }

    await expect(
      processPublishArtifacts({
        artifacts: [
          {
            bytes: tarball,
            mediaType: 'application/gzip',
            role: 'install',
          },
        ],
        config,
      }),
    ).resolves.toMatchObject({
      config: {
        description: 'Explicit config description',
      },
    })
  })
})

function npmConfig(): RegestaConfig {
  return {
    id: 'npm:example.com/hello-regesta',
    provenance: {
      level: 'source-attached',
    },
    source: {
      include: ['package.json'],
    },
    version: '0.0.1',
  }
}

async function createNpmTarball(): Promise<Uint8Array> {
  const projectDir = await mkdtemp(join(tmpdir(), 'regesta-artifact-test-'))
  const outputDir = join(projectDir, 'packed')

  try {
    await mkdir(outputDir)
    await writeFile(
      join(projectDir, 'package.json'),
      `${JSON.stringify(
        {
          dependencies: {
            '@example.com/base': '^1.0.0',
          },
          description: 'Fixture package',
          name: '@example.com/hello-regesta',
          version: '0.0.1',
        },
        null,
        2,
      )}\n`,
    )
    await execFileAsync('npm', ['pack', '--pack-destination', outputDir], {
      cwd: projectDir,
    })

    const tarball = (await readdir(outputDir)).find((file) =>
      file.endsWith('.tgz'),
    )
    if (!tarball) {
      throw new Error('npm pack did not produce a tarball')
    }

    return readFile(join(outputDir, tarball))
  } finally {
    await rm(projectDir, { force: true, recursive: true })
  }
}
