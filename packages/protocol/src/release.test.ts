import { describe, expect, it } from 'vitest'
import { sha256, type ObjectDescriptor } from './digest.ts'
import {
  assertArtifactDescriptorString,
  parseObjectDescriptor,
  parseObjectInventoryPage,
  parseReleaseManifest,
  type ObjectInventoryPage,
  type ReleaseManifest,
} from './release.ts'

describe('assertArtifactDescriptorString', () => {
  it('returns custom artifact descriptor strings', () => {
    expect(assertArtifactDescriptorString('install')).toBe('install')
    expect(assertArtifactDescriptorString('npm-tarball')).toBe('npm-tarball')
    expect(assertArtifactDescriptorString('sdk-1.0.0.tgz')).toBe(
      'sdk-1.0.0.tgz',
    )
  })

  it('rejects invalid runtime inputs', () => {
    expect(() => assertArtifactDescriptorString(JSON.parse('null'))).toThrow(
      'Artifact descriptor string must be a non-empty string',
    )
    expect(() => assertArtifactDescriptorString('')).toThrow(
      'Artifact descriptor string must be a non-empty string',
    )
    expect(() => assertArtifactDescriptorString('install\r\nx')).toThrow(
      'Artifact descriptor string must not include control characters',
    )
  })
})

describe('parseObjectDescriptor', () => {
  it('parses object descriptors without unsafe narrowing', () => {
    const descriptor: ObjectDescriptor = {
      digest: sha256(bytes('object')),
      mediaType: 'application/octet-stream',
      size: 6,
    }

    expect(parseObjectDescriptor(descriptor)).toEqual(descriptor)
  })

  it('rejects invalid object descriptor digests', () => {
    expect(() =>
      parseObjectDescriptor({
        digest: 'sha256:not-valid',
        mediaType: 'application/octet-stream',
        size: 6,
      }),
    ).toThrow('Invalid sha256 digest')
  })
})

describe('parseObjectInventoryPage', () => {
  it('parses object inventory pages without unsafe narrowing', () => {
    const page = objectInventoryPage()

    expect(parseObjectInventoryPage(page)).toEqual(page)
  })

  it('rejects object inventory pages with unknown fields', () => {
    expect(() =>
      parseObjectInventoryPage({
        ...objectInventoryPage(),
        operatorHint: 'not verified',
      }),
    ).toThrow(
      'Object inventory page must not include unknown field: operatorHint',
    )
  })

  it('rejects invalid object inventory cursors', () => {
    expect(() =>
      parseObjectInventoryPage({
        ...objectInventoryPage(),
        nextAfter: 'sha256:not-valid',
      }),
    ).toThrow('Invalid sha256 digest')
  })
})

describe('parseReleaseManifest', () => {
  it('parses release manifests without unsafe narrowing', () => {
    const manifest = releaseManifest()

    expect(parseReleaseManifest(manifest)).toEqual(manifest)
  })

  it('rejects release manifests whose ecosystem does not match the package id', () => {
    expect(() =>
      parseReleaseManifest({
        ...releaseManifest(),
        ecosystem: 'cargo',
      }),
    ).toThrow('Release manifest ecosystem must match package id')
  })

  it('rejects release manifests with unknown artifact fields', () => {
    const manifest = releaseManifest()

    expect(() =>
      parseReleaseManifest({
        ...manifest,
        artifacts: [
          {
            ...manifest.artifacts[0],
            extra: true,
          },
        ],
      }),
    ).toThrow('Release manifest artifacts[0] must not include unknown field')
  })

  it('rejects artifact ecosystem metadata outside canonical JSON', () => {
    const manifest = releaseManifest()

    expect(() =>
      parseReleaseManifest({
        ...manifest,
        artifacts: [
          {
            ...manifest.artifacts[0],
            ecosystemMetadata: {
              npm: {
                dependencies: {
                  tinyexec: undefined,
                },
              },
            },
          },
        ],
      }),
    ).toThrow(
      'Release manifest artifacts[0] ecosystemMetadata must contain only canonical JSON values: Canonical JSON does not support undefined values',
    )
  })
})

function objectInventoryPage(): ObjectInventoryPage {
  const descriptor: ObjectDescriptor = {
    digest: sha256(bytes('object')),
    mediaType: 'application/octet-stream',
    size: 6,
  }

  return {
    nextAfter: descriptor.digest,
    object: 'regesta.object-inventory',
    objects: [descriptor],
  }
}

function releaseManifest(): ReleaseManifest {
  return {
    artifacts: [
      {
        compatibility: {
          platforms: [{ arch: ['arm64', 'x64'], os: ['darwin', 'linux'] }],
          runtimes: ['node', { conditions: ['regesta-source'], name: 'bun' }],
        },
        digest: sha256(bytes('artifact')),
        ecosystemMetadata: {
          npm: {
            dependencies: {
              tinyexec: '^1.0.0',
            },
          },
        },
        filename: 'sdk-1.0.0.tgz',
        format: 'tgz',
        mediaType: 'application/vnd.npm.package+tgz',
        role: 'install',
        size: 8,
      },
    ],
    configDigest: sha256(bytes('config')),
    createdAt: '2026-06-01T00:00:00.000Z',
    ecosystem: 'npm',
    family: 'some.dev/sdk',
    id: 'npm:some.dev/sdk',
    languages: ['typescript'],
    metadata: {
      description: 'Example SDK',
      exports: {
        '.': './src/index.ts',
      },
      repository: 'https://example.com/repo',
    },
    name: 'some.dev/sdk',
    object: 'regesta.release-manifest',
    provenance: {
      level: 'source-attached',
      verified: false,
    },
    source: {
      digest: sha256(bytes('source')),
      mediaType: 'application/tar+gzip',
      size: 6,
    },
    version: '1.0.0',
  }
}

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value)
}
