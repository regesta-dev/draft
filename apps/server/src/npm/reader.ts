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

export interface NpmRegistryReader {
  database: {
    getPackageChannels: (
      packageId: PackageId,
    ) => Promise<Record<string, string>>
    getPackageEventState: (
      packageId: PackageId,
    ) => Promise<NpmPackageStateSnapshot>
    getRelease: (
      packageId: PackageId,
      version: string,
    ) => Promise<
      { event: RegistryEvent; manifest: ReleaseManifest } | undefined
    >
    hasPackage: (packageId: PackageId) => Promise<boolean>
    listPackageReleases: (
      packageId: PackageId,
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
      getPackageChannels: (packageId) => {
        return adapters.database.getPackageChannels(packageId)
      },
      getPackageEventState: (packageId) => {
        return adapters.database.getPackageEventState(packageId)
      },
      getRelease: (packageId, version) => {
        return adapters.database.getRelease(packageId, version)
      },
      hasPackage: (packageId) => {
        return adapters.database.hasPackage(packageId)
      },
      listPackageReleases: (packageId) => {
        return adapters.database.listPackageReleases(packageId)
      },
    },
  }
}
