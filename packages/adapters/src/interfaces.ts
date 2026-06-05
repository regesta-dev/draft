import type {
  ObjectDescriptor,
  PackageId,
  RegistryEvent,
  ReleaseManifest,
  Sha256Digest,
} from '@regesta/protocol'

export interface StoredObject {
  bytes: Uint8Array
  descriptor: ObjectDescriptor
}

export interface StoredRelease {
  event: RegistryEvent
  manifest: ReleaseManifest
  manifestDescriptor: ObjectDescriptor
}

export interface ObjectStore {
  get: (digest: Sha256Digest) => Promise<StoredObject | undefined>
  put: (bytes: Uint8Array, mediaType: string) => Promise<ObjectDescriptor>
}

export interface RegistryDatabase {
  appendEvent: (event: RegistryEvent) => Promise<void>
  deletePackageChannel: (
    packageId: PackageId,
    channel: string,
  ) => Promise<string | undefined>
  getEventLog: () => Promise<RegistryEvent[]>
  getPackageChannels: (packageId: PackageId) => Promise<Record<string, string>>
  getRelease: (
    packageId: PackageId,
    version: string,
  ) => Promise<StoredRelease | undefined>
  listPackageReleases: (packageId: PackageId) => Promise<StoredRelease[]>
  putRelease: (release: StoredRelease) => Promise<void>
  setPackageChannel: (
    packageId: PackageId,
    channel: string,
    version: string,
  ) => Promise<string | undefined>
}

export interface QueueAdapter {
  enqueue: (topic: string, payload: unknown) => Promise<void>
}

export interface SignerAdapter {
  sign: (bytes: Uint8Array) => Promise<Uint8Array>
}

export interface RegistryAdapters {
  database: RegistryDatabase
  objects: ObjectStore
  queue: QueueAdapter
  signer: SignerAdapter
}
