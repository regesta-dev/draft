import type { PackageStateSnapshot, RegistryAdapters } from '@regesta/core'
import type {
  PackageId,
  RegistryEvent,
  ReleaseManifest,
} from '@regesta/protocol'

export interface NpmRegistryReader {
  database: {
    getPackageChannels: (
      packageId: PackageId,
    ) => Promise<Record<string, string>>
    getPackageEventState: (
      packageId: PackageId,
    ) => Promise<PackageStateSnapshot>
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

export function createNpmRegistryReader(
  adapters: Pick<RegistryAdapters, 'database'>,
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
