import {
  ObjectCursorNotFoundError,
  PackageChannelConflictError,
  PackageReleaseCursorNotFoundError,
  RegistryEventAlreadyExistsError,
  RegistryEventCursorNotFoundError,
  RegistryEventIntegrityError,
  ReleaseAlreadyExistsError,
  ReleaseNotFoundError,
  WriteAuthorizationReplayError,
} from '@regesta/core'
import {
  assertObjectMediaType,
  canonicalJson,
  comparePackageReleaseOrder,
  parsePackageId,
  sha256,
  type ChannelDeletedEvent,
  type ChannelUpdatedEvent,
  type PackageId,
  type PackageStateRelease,
  type RegistryEvent,
  type Sha256Digest,
} from '@regesta/protocol'
import {
  assertPersistableRegistryEvent,
  assertPersistableStoredRelease,
} from './events.ts'
import {
  assertEventListOptions,
  assertObjectDescriptorListOptions,
  assertPackageReleaseListOptions,
} from './pagination.ts'
import type {
  CheckpointStore,
  ObjectDescriptorListOptions,
  ObjectStore,
  PackageEventHead,
  PackageReleaseHead,
  PackageReleaseListOptions,
  PackageStateSnapshot,
  QueueAdapter,
  RegistryAdapters,
  RegistryDatabase,
  RegistryEventListOptions,
  SignerAdapter,
  StoredObject,
  StoredRelease,
} from './interfaces.ts'

export class MemoryObjectStore implements ObjectStore {
  readonly objects: Map<Sha256Digest, StoredObject> = new Map()

  checkReadiness(): Promise<void> {
    return Promise.resolve()
  }

  get(digest: Sha256Digest): Promise<StoredObject | undefined> {
    const object = this.objects.get(digest)

    if (!object) {
      return Promise.resolve(undefined)
    }

    if (object.descriptor.digest !== digest) {
      throw new TypeError(`Memory object descriptor digest mismatch: ${digest}`)
    }

    if (object.descriptor.size !== object.bytes.byteLength) {
      throw new TypeError(`Memory object size mismatch: ${digest}`)
    }

    assertObjectDescriptorFields(object.descriptor)
    assertObjectMediaType(object.descriptor.mediaType)

    if (sha256(object.bytes) !== digest) {
      throw new TypeError(`Memory object bytes digest mismatch: ${digest}`)
    }

    return Promise.resolve(copyStoredObject(object))
  }

  getDescriptor(
    digest: Sha256Digest,
  ): Promise<StoredObject['descriptor'] | undefined> {
    const object = this.objects.get(digest)

    if (!object) {
      return Promise.resolve(undefined)
    }

    if (object.descriptor.digest !== digest) {
      throw new TypeError(`Memory object descriptor digest mismatch: ${digest}`)
    }

    if (object.descriptor.size !== object.bytes.byteLength) {
      throw new TypeError(`Memory object size mismatch: ${digest}`)
    }

    assertObjectDescriptorFields(object.descriptor)
    assertObjectMediaType(object.descriptor.mediaType)

    return Promise.resolve({ ...object.descriptor })
  }

  listDescriptors(
    options: ObjectDescriptorListOptions,
  ): Promise<StoredObject['descriptor'][]> {
    assertObjectDescriptorListOptions(options)

    const descriptors = [...this.objects.values()]
      .map((object) => {
        if (object.descriptor.size !== object.bytes.byteLength) {
          throw new TypeError(
            `Memory object size mismatch: ${object.descriptor.digest}`,
          )
        }

        assertObjectDescriptorFields(object.descriptor)
        assertObjectMediaType(object.descriptor.mediaType)

        if (sha256(object.bytes) !== object.descriptor.digest) {
          throw new TypeError(
            `Memory object bytes digest mismatch: ${object.descriptor.digest}`,
          )
        }

        return { ...object.descriptor }
      })
      .toSorted((left, right) => {
        return left.digest.localeCompare(right.digest)
      })

    const start = objectPageStartIndex(descriptors, options.after)

    return Promise.resolve(descriptors.slice(start, start + options.limit))
  }

  put(
    bytes: Uint8Array,
    mediaType: string,
  ): Promise<StoredObject['descriptor']> {
    assertObjectMediaType(mediaType)

    const storedBytes = bytes.slice()
    const digest = sha256(storedBytes)
    const existing = this.objects.get(digest)

    if (existing) {
      if (existing.descriptor.mediaType !== mediaType) {
        throw new TypeError(`Memory object mediaType conflict: ${digest}`)
      }

      return Promise.resolve({ ...existing.descriptor })
    }

    const descriptor = {
      digest,
      mediaType,
      size: storedBytes.byteLength,
    }

    this.objects.set(digest, {
      bytes: storedBytes,
      descriptor: { ...descriptor },
    })

    return Promise.resolve({ ...descriptor })
  }
}

