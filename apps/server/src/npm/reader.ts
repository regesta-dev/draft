import type { RegistryAdapters } from '@regesta/core'
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
    getRelease: (
      packageId: PackageId,
      version: string,
    ) => Promise<
      { event: RegistryEvent; manifest: ReleaseManifest } | undefined
    >
    hasPackage: (packageId: PackageId) => Promise<boolean>
    listPackageEvents: (packageId: PackageId) => Promise<RegistryEvent[]>
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
      getRelease: (packageId, version) => {
        return adapters.database.getRelease(packageId, version)
      },
      hasPackage: (packageId) => {
        return adapters.database.hasPackage(packageId)
      },
      listPackageEvents: (packageId) => {
        return adapters.database.listPackageEvents(packageId)
      },
      listPackageReleases: (packageId) => {
        return adapters.database.listPackageReleases(packageId)
      },
    },
  }
}
