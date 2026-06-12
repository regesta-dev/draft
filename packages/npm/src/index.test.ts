import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  sha256,
  type RegestaConfig,
  type ReleaseManifest,
} from '@regesta/protocol'
import * as tar from 'tar'
import { describe, expect, it } from 'vitest'
import {
  createNpmPackument,
  npmPackageIdFromName,
  npmPackageName,
  processNpmPublishArtifacts,
  readNpmPackageManifestFromTarball,
} from './index.ts'

describe('npm package projection', () => {
  it('projects canonical package ids to native npm names', () => {
    expect(npmPackageName('npm:some.dev/sdk')).toBe('@some.dev/sdk')
  })

  it('rejects non-npm package ids before projection', () => {
    expect(() => npmPackageName('pypi:some.dev/sdk')).toThrow(
      'Package is not in the npm ecosystem',
    )
  })

  it('projects native npm names to canonical package ids', () => {
    expect(npmPackageIdFromName('@some.dev/sdk')).toBe('npm:some.dev/sdk')
  })

  it('rejects unscoped native npm names', () => {
    expect(() => npmPackageIdFromName('some-dev-sdk')).toThrow(
      'npm package name must be domain-scoped',
    )
  })

  it('rejects invalid package.json bytes as publish validation errors', async () => {
    await expect(
      readNpmPackageManifestFromTarball(await invalidPackageJsonTarball()),
    ).rejects.toThrow(TypeError)
    await expect(
      readNpmPackageManifestFromTarball(await invalidPackageJsonTarball()),
    ).rejects.toThrow('npm package.json must be valid JSON')
  })

  it('rejects malformed tarball bytes as publish validation errors', async () => {
    const brokenGzip = new Uint8Array([0x1f, 0x8b, 0x08, 0x00])

    await expect(readNpmPackageManifestFromTarball(brokenGzip)).rejects.toThrow(
      TypeError,
    )
    await expect(readNpmPackageManifestFromTarball(brokenGzip)).rejects.toThrow(
      'npm install artifact must be a readable tarball',
    )
  })

  it('requires npm publish artifacts to declare package name and version', async () => {
    await expect(
      processNpmPublishArtifacts(npmConfig(), [
        {
          bytes: await packageJsonTarball({
            version: '1.0.0',
          }),
          role: 'install',
        },
      ]),
    ).rejects.toThrow('npm package.json name is required')

    await expect(
      processNpmPublishArtifacts(npmConfig(), [
        {
          bytes: await packageJsonTarball({
            name: '@some.dev/sdk',
          }),
          role: 'install',
        },
      ]),
    ).rejects.toThrow('npm package.json version is required')
  })

  it('rejects release manifests that do not match the projected npm package', () => {
    expect(() =>
      createNpmPackument(
        'npm:some.dev/sdk',
        [
          {
            manifest: releaseManifest({
              ecosystem: 'pypi',
              id: 'pypi:some.dev/sdk',
            }),
          },
        ],
        'https://registry.test',
      ),
    ).toThrow(
      'Release manifest does not match npm package id: npm:some.dev/sdk',
    )
    expect(() =>
      createNpmPackument(
        'npm:some.dev/sdk',
        [
          {
            manifest: releaseManifest({
              id: 'npm:other.dev/sdk',
              name: 'other.dev/sdk',
            }),
          },
        ],
        'https://registry.test',
      ),
    ).toThrow(
      'Release manifest does not match npm package id: npm:some.dev/sdk',
    )
  })

  it('projects optional dependencies from npm artifact metadata', () => {
    expect(
      createNpmPackument(
        'npm:some.dev/sdk',
        [
          {
            manifest: releaseManifest({
              artifacts: [
                {
                  digest: sha256('artifact'),
                  ecosystemMetadata: {
                    npm: {
                      optionalDependencies: {
                        '@some.dev/optional': '^1.0.0',
                      },
                    },
                  },
                  mediaType: 'application/gzip',
                  role: 'install',
                  size: 8,
                },
              ],
            }),
          },
        ],
        'https://registry.test',
      ).versions,
    ).toMatchObject({
      '1.0.0': {
        optionalDependencies: {
          '@some.dev/optional': '^1.0.0',
        },
      },
    })
  })

  it('does not project unknown npm artifact metadata fields', () => {
    const packument = createNpmPackument(
      'npm:some.dev/sdk',
      [
        {
          manifest: releaseManifest({
            artifacts: [
              {
                digest: sha256('artifact'),
                ecosystemMetadata: {
                  npm: {
                    dependencies: {
                      '@some.dev/base': '^1.0.0',
                    },
                    scripts: {
                      postinstall: 'node install.js',
                    },
                  },
                },
                mediaType: 'application/gzip',
                role: 'install',
                size: 8,
              },
            ],
          }),
        },
      ],
      'https://registry.test',
    )

    expect(packument.versions['1.0.0']).toMatchObject({
      dependencies: {
        '@some.dev/base': '^1.0.0',
      },
    })
    expect(packument.versions['1.0.0']).not.toHaveProperty('scripts')
  })

  it('extracts and projects npm resolver metadata from install artifacts', async () => {
    const processing = await processNpmPublishArtifacts(npmConfig(), [
      {
        bytes: await packageJsonTarball({
          bin: {
            sdk: './bin/sdk.js',
          },
          bundledDependencies: ['@some.dev/bundled'],
          cpu: ['x64'],
          dependencies: {
            '@some.dev/base': '^1.0.0',
          },
          engines: {
            node: '>=24',
          },
          libc: ['glibc'],
          name: '@some.dev/sdk',
          os: ['linux'],
          peerDependencies: {
            '@some.dev/peer': '^2.0.0',
          },
          peerDependenciesMeta: {
            '@some.dev/peer': {
              optional: true,
            },
          },
          version: '1.0.0',
        }),
        role: 'install',
      },
    ])
    const ecosystemMetadata = processing?.ecosystemMetadata

    expect(ecosystemMetadata).toEqual({
      npm: {
        bin: {
          sdk: './bin/sdk.js',
        },
        bundledDependencies: ['@some.dev/bundled'],
        cpu: ['x64'],
        dependencies: {
          '@some.dev/base': '^1.0.0',
        },
        engines: {
          node: '>=24',
        },
        libc: ['glibc'],
        os: ['linux'],
        peerDependencies: {
          '@some.dev/peer': '^2.0.0',
        },
        peerDependenciesMeta: {
          '@some.dev/peer': {
            optional: true,
          },
        },
      },
    })

    if (!ecosystemMetadata) {
      throw new Error('Expected npm ecosystem metadata')
    }

    expect(
      createNpmPackument(
        'npm:some.dev/sdk',
        [
          {
            manifest: releaseManifest({
              artifacts: [
                {
                  digest: sha256('artifact'),
                  ecosystemMetadata,
                  mediaType: 'application/gzip',
                  role: 'install',
                  size: 8,
                },
              ],
            }),
          },
        ],
        'https://registry.test',
      ).versions['1.0.0'],
    ).toMatchObject({
      bin: {
        sdk: './bin/sdk.js',
      },
      bundledDependencies: ['@some.dev/bundled'],
      cpu: ['x64'],
      dependencies: {
        '@some.dev/base': '^1.0.0',
      },
      engines: {
        node: '>=24',
      },
      libc: ['glibc'],
      os: ['linux'],
      peerDependencies: {
        '@some.dev/peer': '^2.0.0',
      },
      peerDependenciesMeta: {
        '@some.dev/peer': {
          optional: true,
        },
      },
    })
  })

  it('projects core release description into npm metadata fields', () => {
    const packument = createNpmPackument(
      'npm:some.dev/sdk',
      [
        {
          manifest: releaseManifest({
            metadata: {
              description: 'Example SDK',
            },
          }),
        },
      ],
      'https://registry.test',
    )

    expect(packument.description).toBe('Example SDK')
    expect(packument.versions['1.0.0']?.description).toBe('Example SDK')
  })

  it('projects defined empty core release descriptions', () => {
    const packument = createNpmPackument(
      'npm:some.dev/sdk',
      [
        {
          manifest: releaseManifest({
            metadata: {
              description: '',
            },
          }),
        },
      ],
      'https://registry.test',
    )

    expect(packument).toHaveProperty('description', '')
    expect(packument.versions['1.0.0']).toHaveProperty('description', '')
  })

  it('does not project npm dist-tags that point at missing releases', () => {
    const packument = createNpmPackument(
      'npm:some.dev/sdk',
      [
        {
          manifest: releaseManifest({
            version: '1.0.0',
          }),
        },
      ],
      'https://registry.test',
      {
        beta: '2.0.0',
        latest: '1.0.0',
      },
    )

    expect(packument['dist-tags']).toEqual({
      latest: '1.0.0',
    })
  })

  it('falls back to the newest release when all npm dist-tags are stale', () => {
    const packument = createNpmPackument(
      'npm:some.dev/sdk',
      [
        {
          manifest: releaseManifest({
            createdAt: '2026-06-01T00:00:00.000Z',
            version: '1.0.0',
          }),
        },
        {
          manifest: releaseManifest({
            createdAt: '2026-06-02T00:00:00.000Z',
            version: '1.1.0',
          }),
        },
      ],
      'https://registry.test',
      {
        beta: '2.0.0',
        latest: '2.0.0',
      },
    )

    expect(packument['dist-tags']).toEqual({
      latest: '1.1.0',
    })
  })

  it('orders packument releases deterministically when timestamps match', () => {
    const packument = createNpmPackument(
      'npm:some.dev/sdk',
      [
        {
          manifest: releaseManifest({
            createdAt: '2026-06-01T00:00:00.000Z',
            version: '2.0.0',
          }),
        },
        {
          manifest: releaseManifest({
            createdAt: '2026-06-01T00:00:00.000Z',
            version: '1.0.0',
          }),
        },
      ],
      'https://registry.test',
      {
        latest: '9.9.9',
      },
    )

    expect(Object.keys(packument.versions)).toEqual(['1.0.0', '2.0.0'])
    expect(packument['dist-tags']).toEqual({
      latest: '2.0.0',
    })
    expect(packument.time).toMatchObject({
      '1.0.0': '2026-06-01T00:00:00.000Z',
      '2.0.0': '2026-06-01T00:00:00.000Z',
      created: '2026-06-01T00:00:00.000Z',
      modified: '2026-06-01T00:00:00.000Z',
    })
  })

  it('extracts npm dev dependencies as npm artifact metadata', async () => {
    await expect(
      processNpmPublishArtifacts(npmConfig(), [
        {
          bytes: await packageJsonTarball({
            devDependencies: {
              '@some.dev/test-helper': '^1.0.0',
            },
            name: '@some.dev/sdk',
            version: '1.0.0',
          }),
          role: 'install',
        },
      ]),
    ).resolves.toMatchObject({
      ecosystemMetadata: {
        npm: {
          devDependencies: {
            '@some.dev/test-helper': '^1.0.0',
          },
        },
      },
    })
  })

  it('extracts defined empty npm descriptions from install artifacts', async () => {
    await expect(
      processNpmPublishArtifacts(npmConfig(), [
        {
          bytes: await packageJsonTarball({
            description: '',
            name: '@some.dev/sdk',
            version: '1.0.0',
          }),
          role: 'install',
        },
      ]),
    ).resolves.toEqual({
      description: '',
    })
  })

  it('returns an empty npm processing result after validating minimal install artifacts', async () => {
    await expect(
      processNpmPublishArtifacts(npmConfig(), [
        {
          bytes: await packageJsonTarball({
            name: '@some.dev/sdk',
            version: '1.0.0',
          }),
          role: 'install',
        },
      ]),
    ).resolves.toEqual({})
  })

  it('rejects invalid npm dev dependency metadata', async () => {
    await expect(
      processNpmPublishArtifacts(npmConfig(), [
        {
          bytes: await packageJsonTarball({
            devDependencies: {
              '@some.dev/test-helper': 1,
            },
            name: '@some.dev/sdk',
            version: '1.0.0',
          }),
          role: 'install',
        },
      ]),
    ).rejects.toThrow(
      'npm package.json devDependencies.@some.dev/test-helper must be a string',
    )
  })
})