export class MemoryCheckpointStore
  extends MemoryObjectStore
  implements CheckpointStore {}

function objectPageStartIndex(
  descriptors: StoredObject['descriptor'][],
  after: Sha256Digest | undefined,
): number {
  if (!after) {
    return 0
  }

  const index = descriptors.findIndex((descriptor) => {
    return descriptor.digest === after
  })

  if (index === -1) {
    throw new ObjectCursorNotFoundError(after)
  }

  return index + 1
}

function assertObjectDescriptorFields(descriptor: object): void {
  const unknownFields = Object.keys(descriptor).filter(
    (field) => !['digest', 'mediaType', 'size'].includes(field),
  )

  if (unknownFields.length > 0) {
    throw new TypeError(
      `Memory object descriptor must not include unknown field: ${unknownFields[0]}`,
    )
  }
}

function copyStoredObject(object: StoredObject): StoredObject {
  return {
    bytes: object.bytes.slice(),
    descriptor: { ...object.descriptor },
  }
}

function copyRegistryEvent<TEvent extends RegistryEvent>(
  event: TEvent,
): TEvent {
  return structuredClone(event)
}

function copyStoredRelease(release: StoredRelease): StoredRelease {
  return structuredClone(release)
}

function compareStoredReleaseByCreatedAtAndVersion(
  left: StoredRelease,
  right: StoredRelease,
): number {
  return comparePackageReleaseOrder(left.manifest, right.manifest)
}

function packageReleasePageStartIndex(
  releases: StoredRelease[],
  after: string | undefined,
): number | undefined {
  if (!after) {
    return 0
  }

  const index = releases.findIndex((release) => {
    return release.manifest.version === after
  })

  return index === -1 ? undefined : index + 1
}

export class MemoryRegistryDatabase implements RegistryDatabase {
  readonly authorizationPayloadDigests: Set<Sha256Digest> = new Set()
  readonly channels: Map<PackageId, Map<string, string>> = new Map()
  readonly eventChannels: Map<PackageId, Map<string, string>> = new Map()
  readonly eventIds: Set<Sha256Digest> = new Set()
  readonly eventHeads: Map<PackageId, PackageEventHead> = new Map()
  readonly eventReleases: Map<PackageId, Map<string, PackageStateRelease>> =
    new Map()
  readonly events: RegistryEvent[] = []
  readonly releaseHeads: Map<PackageId, PackageReleaseHead> = new Map()
  readonly releases: Map<PackageId, Map<string, StoredRelease>> = new Map()

  checkReadiness(): Promise<void> {
    return Promise.resolve()
  }

  appendEvent(event: RegistryEvent): Promise<void> {
    const payloadDigest = this.assertNewEvent(event)
    this.assertRegistryEventCanBeApplied(event)
    this.commitEventAfterChecks(event, payloadDigest)
    return Promise.resolve()
  }

  commitPackageChannelUpdate(event: ChannelUpdatedEvent): Promise<void> {
    const payloadDigest = this.assertNewEvent(event)
    const packageChannels =
      this.channels.get(event.package) ?? new Map<string, string>()
    this.assertExpectedChannelVersion(
      event.package,
      event.channel,
      event.previousVersion,
      packageChannels.get(event.channel),
    )
    this.assertReleaseExists(event.package, event.version)
    this.assertRegistryEventCanBeApplied(event)

    this.commitEventAfterChecks(event, payloadDigest)
    packageChannels.set(event.channel, event.version)
    this.channels.set(event.package, packageChannels)

    return Promise.resolve()
  }

  commitPackageChannelDelete(event: ChannelDeletedEvent): Promise<void> {
    const payloadDigest = this.assertNewEvent(event)
    const packageChannels =
      this.channels.get(event.package) ?? new Map<string, string>()
    this.assertExpectedChannelVersion(
      event.package,
      event.channel,
      event.previousVersion,
      packageChannels.get(event.channel),
    )
    this.assertRegistryEventCanBeApplied(event)

    this.commitEventAfterChecks(event, payloadDigest)
    packageChannels.delete(event.channel)
    this.channels.set(event.package, packageChannels)

    return Promise.resolve()
  }

