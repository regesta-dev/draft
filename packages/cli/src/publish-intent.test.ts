import { sha256 } from '@regesta/protocol'
import { describe, expect, it } from 'vitest'
import { releasePublishArtifactDescriptors } from './publish-intent.ts'

describe('releasePublishArtifactDescriptors', () => {
  it('binds publish signatures to client-controlled artifact descriptor fields', () => {
    const bytes = new TextEncoder().encode('install artifact')

    expect(
      releasePublishArtifactDescriptors([
        {
          bytes,
          compatibility: {
            modules: ['esm'],
            runtimes: ['node'],
          },
          filename: 'hello-regesta-1.0.0.tgz',
          format: 'npm-tarball',
          mediaType: 'application/gzip',
          role: 'install',
        },
      ]),
    ).toEqual([
      {
        compatibility: {
          modules: ['esm'],
          runtimes: ['node'],
        },
        digest: sha256(bytes),
        filename: 'hello-regesta-1.0.0.tgz',
        format: 'npm-tarball',
        mediaType: 'application/gzip',
        role: 'install',
      },
    ])
  })

  it('does not include server-derived ecosystem metadata in signed descriptors', () => {
    const bytes = new TextEncoder().encode('install artifact')

    expect(
      releasePublishArtifactDescriptors([
        {
          bytes,
          ecosystemMetadata: {
            npm: {
              dependencies: {
                '@example.com/core': '^1.0.0',
              },
            },
          },
          mediaType: 'application/gzip',
          role: 'install',
        },
      ]),
    ).toEqual([
      {
        digest: sha256(bytes),
        mediaType: 'application/gzip',
        role: 'install',
      },
    ])
  })

  it('preserves artifact order for descriptor digest calculation', () => {
    const installBytes = new TextEncoder().encode('install artifact')
    const sourceMapBytes = new TextEncoder().encode('source map')

    expect(
      releasePublishArtifactDescriptors([
        {
          bytes: installBytes,
          mediaType: 'application/gzip',
          role: 'install',
        },
        {
          bytes: sourceMapBytes,
          filename: 'hello-regesta.js.map',
          mediaType: 'application/json',
          role: 'debug',
        },
      ]),
    ).toEqual([
      {
        digest: sha256(installBytes),
        mediaType: 'application/gzip',
        role: 'install',
      },
      {
        digest: sha256(sourceMapBytes),
        filename: 'hello-regesta.js.map',
        mediaType: 'application/json',
        role: 'debug',
      },
    ])
  })
})
