import {
  createNpmPackument,
  npmInstallArtifact,
  npmPackageIdFromName,
  type NpmPackument,
  type NpmPackumentVersion,
} from '@regesta/npm'
import {
  canonicalJson,
  sha256,
  type PackageId,
  type PackageState,
  type RegistryEvent,
  type ReleaseManifest,
  type Sha256Digest,
} from '@regesta/protocol'

export interface NpmPackageStateSnapshot {
  lastEventId?: Sha256Digest
  lastEventTimestamp?: string
  state: PackageState
}

export interface NpmProjectionStateReader {
  database: {
    getPackageEventState: (
      packageId: PackageId,
    ) => Promise<NpmPackageStateSnapshot>
  }
}

export interface LocalNpmPackageProjection {
  channels: Record<string, string>
  etag: string
  modifiedAt: string
  packument: NpmPackument
}

export function localNpmPackageId(packageName: string): PackageId | undefined {
  try {
    return npmPackageIdFromName(packageName)
  } catch {
    return undefined
  }
}

export async function readLocalNpmPackageProjection(
  reader: NpmProjectionStateReader,
  packageId: PackageId,
  releases: Array<{ event: RegistryEvent; manifest: ReleaseManifest }>,
  requestUrl: URL,
): Promise<LocalNpmPackageProjection> {
  const snapshot = await reader.database.getPackageEventState(packageId)
  const releaseTimestamps = releases.map(
    (release) => release.manifest.createdAt,
  )
  const channels = snapshot.state.channels ?? {}
  const modifiedAt =
    [
      ...releaseTimestamps,
      ...(snapshot.lastEventTimestamp ? [snapshot.lastEventTimestamp] : []),
    ]
      .toSorted()
      .at(-1) ?? ''

  return {
    channels,
    etag: `W/"regesta.npm-projection:${snapshot.lastEventId ?? 'empty'}"`,
    modifiedAt,
    packument: createLocalNpmPackument(
      requestUrl,
      packageId,
      releases,
      channels,
      modifiedAt,
    ),
  }
}

export function npmVersionManifestEtag(releaseEventId: string): string {
  return `W/"regesta.npm-version:${releaseEventId}"`
}

export function npmDistTagsEtag(channels: Record<string, string>): string {
  return `W/"regesta.npm-dist-tags:${sha256(canonicalJson(channels))}"`
}

export function createLocalNpmVersionManifest(
  requestUrl: URL,
  packageId: PackageId,
  release: { manifest: ReleaseManifest },
): NpmPackumentVersion {
  const packument = createLocalNpmPackument(
    requestUrl,
    packageId,
    [release],
    {},
    release.manifest.createdAt,
  )
  const manifest = packument.versions[release.manifest.version]

  if (!manifest) {
    throw new Error('Release projection is inconsistent')
  }

  return manifest
}

function createLocalNpmPackument(
  requestUrl: URL,
  packageId: PackageId,
  releases: Array<{ manifest: ReleaseManifest }>,
  channels: Record<string, string>,
  modifiedAt?: string,
): NpmPackument {
  return rewriteLocalNpmTarballUrls(
    requestUrl,
    createNpmPackument(
      packageId,
      releases,
      requestUrl.origin,
      channels,
      modifiedAt,
    ),
    releases,
  )
}

function rewriteLocalNpmTarballUrls(
  requestUrl: URL,
  packument: NpmPackument,
  releases: Array<{ manifest: ReleaseManifest }>,
): NpmPackument {
  const tarballUrls = new Map(
    releases.map((release) => [
      release.manifest.version,
      coreObjectUrl(requestUrl, npmInstallArtifact(release.manifest).digest),
    ]),
  )

  return {
    ...packument,
    versions: Object.fromEntries(
      Object.entries(packument.versions).map(([version, manifest]) => {
        const tarball = tarballUrls.get(version)

        return [
          version,
          tarball === undefined
            ? manifest
            : {
                ...manifest,
                dist: {
                  ...manifest.dist,
                  tarball,
                },
              },
        ]
      }),
    ),
  }
}

function coreObjectUrl(requestUrl: URL, digest: string): string {
  const url = new URL(requestUrl)
  url.hostname = coreRegistryHostname(url.hostname)
  url.pathname = `/objects/${digest}`
  url.search = ''
  url.hash = ''

  return url.toString()
}

function coreRegistryHostname(hostname: string): string {
  const labels = hostname.split('.')

  if (labels[0] !== 'npm') {
    return hostname
  }

  if (labels.length === 2 && labels[1] === 'localhost') {
    return 'localhost'
  }

  if (labels[1] === 'registry') {
    return labels.slice(1).join('.')
  }

  return ['registry', ...labels.slice(1)].join('.')
}