  commitPublishedRelease(
    release: StoredRelease,
    channel: string,
  ): Promise<void> {
    assertPersistableStoredRelease(release, channel)

    const payloadDigest = this.assertNewEvent(release.event)
    const packageId = release.manifest.id
    const versions =
      this.releases.get(packageId) ?? new Map<string, StoredRelease>()

    if (versions.has(release.manifest.version)) {
      throw new ReleaseAlreadyExistsError(packageId, release.manifest.version)
    }
    this.assertRegistryEventCanBeApplied(release.event)

    this.commitEventAfterChecks(release.event, payloadDigest)
    versions.set(release.manifest.version, copyStoredRelease(release))
    this.releases.set(packageId, versions)
    this.applyPackageReleaseHead(packageId, release.manifest.createdAt)

    const packageChannels =
      this.channels.get(packageId) ?? new Map<string, string>()
    packageChannels.set(channel, release.manifest.version)
    this.channels.set(packageId, packageChannels)

    return Promise.resolve()
  }

  countPackages(): Promise<number> {
    return Promise.resolve(this.releaseHeads.size)
  }

  listEvents(options: RegistryEventListOptions): Promise<RegistryEvent[]> {
    assertEventListOptions(options)

    const afterIndex = options.after
      ? this.events.findIndex((event) => event.id === options.after)
      : -1

    if (options.after && afterIndex < 0) {
      return Promise.reject(new RegistryEventCursorNotFoundError(options.after))
    }

    const startIndex = afterIndex + 1
    const endIndex = startIndex + options.limit

    return Promise.resolve(
      this.events
        .slice(startIndex, endIndex)
        .map((event) => copyRegistryEvent(event)),
    )
  }

  getEvent(id: Sha256Digest): Promise<RegistryEvent | undefined> {
    const event = this.events.find((item) => {
      return item.id === id
    })

    return Promise.resolve(event ? copyRegistryEvent(event) : undefined)
  }

  deletePackageChannel(
    packageId: PackageId,
    channel: string,
  ): Promise<string | undefined> {
    const packageChannels =
      this.channels.get(packageId) ?? new Map<string, string>()
    const previousVersion = packageChannels.get(channel)
    packageChannels.delete(channel)
    this.channels.set(packageId, packageChannels)
    return Promise.resolve(previousVersion)
  }

  getPackageChannelVersion(
    packageId: PackageId,
    channel: string,
  ): Promise<string | undefined> {
    return Promise.resolve(this.channels.get(packageId)?.get(channel))
  }

  getPackageChannels(packageId: PackageId): Promise<Record<string, string>> {
    return Promise.resolve(
      Object.fromEntries(this.channels.get(packageId)?.entries() ?? []),
    )
  }

  getPackageEventHead(packageId: PackageId): Promise<PackageEventHead> {
    const head = this.eventHeads.get(packageId)

    return Promise.resolve(head ? { ...head } : { releaseCount: 0 })
  }

  getPackageEventState(packageId: PackageId): Promise<PackageStateSnapshot> {
    const parsed = parsePackageId(packageId)
    const releases = [...(this.eventReleases.get(packageId)?.values() ?? [])]
      .map((release) => ({ ...release }))
      .toSorted(comparePackageReleaseOrder)
    const channels = Object.fromEntries(
      this.eventChannels.get(packageId)?.entries() ?? [],
    )
    const head = this.eventHeads.get(packageId)

    return Promise.resolve({
      ...(head?.lastEventId && head.lastEventTimestamp
        ? {
            lastEventId: head.lastEventId,
            lastEventTimestamp: head.lastEventTimestamp,
          }
        : {}),
      state: {
        ...(Object.keys(channels).length === 0 ? {} : { channels }),
        ecosystem: parsed.ecosystem,
        id: packageId,
        name: parsed.name,
        object: 'regesta.package-state',
        releases,
      },
    })
  }

  getPackageReleaseHead(packageId: PackageId): Promise<PackageReleaseHead> {
    const head = this.releaseHeads.get(packageId)

    return Promise.resolve(head ? { ...head } : { releaseCount: 0 })
  }

  getRelease(
    packageId: PackageId,
    version: string,
  ): Promise<StoredRelease | undefined> {
    const release = this.releases.get(packageId)?.get(version)

    return Promise.resolve(release ? copyStoredRelease(release) : undefined)
  }

  hasAuthorizationPayloadDigest(payloadDigest: Sha256Digest): Promise<boolean> {
    return Promise.resolve(this.authorizationPayloadDigests.has(payloadDigest))
  }

