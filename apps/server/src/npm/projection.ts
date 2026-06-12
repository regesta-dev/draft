import {
  createNpmPackument,
  npmInstallArtifact,
  npmPackageIdFromName,
  tarballFileName,
  type NpmPackument,
  type NpmPackumentVersion,
} from '@regesta/npm'
import {
  canonicalJson,
  parsePackageState,
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

export interface NpmPackageEventHead {
  lastEventId?: Sha256Digest
  lastEventTimestamp?: string
  modifiedAt?: string
  releaseCount: number
}

export interface NpmPackageReleaseHead {
  modifiedAt?: string
  releaseCount: number
}

export interface NpmPackageReleaseListOptions {
  after?: string
  limit: number
}

export interface NpmProjectionStateReader {
  database: {
    getPackageEventHead: (packageId: PackageId) => Promise<NpmPackageEventHead>
    getPackageEventState: (
      packageId: PackageId,
    ) => Promise<NpmPackageStateSnapshot>
    getPackageReleaseHead: (
      packageId: PackageId,
    ) => Promise<NpmPackageReleaseHead>
    listPackageReleases: (
      packageId: PackageId,
      options: NpmPackageReleaseListOptions,
    ) => Promise<Array<{ event: RegistryEvent; manifest: ReleaseManifest }>>
  }
}

export interface LocalNpmPackageProjection {
  channels: Record<string, string>
  etag: string
  modifiedAt: string
  packument: NpmPackument
}

export interface LocalNpmPackageProjectionCache {
  delete: (key: string) => void
  get: (key: string) => LocalNpmPackageProjectionCacheEntry | undefined
  set: (key: string, entry: LocalNpmPackageProjectionCacheEntry) => void
}

export interface LocalNpmPackageProjectionCacheEntry {
  lastEventId: string
  projection: LocalNpmPackageProjection
  releaseCount: number
}

const defaultLocalNpmPackageProjectionCacheEntries = 128
const maxLocalNpmProjectionReadAttempts = 3
const localNpmPackageReleasePageLimit = 999

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
  requestUrl: URL,
  cache?: LocalNpmPackageProjectionCache,
): Promise<LocalNpmPackageProjection | undefined> {
  const cacheKey = localNpmPackageProjectionCacheKey(packageId, requestUrl)
  const cached = cache?.get(cacheKey)

  if (cached) {
    const [eventHead, releaseHead] = await Promise.all([
      reader.database.getPackageEventHead(packageId),
      reader.database.getPackageReleaseHead(packageId),
    ])

    if (
      eventHead.releaseCount > 0 &&
      eventHead.lastEventId === cached.lastEventId &&
      releaseHead.releaseCount === cached.releaseCount
    ) {
      return cached.projection
    }

    if (releaseHead.releaseCount === 0) {
      cache?.delete(cacheKey)
      return undefined
    }
  }

  const read = await readFreshLocalNpmPackageProjectionInput(reader, packageId)

  if (!read) {
    cache?.delete(cacheKey)
    return undefined
  }
  const projection = createLocalNpmPackageProjection(
    packageId,
    read.releases,
    requestUrl,
    read.snapshot,
  )

  if (read.cacheable) {
    cache?.set(cacheKey, {
      lastEventId: read.snapshot.lastEventId ?? 'empty',
      projection,
      releaseCount: read.releases.length,
    })
  }

  return projection
}

export async function readLocalNpmPackageProjectionHead(
  reader: NpmProjectionStateReader,
  packageId: PackageId,
): Promise<NpmPackageEventHead | undefined> {
  const [eventHead, releaseHead] = await Promise.all([
    reader.database.getPackageEventHead(packageId),
    reader.database.getPackageReleaseHead(packageId),
  ])

  if (
    !eventHead.lastEventId ||
    eventHead.releaseCount === 0 ||
    releaseHead.releaseCount !== eventHead.releaseCount
  ) {
    return undefined
  }

  return eventHead
}

async function readFreshLocalNpmPackageProjectionInput(
  reader: NpmProjectionStateReader,
  packageId: PackageId,
): Promise<
  | {
      cacheable: boolean
      releases: Array<{ event: RegistryEvent; manifest: ReleaseManifest }>
      snapshot: NpmPackageStateSnapshot
    }
  | undefined
> {
  let latest:
    | {
        releases: Array<{ event: RegistryEvent; manifest: ReleaseManifest }>
        snapshot: NpmPackageStateSnapshot
      }
    | undefined

  for (
    let attempt = 0;
    attempt < maxLocalNpmProjectionReadAttempts;
    attempt++
  ) {
    const releaseHead = await reader.database.getPackageReleaseHead(packageId)

    if (releaseHead.releaseCount === 0) {
      return undefined
    }

    const releases = await listLocalNpmPackageReleases(
      reader,
      packageId,
      releaseHead.releaseCount,
    )

    if (releases.length === 0) {
      return undefined
    }

    const snapshot = parseAdapterPackageStateSnapshot(
      await reader.database.getPackageEventState(packageId),
      packageId,
    )
    latest = { releases, snapshot }

    if (
      localNpmProjectionReadIsConsistent(
        releases,
        snapshot,
        releaseHead.releaseCount,
      )
    ) {
      return { ...latest, cacheable: true }
    }

    if (
      localNpmProjectionReadIsDirectProjectionOnly(
        releases,
        snapshot,
        releaseHead.releaseCount,
      )
    ) {
      return { ...latest, cacheable: false }
    }
  }

  return latest && latest.releases.length > 0
    ? { ...latest, cacheable: false }
    : undefined
}

