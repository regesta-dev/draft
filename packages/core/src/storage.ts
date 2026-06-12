import type {
  ChannelDeletedEvent,
  ChannelUpdatedEvent,
  ObjectDescriptor,
  PackageId,
  PackageState,
  RegistryEvent,
  ReleaseManifest,
  Sha256Digest,
} from '@regesta/protocol'

export class RegistryEventAlreadyExistsError extends Error {
  constructor(eventId: Sha256Digest) {
    super(`Registry event already exists: ${eventId}`)
    this.name = 'RegistryEventAlreadyExistsError'
  }
}

export class RegistryEventIntegrityError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RegistryEventIntegrityError'
  }
}

export class RegistryEventCursorNotFoundError extends Error {
  readonly cursor: Sha256Digest

  constructor(cursor: Sha256Digest) {
    super(`Registry event cursor not found: ${cursor}`)
    this.name = 'RegistryEventCursorNotFoundError'
    this.cursor = cursor
  }
}

export class ObjectCursorNotFoundError extends Error {
  readonly cursor: Sha256Digest

  constructor(cursor: Sha256Digest) {
    super(`Object cursor not found: ${cursor}`)
    this.name = 'ObjectCursorNotFoundError'
    this.cursor = cursor
  }
}

export class ReleaseAlreadyExistsError extends Error {
  constructor(packageId: PackageId, version: string) {
    super(`Release already exists: ${packageId}@${version}`)
    this.name = 'ReleaseAlreadyExistsError'
  }
}

export class ReleaseNotFoundError extends Error {
  constructor(packageId: PackageId, version: string) {
    super(`Release not found: ${packageId}@${version}`)
    this.name = 'ReleaseNotFoundError'
  }
}

export class PackageChannelConflictError extends Error {
  readonly actualVersion: string | undefined
  readonly channel: string
  readonly expectedVersion: string | undefined
  readonly packageId: PackageId

  constructor(
    packageId: PackageId,
    channel: string,
    expectedVersion: string | undefined,
    actualVersion: string | undefined,
  ) {
    super(`Package channel changed before commit: ${packageId}#${channel}`)
    this.name = 'PackageChannelConflictError'
    this.actualVersion = actualVersion
    this.channel = channel
    this.expectedVersion = expectedVersion
    this.packageId = packageId
  }
}

export interface StoredObject {
  bytes: Uint8Array
  descriptor: ObjectDescriptor
}

export interface StoredRelease {
  event: RegistryEvent
  manifest: ReleaseManifest
  manifestDescriptor: ObjectDescriptor
}

export interface PackageStateSnapshot {
  lastEventId?: Sha256Digest
  lastEventTimestamp?: string
  state: PackageState
}

export interface RegistryEventListOptions {
  after?: Sha256Digest
  limit?: number
}

export interface ObjectDescriptorListOptions {
  after?: Sha256Digest
  limit?: number
}

export interface ObjectStore {
  checkReadiness?: () => Promise<void>
  get: (digest: Sha256Digest) => Promise<StoredObject | undefined>
  getDescriptor: (digest: Sha256Digest) => Promise<ObjectDescriptor | undefined>
  listDescriptors: (
    options?: ObjectDescriptorListOptions,
  ) => Promise<ObjectDescriptor[]>
  put: (bytes: Uint8Array, mediaType: string) => Promise<ObjectDescriptor>
}

export type CheckpointStore = ObjectStore

export interface RegistryDatabase {
  appendEvent: (event: RegistryEvent) => Promise<void>
  checkReadiness?: () => Promise<void>
  commitPackageChannelDelete: (event: ChannelDeletedEvent) => Promise<void>
  commitPackageChannelUpdate: (event: ChannelUpdatedEvent) => Promise<void>
  commitPublishedRelease: (
    release: StoredRelease,
    channel: string,
  ) => Promise<void>
  countPackages: () => Promise<number>
  getEvent: (id: Sha256Digest) => Promise<RegistryEvent | undefined>
  getEventLog: () => Promise<RegistryEvent[]>
  getPackageChannels: (packageId: PackageId) => Promise<Record<string, string>>
  getPackageEventState: (packageId: PackageId) => Promise<PackageStateSnapshot>
  getRelease: (
    packageId: PackageId,
    version: string,
  ) => Promise<StoredRelease | undefined>
  hasPackage: (packageId: PackageId) => Promise<boolean>
  hasAuthorizationPayloadDigest: (
    payloadDigest: Sha256Digest,
  ) => Promise<boolean>
  listEvents: (options?: RegistryEventListOptions) => Promise<RegistryEvent[]>
  listPackageEvents: (packageId: PackageId) => Promise<RegistryEvent[]>
  listPackageReleases: (packageId: PackageId) => Promise<StoredRelease[]>
}

export interface QueueAdapter {
  checkReadiness?: () => Promise<void>
  enqueue: (topic: string, payload: unknown) => Promise<void>
}

export interface SignerAdapter {
  checkReadiness?: () => Promise<void>
  sign: (bytes: Uint8Array) => Promise<Uint8Array>
}

export interface RegistryAdapters {
  checkpoints?: CheckpointStore
  database: RegistryDatabase
  objects: ObjectStore
  queue: QueueAdapter
  signer: SignerAdapter
}
