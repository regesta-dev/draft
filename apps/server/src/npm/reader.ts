import type {
  PackageId,
  PackageState,
  RegistryEvent,
  ReleaseManifest,
  Sha256Digest,
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

export interface NpmRegistryReader {
  database: {
    getPackageChannelVersion: (
      packageId: PackageId,
      channel: string,
    ) => Promise<string | undefined>
    getPackageChannels: (
      packageId: PackageId,
    ) => Promise<Record<string, string>>
    getPackageEventHead: (packageId: PackageId) => Promise<NpmPackageEventHead>
    getPackageEventState: (
      packageId: PackageId,
    ) => Promise<NpmPackageStateSnapshot>
    getPackageReleaseHead: (
      packageId: PackageId,
    ) => Promise<NpmPackageReleaseHead>
    getRelease: (
      packageId: PackageId,
      version: string,
    ) => Promise<
      { event: RegistryEvent; manifest: ReleaseManifest } | undefined
    >
    listPackageReleases: (
      packageId: PackageId,
      options: NpmPackageReleaseListOptions,
    ) => Promise<Array<{ event: RegistryEvent; manifest: ReleaseManifest }>>
  }
}

export interface NpmRegistryReaderSource {
  database: NpmRegistryReader['database']
}

export function createNpmRegistryReader(
  adapters: NpmRegistryReaderSource,
): NpmRegistryReader {
  return {
    database: {
      getPackageChannelVersion: (packageId, channel) => {
        return adapters.database.getPackageChannelVersion(packageId, channel)
      },
      getPackageChannels: (packageId) => {
        return adapters.database.getPackageChannels(packageId)
      },
      getPackageEventHead: (packageId) => {
        return adapters.database.getPackageEventHead(packageId)
      },
      getPackageEventState: (packageId) => {
        return adapters.database.getPackageEventState(packageId)
      },
      getPackageReleaseHead: (packageId) => {
        return adapters.database.getPackageReleaseHead(packageId)
      },
      getRelease: (packageId, version) => {
        return adapters.database.getRelease(packageId, version)
      },
      listPackageReleases: (packageId, options) => {
        return adapters.database.listPackageReleases(packageId, options)
      },
    },
  }
}