async function listLocalNpmPackageReleases(
  reader: NpmProjectionStateReader,
  packageId: PackageId,
  expectedReleaseCount: number,
): Promise<Array<{ event: RegistryEvent; manifest: ReleaseManifest }>> {
  const releases: Array<{ event: RegistryEvent; manifest: ReleaseManifest }> =
    []
  let after: string | undefined

  while (releases.length < expectedReleaseCount) {
    const page = await reader.database.listPackageReleases(packageId, {
      ...(after === undefined ? {} : { after }),
      limit: localNpmPackageReleasePageLimit,
    })

    if (page.length === 0) {
      return releases
    }

    releases.push(...page)

    if (
      releases.length >= expectedReleaseCount ||
      page.length < localNpmPackageReleasePageLimit
    ) {
      return releases
    }

    after = page.at(-1)!.manifest.version
  }

  return releases
}

function parseAdapterPackageStateSnapshot(
  snapshot: NpmPackageStateSnapshot,
  packageId: PackageId,
): NpmPackageStateSnapshot {
  const state = parsePackageState(snapshot.state, 'Adapter package state')

  if (state.id !== packageId) {
    throw new TypeError(
      `Adapter package state id must match requested package id: ${packageId}`,
    )
  }

  return { ...snapshot, state }
}

function localNpmProjectionReadIsDirectProjectionOnly(
  releases: Array<{ event: RegistryEvent }>,
  snapshot: NpmPackageStateSnapshot,
  expectedReleaseCount: number,
): boolean {
  return (
    releases.length === expectedReleaseCount &&
    expectedReleaseCount > 0 &&
    snapshot.lastEventId === undefined &&
    snapshot.state.releases.length === 0
  )
}

function localNpmProjectionReadIsConsistent(
  releases: Array<{ event: RegistryEvent }>,
  snapshot: NpmPackageStateSnapshot,
  expectedReleaseCount: number,
): boolean {
  if (
    releases.length !== expectedReleaseCount ||
    releases.length !== snapshot.state.releases.length
  ) {
    return false
  }

  const releaseDigests = new Map<string, string>()

  for (const release of releases) {
    if (release.event.eventType !== 'release.published') {
      return false
    }

    releaseDigests.set(
      release.event.release.version,
      release.event.release.manifestDigest,
    )
  }

  return snapshot.state.releases.every((release) => {
    return releaseDigests.get(release.version) === release.manifestDigest
  })
}

export function createLocalNpmPackageProjectionCache(
  maxEntries = defaultLocalNpmPackageProjectionCacheEntries,
): LocalNpmPackageProjectionCache {
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 0) {
    throw new TypeError(
      'Local npm package projection cache size must be a non-negative safe integer',
    )
  }

  const entries = new Map<string, LocalNpmPackageProjectionCacheEntry>()

  return {
    delete: (key) => {
      entries.delete(key)
    },
    get: (key) => {
      const entry = entries.get(key)

      if (!entry) {
        return
      }

      entries.delete(key)
      entries.set(key, entry)

      return entry
    },
    set: (key, entry) => {
      if (maxEntries === 0) {
        return
      }

      entries.delete(key)
      entries.set(key, entry)

      while (entries.size > maxEntries) {
        const oldestKey = entries.keys().next().value

        if (oldestKey === undefined) {
          return
        }

        entries.delete(oldestKey)
      }
    },
  }
}

export function createLocalNpmPackageProjection(
  packageId: PackageId,
  releases: Array<{ event: RegistryEvent; manifest: ReleaseManifest }>,
  requestUrl: URL,
  snapshot: NpmPackageStateSnapshot,
): LocalNpmPackageProjection {
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
    etag: npmPackumentEtag(snapshot.lastEventId ?? 'empty'),
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

export function npmPackumentEtag(lastEventId: string): string {
  return `W/"regesta.npm-projection:${lastEventId}"`
}

function localNpmPackageProjectionCacheKey(
  packageId: PackageId,
  requestUrl: URL,
): string {
  return `${packageId}\0${requestUrl.origin}`
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
  return createNpmPackument(
    packageId,
    releases,
    requestUrl.origin,
    channels,
    modifiedAt,
  )
}

export function localNpmTarballObjectUrl(
  requestUrl: URL,
  packageId: PackageId,
  release: { manifest: ReleaseManifest },
  file: string,
): string | undefined {
  if (tarballFileName(packageId, release.manifest.version) !== file) {
    return undefined
  }

  return coreObjectUrl(requestUrl, npmInstallArtifact(release.manifest).digest)
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