  listPackageReleases(
    packageId: PackageId,
    options: PackageReleaseListOptions,
  ): Promise<StoredRelease[]> {
    assertPackageReleaseListOptions(options)

    const releases = [...(this.releases.get(packageId)?.values() ?? [])]
      .map((release) => copyStoredRelease(release))
      .toSorted(compareStoredReleaseByCreatedAtAndVersion)
    const start = packageReleasePageStartIndex(releases, options.after)

    if (start === undefined) {
      const cursor = options.after
      if (!cursor) {
        throw new TypeError('Package release cursor must be defined')
      }

      return Promise.reject(
        new PackageReleaseCursorNotFoundError(packageId, cursor),
      )
    }

    return Promise.resolve(releases.slice(start, start + options.limit))
  }

  putRelease(release: StoredRelease): Promise<void> {
    assertPersistableStoredRelease(release, release.event.channel)

    const packageId = release.manifest.id
    const versions =
      this.releases.get(packageId) ?? new Map<string, StoredRelease>()

    if (versions.has(release.manifest.version)) {
      throw new ReleaseAlreadyExistsError(packageId, release.manifest.version)
    }

    versions.set(release.manifest.version, copyStoredRelease(release))
    this.releases.set(packageId, versions)
    this.applyPackageReleaseHead(packageId, release.manifest.createdAt)
    return Promise.resolve()
  }

  setPackageChannel(
    packageId: PackageId,
    channel: string,
    version: string,
  ): Promise<string | undefined> {
    const packageChannels =
      this.channels.get(packageId) ?? new Map<string, string>()
    const previousVersion = packageChannels.get(channel)
    packageChannels.set(channel, version)
    this.channels.set(packageId, packageChannels)
    return Promise.resolve(previousVersion)
  }

  private assertNewEvent(event: RegistryEvent): Sha256Digest | undefined {
    assertPersistableRegistryEvent(event)

    const payloadDigest = eventAuthorizationPayloadDigest(event)

    if (this.eventIds.has(event.id)) {
      throw new RegistryEventAlreadyExistsError(event.id)
    }

    if (payloadDigest && this.authorizationPayloadDigests.has(payloadDigest)) {
      throw new WriteAuthorizationReplayError(payloadDigest)
    }

    return payloadDigest
  }

  private commitEventAfterChecks(
    event: RegistryEvent,
    payloadDigest: Sha256Digest | undefined,
  ): void {
    if (payloadDigest) {
      this.authorizationPayloadDigests.add(payloadDigest)
    }

    this.eventIds.add(event.id)
    this.events.push(copyRegistryEvent(event))
    this.applyRegistryEventState(event)
  }

  private assertRegistryEventCanBeApplied(event: RegistryEvent): void {
    switch (event.eventType) {
      case 'release.published': {
        if (
          this.eventReleases.get(event.release.id)?.has(event.release.version)
        ) {
          throw new RegistryEventIntegrityError(
            `Registry event release version already exists: ${event.release.version}`,
          )
        }
        break
      }
      case 'channel.updated': {
        this.assertEventReleaseExists(event.package, event.version)
        this.assertEventChannelVersion(
          event.package,
          event.channel,
          event.previousVersion,
        )
        break
      }
      case 'channel.deleted': {
        this.assertEventChannelVersion(
          event.package,
          event.channel,
          event.previousVersion,
        )
        break
      }
    }
  }

  private applyRegistryEventState(event: RegistryEvent): void {
    const packageId = eventPackageId(event)
    const lastEvent = {
      id: event.id,
      timestamp: event.timestamp,
    }

    this.applyPackageEventHead(
      packageId,
      lastEvent,
      event.eventType === 'release.published' ? 1 : 0,
    )

    switch (event.eventType) {
      case 'release.published': {
        const packageReleases =
          this.eventReleases.get(event.release.id) ??
          new Map<string, PackageStateRelease>()
        packageReleases.set(event.release.version, {
          createdAt: event.timestamp,
          manifestDigest: event.release.manifestDigest,
          version: event.release.version,
        })
        this.eventReleases.set(event.release.id, packageReleases)

        const packageChannels =
          this.eventChannels.get(event.release.id) ?? new Map<string, string>()
        packageChannels.set(event.channel, event.release.version)
        this.eventChannels.set(event.release.id, packageChannels)
        break
      }
      case 'channel.updated': {
        const packageChannels =
          this.eventChannels.get(event.package) ?? new Map<string, string>()
        packageChannels.set(event.channel, event.version)
        this.eventChannels.set(event.package, packageChannels)
        break
      }
      case 'channel.deleted': {
        const packageChannels =
          this.eventChannels.get(event.package) ?? new Map<string, string>()
        packageChannels.delete(event.channel)
        this.eventChannels.set(event.package, packageChannels)
        break
      }
    }
  }

