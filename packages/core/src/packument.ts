import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { parsePackageCoordinate, type NpmPackument } from '@regesta/protocol'
import type { StoredRelease } from '@regesta/adapters'

export function createNpmPackument(
  coordinate: `@${string}/${string}`,
  releases: Array<Pick<StoredRelease, 'manifest'>>,
  registryBaseUrl: string,
): NpmPackument {
  const sortedReleases = releases.toSorted((left, right) =>
    left.manifest.createdAt.localeCompare(right.manifest.createdAt),
  )
  const latest = sortedReleases.at(-1)

  return {
    'dist-tags': latest ? { latest: latest.manifest.version } : {},
    name: coordinate,
    versions: Object.fromEntries(
      sortedReleases.map((release) => [
        release.manifest.version,
        {
          dist: {
            integrity: integrityFromDigest(
              release.manifest.artifacts.npmTarball.digest,
            ),
            tarball: tarballUrl(
              coordinate,
              release.manifest.version,
              registryBaseUrl,
            ),
          },
          name: coordinate,
          version: release.manifest.version,
        },
      ]),
    ),
  }
}

export function integrityFromBytes(bytes: Uint8Array): string {
  return `sha512-${createHash('sha512').update(bytes).digest('base64')}`
}

export function integrityFromDigest(digest: string): string {
  return `sha256-${Buffer.from(digest.slice('sha256:'.length), 'hex').toString('base64')}`
}

export function tarballFileName(
  coordinate: `@${string}/${string}`,
  version: string,
): string {
  return `${parsePackageCoordinate(coordinate).name}-${version}.tgz`
}

export function tarballUrl(
  coordinate: `@${string}/${string}`,
  version: string,
  registryBaseUrl: string,
): string {
  return `${registryBaseUrl.replace(/\/$/, '')}/${coordinate}/-/${tarballFileName(coordinate, version)}`
}
