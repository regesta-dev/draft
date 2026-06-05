import {
  canonicalJson,
  sha256,
  type PackageId,
  type RegistryEvent,
  type Sha256Digest,
} from '@regesta/protocol'
import type {
  ObjectStore,
  QueueAdapter,
  RegistryAdapters,
  RegistryDatabase,
  SignerAdapter,
  StoredObject,
  StoredRelease,
} from './interfaces.ts'

export class MemoryObjectStore implements ObjectStore {
  readonly objects: Map<Sha256Digest, StoredObject> = new Map()

  get(digest: Sha256Digest): Promise<StoredObject | undefined> {
    return Promise.resolve(this.objects.get(digest))
  }

  put(
    bytes: Uint8Array,
    mediaType: string,
  ): Promise<StoredObject['descriptor']> {
    const digest = sha256(bytes)
    const descriptor = {
      digest,
      mediaType,
      size: bytes.byteLength,
    }

    this.objects.set(digest, {
      bytes,
      descriptor,
    })

    return Promise.resolve(descriptor)
  }
}

export class MemoryRegistryDatabase implements RegistryDatabase {
  readonly channels: Map<PackageId, Map<string, string>> = new Map()
  readonly events: RegistryEvent[] = []
  readonly releases: Map<PackageId, Map<string, StoredRelease>> = new Map()

  appendEvent(event: RegistryEvent): Promise<void> {
    this.events.push(event)
    return Promise.resolve()
  }

  getEventLog(): Promise<RegistryEvent[]> {
    return Promise.resolve([...this.events])
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

  getPackageChannels(packageId: PackageId): Promise<Record<string, string>> {
    return Promise.resolve(
      Object.fromEntries(this.channels.get(packageId)?.entries() ?? []),
    )
  }

  getRelease(
    packageId: PackageId,
    version: string,
  ): Promise<StoredRelease | undefined> {
    return Promise.resolve(this.releases.get(packageId)?.get(version))
  }

  listPackageReleases(packageId: PackageId): Promise<StoredRelease[]> {
    return Promise.resolve([...(this.releases.get(packageId)?.values() ?? [])])
  }

  putRelease(release: StoredRelease): Promise<void> {
    const packageId = release.manifest.id
    const versions =
      this.releases.get(packageId) ?? new Map<string, StoredRelease>()

    if (versions.has(release.manifest.version)) {
      throw new Error(
        `Release already exists: ${packageId}@${release.manifest.version}`,
      )
    }

    versions.set(release.manifest.version, release)
    this.releases.set(packageId, versions)
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
}

export class MemoryQueueAdapter implements QueueAdapter {
  readonly messages: Array<{ payload: unknown; topic: string }> = []

  enqueue(topic: string, payload: unknown): Promise<void> {
    this.messages.push({ payload, topic })
    return Promise.resolve()
  }
}

export class MemorySignerAdapter implements SignerAdapter {
  sign(bytes: Uint8Array): Promise<Uint8Array> {
    return Promise.resolve(new TextEncoder().encode(sha256(bytes)))
  }
}

export function createMemoryRegistryAdapters(): RegistryAdapters {
  return {
    database: new MemoryRegistryDatabase(),
    objects: new MemoryObjectStore(),
    queue: new MemoryQueueAdapter(),
    signer: new MemorySignerAdapter(),
  }
}

export function stablePayloadDigest(payload: unknown): Sha256Digest {
  return sha256(canonicalJson(payload as never))
}
