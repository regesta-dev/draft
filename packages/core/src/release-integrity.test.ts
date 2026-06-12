import {
  canonicalJson,
  defaultPackageChannel,
  registryEventDigest,
  sha256,
  type ObjectDescriptor,
  type PublishReleaseEvent,
  type ReleaseArtifact,
  type ReleaseManifest,
} from '@regesta/protocol'
import { describe, expect, it } from 'vitest'
import {
  assertStoredReleaseIntegrity,
  parseStoredRelease,
} from './release-integrity.ts'
import { RegistryEventIntegrityError, type StoredRelease } from './storage.ts'

describe('parseStoredRelease', () => {
  it('parses valid stored release envelopes with expected identity', () => {
    const release = storedRelease()

    expect(
      parseStoredRelease(release, {
        channel: defaultPackageChannel,
        packageId: release.manifest.id,
        version: release.manifest.version,
      }),
    ).toEqual(release)
  })

  it('rejects release envelopes for different requested versions', () => {
    const release = storedRelease()

    expect(() =>
      parseStoredRelease(release, {
        label: 'Adapter release',
        packageId: release.manifest.id,
        version: '9.9.9',
      }),
    ).toThrow(RegistryEventIntegrityError)
    expect(() =>
      parseStoredRelease(release, {
        label: 'Adapter release',
        packageId: release.manifest.id,
        version: '9.9.9',
      }),
    ).toThrow('Adapter release manifest version must match requested version')
  })

  it('rejects manifest descriptors that do not match canonical manifests', () => {
    const release = storedRelease()
    release.manifest.metadata = {
      description: 'tampered manifest',
    }

    expect(() => assertStoredReleaseIntegrity(release)).toThrow(
      RegistryEventIntegrityError,
    )
    expect(() => assertStoredReleaseIntegrity(release)).toThrow(
      'Stored release manifestDescriptor digest must match canonical manifest',
    )
  })

  it('rejects release manifests without exactly one install artifact', () => {
    const release = storedRelease()
    release.manifest.artifacts = [
      {
        ...release.manifest.artifacts[0]!,
        role: 'docs',
      },
    ]
    release.event = publishEventFor(release)

    expect(() => assertStoredReleaseIntegrity(release)).toThrow(
      RegistryEventIntegrityError,
    )
    expect(() => assertStoredReleaseIntegrity(release)).toThrow(
      'Stored release manifest must include exactly one install artifact',
    )
  })
})

function storedRelease(): StoredRelease {
  const sourceBytes = bytes('source archive')
  const artifactBytes = bytes('install artifact')
  const source = descriptor(
    sourceBytes,
    'application/vnd.regesta.source-archive+tgz',
  )
  const artifact = {
    ...descriptor(artifactBytes, 'application/gzip'),
    filename: 'hello-regesta-1.0.0.tgz',
    format: 'npm-tarball',
    role: 'install',
  } satisfies ReleaseArtifact
  const manifest: ReleaseManifest = {
    artifacts: [artifact],
    configDigest: sha256(bytes('config')),
    createdAt: '2026-06-09T00:00:00.000Z',
    ecosystem: 'npm',
    id: 'npm:example.com/hello-regesta',
    name: 'example.com/hello-regesta',
    object: 'regesta.release-manifest',
    provenance: {
      level: 'source-attached',
      verified: false,
    },
    source,
    version: '1.0.0',
  }
  const manifestDescriptor = descriptor(
    bytes(`${canonicalJson(manifest)}\n`),
    'application/vnd.regesta.release-manifest.v0+json',
  )

  return {
    event: publishEventFor({ manifest, manifestDescriptor }),
    manifest,
    manifestDescriptor,
  }
}

function publishEventFor(
  release: Pick<StoredRelease, 'manifest' | 'manifestDescriptor'>,
): PublishReleaseEvent {
  const eventPayload: Omit<PublishReleaseEvent, 'id'> = {
    artifactDigests: release.manifest.artifacts.map((artifact) => {
      return artifact.digest
    }),
    channel: defaultPackageChannel,
    eventType: 'release.published',
    object: 'regesta.event',
    release: {
      id: release.manifest.id,
      manifestDigest: release.manifestDescriptor.digest,
      version: release.manifest.version,
    },
    sourceDigest: release.manifest.source.digest,
    timestamp: release.manifest.createdAt,
  }

  return {
    ...eventPayload,
    id: registryEventDigest(eventPayload),
  }
}

function descriptor(bytes: Uint8Array, mediaType: string): ObjectDescriptor {
  return {
    digest: sha256(bytes),
    mediaType,
    size: bytes.byteLength,
  }
}

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value)
}
