import type {
  ObjectDescriptor,
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
  getEventLog: () => Promise<RegistryEvent[]>
  getRelease: (
    coordinate: `@${string}/${string}`,
    version: string,
  ) => Promise<StoredRelease | undefined>
  listPackageReleases: (
    coordinate: `@${string}/${string}`,
  ) => Promise<StoredRelease[]>
  putRelease: (release: StoredRelease) => Promise<void>
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