  private applyPackageEventHead(
    packageId: PackageId,
    event: { id: Sha256Digest; timestamp: string },
    releaseIncrement: number,
  ): void {
    const previous = this.eventHeads.get(packageId)
    const modifiedAt =
      latestTimestamp([
        ...(previous?.modifiedAt ? [previous.modifiedAt] : []),
        event.timestamp,
      ]) ?? event.timestamp

    this.eventHeads.set(packageId, {
      lastEventId: event.id,
      lastEventTimestamp: event.timestamp,
      modifiedAt,
      releaseCount: (previous?.releaseCount ?? 0) + releaseIncrement,
    })
  }

  private applyPackageReleaseHead(
    packageId: PackageId,
    modifiedAt: string,
  ): void {
    const previous = this.releaseHeads.get(packageId)

    this.releaseHeads.set(packageId, {
      modifiedAt:
        latestTimestamp([
          ...(previous?.modifiedAt ? [previous.modifiedAt] : []),
          modifiedAt,
        ]) ?? modifiedAt,
      releaseCount: (previous?.releaseCount ?? 0) + 1,
    })
  }

  private assertExpectedChannelVersion(
    packageId: PackageId,
    channel: string,
    expectedVersion: string | undefined,
    actualVersion: string | undefined,
  ): void {
    if (actualVersion !== expectedVersion) {
      throw new PackageChannelConflictError(
        packageId,
        channel,
        expectedVersion,
        actualVersion,
      )
    }
  }

  private assertReleaseExists(packageId: PackageId, version: string): void {
    if (!this.releases.get(packageId)?.has(version)) {
      throw new ReleaseNotFoundError(packageId, version)
    }
  }

  private assertEventReleaseExists(
    packageId: PackageId,
    version: string,
  ): void {
    if (!this.eventReleases.get(packageId)?.has(version)) {
      throw new RegistryEventIntegrityError(
        `Registry event channel target version does not exist: ${version}`,
      )
    }
  }

  private assertEventChannelVersion(
    packageId: PackageId,
    channel: string,
    expectedVersion: string | undefined,
  ): void {
    const actualVersion = this.eventChannels.get(packageId)?.get(channel)

    if (actualVersion !== expectedVersion) {
      throw new RegistryEventIntegrityError(
        `Registry event previousVersion does not match indexed event channel state: ${packageId}#${channel}`,
      )
    }
  }
}

export class MemoryQueueAdapter implements QueueAdapter {
  readonly messages: Array<{ payload: unknown; topic: string }> = []

  checkReadiness(): Promise<void> {
    return Promise.resolve()
  }

  enqueue(topic: string, payload: unknown): Promise<void> {
    this.messages.push({ payload, topic })
    return Promise.resolve()
  }
}

export class MemorySignerAdapter implements SignerAdapter {
  async checkReadiness(): Promise<void> {
    const signature = await this.sign(
      new TextEncoder().encode('regesta-signer-readiness'),
    )

    if (signature.byteLength === 0) {
      throw new TypeError('Memory signer readiness probe returned empty bytes')
    }
  }

  sign(bytes: Uint8Array): Promise<Uint8Array> {
    return Promise.resolve(new TextEncoder().encode(sha256(bytes)))
  }
}

export function createMemoryRegistryAdapters(): RegistryAdapters {
  return {
    checkpoints: new MemoryCheckpointStore(),
    database: new MemoryRegistryDatabase(),
    objects: new MemoryObjectStore(),
    queue: new MemoryQueueAdapter(),
    signer: new MemorySignerAdapter(),
  }
}

export function stablePayloadDigest(payload: unknown): Sha256Digest {
  return sha256(canonicalJson(payload))
}

function eventAuthorizationPayloadDigest(
  event: RegistryEvent,
): Sha256Digest | undefined {
  return event.authorization?.payloadDigest
}

function eventPackageId(event: RegistryEvent): PackageId {
  return event.eventType === 'release.published'
    ? event.release.id
    : event.package
}

function latestTimestamp(timestamps: string[]): string | undefined {
  return timestamps.toSorted().at(-1)
}
