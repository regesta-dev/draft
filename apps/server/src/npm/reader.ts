import type { RegistryAdapters } from '@regesta/core'
import type {
  PackageId,
  RegistryEvent,
  ReleaseManifest,
} from '@regesta/protocol'

export interface NpmRegistryReader {
  database: {
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
      listPackageEvents: (packageId) => {
        return adapters.database.listPackageEvents(packageId)
      },
      listPackageReleases: (packageId) => {
        return adapters.database.listPackageReleases(packageId)
      },
    },
  }
}
