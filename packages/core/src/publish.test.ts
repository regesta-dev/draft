import { Buffer } from 'node:buffer'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { createMemoryRegistryAdapters } from '@regesta/adapters'
import { describe, expect, it } from 'vitest'
import { createNpmPackument } from './packument.ts'
import { preparePublish, publishRelease } from './publish.ts'
import { verifyRelease } from './verify.ts'

describe('publishRelease', () => {
  it('uses an author-declared npm tarball artifact when configured', async () => {
    const projectDir = await createFixtureProject({
      artifactPath: 'dist/hello-regesta-0.0.1.tgz',
      artifactBytes: 'author-built artifact',
    })
    const prepared = await preparePublish(projectDir)

    expect(prepared.config.artifacts?.npmTarball?.path).toBe(
      'dist/hello-regesta-0.0.1.tgz',
    )
    expect(Buffer.from(prepared.npmTarballBase64, 'base64').toString()).toBe(
      'author-built artifact',
    )
  })

  it('publishes and verifies one source-native package', async () => {
    const projectDir = await createFixtureProject()
    const adapters = createMemoryRegistryAdapters()
    const prepared = await preparePublish(projectDir)

    const result = await publishRelease(
      {
        config: prepared.config,
        createdAt: '2026-06-01T00:00:00.000Z',
        npmTarball: Buffer.from(prepared.npmTarballBase64, 'base64'),
        sourceArchive: Buffer.from(prepared.sourceArchiveBase64, 'base64'),
      },
      adapters,
    )

    const verification = await verifyRelease(
      adapters,
      '@example.com/hello-regesta',
      '0.0.1',
    )
    const packument = createNpmPackument(
      '@example.com/hello-regesta',
      await adapters.database.listPackageReleases('@example.com/hello-regesta'),
      'http://localhost:4321',
    )

    expect(result.manifest.package).toBe('@example.com/hello-regesta')
    expect(result.manifest.metadata?.exports).toEqual({
      '.': './src/index.ts',
    })
    expect(result.manifest.provenance).toEqual({
      command: 'pnpm build && pnpm pack',
      level: 'declared-build',
      toolchain: {
        node: '24.x',
        pnpm: '11.x',
      },
      verified: false,
    })
    expect(result.manifest.compatibility).toEqual({
      packageManagers: ['npm', 'pnpm', 'yarn', 'bun'],
      runtimes: ['node', 'bun'],
    })
    expect(verification.ok).toBe(true)
    expect(packument.versions['0.0.1']?.dist.tarball).toBe(
      'http://localhost:4321/@example.com/hello-regesta/-/hello-regesta-0.0.1.tgz',
    )
  })

  it('rejects release manifests that claim trusted build verification in v0', async () => {
    const projectDir = await createFixtureProject()
    const adapters = createMemoryRegistryAdapters()
    const prepared = await preparePublish(projectDir)

    await publishRelease(
      {
        config: prepared.config,
        createdAt: '2026-06-01T00:00:00.000Z',
        npmTarball: Buffer.from(prepared.npmTarballBase64, 'base64'),
        sourceArchive: Buffer.from(prepared.sourceArchiveBase64, 'base64'),
      },
      adapters,
    )

    const release = await adapters.database.getRelease(
      '@example.com/hello-regesta',
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
      '@example.com/hello-regesta',
      '0.0.1',
    )

    expect(verification.ok).toBe(false)
    expect(verification.problems).toContain(
      'Release provenance must be source-attached or declared-build',
    )
    expect(verification.problems).toContain(
      'V0 release provenance must not claim verified build status',
    )
  })
})

interface FixtureProjectOptions {
  artifactBytes?: string
  artifactPath?: string
}

async function createFixtureProject(
  options: FixtureProjectOptions = {},
): Promise<string> {
  const root = join(
    process.cwd(),
    'node_modules',
    '.tmp-regesta-test',
    `${Date.now()}-${Math.random().toString(16).slice(2)}`,
  )
  await mkdir(join(root, 'src'), { recursive: true })
  await writeFile(join(root, 'README.md'), '# hello\n')
  await writeFile(join(root, 'src', 'index.ts'), 'export const value = 1\n')

  if (options.artifactPath && options.artifactBytes) {
    await mkdir(join(root, 'dist'), { recursive: true })
    await writeFile(join(root, options.artifactPath), options.artifactBytes)
  }

  await writeFile(
    join(root, 'package.json'),
    `${JSON.stringify(
      {
        exports: {
          '.': './src/index.ts',
        },
        name: '@example.com/hello-regesta',
        version: '0.0.1',
      },
      null,
      2,
    )}\n`,
  )
  await writeFile(
    join(root, 'regesta.json'),
    `${JSON.stringify(
      {
        description: 'Test package',
        compatibility: {
          packageManagers: ['npm', 'pnpm', 'yarn', 'bun'],
          runtimes: ['node', 'bun'],
        },
        provenance: {
          command: 'pnpm build && pnpm pack',
          level: 'declared-build',
          toolchain: {
            node: '24.x',
            pnpm: '11.x',
          },
        },
        ...(options.artifactPath
          ? {
              artifacts: {
                npmTarball: {
                  path: options.artifactPath,
                },
              },
            }
          : {}),
        source: {
          include: ['regesta.json', 'package.json', 'README.md', 'src'],
        },
        schema: 'regesta.config.v0',
      },
      null,
      2,
    )}\n`,
  )

  return root
}