function npmConfig(): RegestaConfig {
  return {
    id: 'npm:some.dev/sdk',
    source: {
      include: ['package.json'],
    },
    version: '1.0.0',
  }
}

function releaseManifest(
  overrides: Partial<ReleaseManifest> = {},
): ReleaseManifest {
  return {
    artifacts: [
      {
        digest: sha256('artifact'),
        mediaType: 'application/gzip',
        role: 'install',
        size: 8,
      },
    ],
    configDigest: sha256('config'),
    createdAt: '2026-06-01T00:00:00.000Z',
    ecosystem: 'npm',
    id: 'npm:some.dev/sdk',
    name: 'some.dev/sdk',
    object: 'regesta.release-manifest',
    provenance: {
      level: 'source-attached',
      verified: false,
    },
    source: {
      digest: sha256('source'),
      mediaType: 'application/vnd.regesta.source-archive+tgz',
      size: 6,
    },
    version: '1.0.0',
    ...overrides,
  }
}

async function packageJsonTarball(
  value: Record<string, unknown>,
): Promise<Uint8Array> {
  const root = await mkdtemp(join(tmpdir(), 'regesta-npm-test-'))

  try {
    await mkdir(join(root, 'package'))
    await writeFile(
      join(root, 'package', 'package.json'),
      `${JSON.stringify(value)}\n`,
    )
    await tar.c(
      {
        cwd: root,
        file: join(root, 'package.tgz'),
        gzip: true,
      },
      ['package/package.json'],
    )

    return readFile(join(root, 'package.tgz'))
  } finally {
    await rm(root, { force: true, recursive: true })
  }
}

async function invalidPackageJsonTarball(): Promise<Uint8Array> {
  const root = await mkdtemp(join(tmpdir(), 'regesta-npm-test-'))

  try {
    await mkdir(join(root, 'package'))
    await writeFile(join(root, 'package', 'package.json'), '{')
    await tar.c(
      {
        cwd: root,
        file: join(root, 'package.tgz'),
        gzip: true,
      },
      ['package/package.json'],
    )

    return readFile(join(root, 'package.tgz'))
  } finally {
    await rm(root, { force: true, recursive: true })
  }
}
