import {
  canonicalJson,
  sha256,
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
  readonly events: RegistryEvent[] = []
  readonly releases: Map<`@${string}/${string}`, Map<string, StoredRelease>> =
    new Map()

  appendEvent(event: RegistryEvent): Promise<void> {
    this.events.push(event)
    return Promise.resolve()
  }

  getEventLog(): Promise<RegistryEvent[]> {
    return Promise.resolve([...this.events])
  }

  getRelease(
    coordinate: `@${string}/${string}`,
    version: string,
  ): Promise<StoredRelease | undefined> {
    return Promise.resolve(this.releases.get(coordinate)?.get(version))
  }

  listPackageReleases(
    coordinate: `@${string}/${string}`,
  ): Promise<StoredRelease[]> {
    return Promise.resolve([...(this.releases.get(coordinate)?.values() ?? [])])
  }

  putRelease(release: StoredRelease): Promise<void> {
    const coordinate = release.manifest.package
    const versions =
      this.releases.get(coordinate) ?? new Map<string, StoredRelease>()

    if (versions.has(release.manifest.version)) {
      throw new Error(
        `Release already exists: ${coordinate}@${release.manifest.version}`,
      )
    }

    versions.set(release.manifest.version, release)
    this.releases.set(coordinate, versions)
    return Promise.resolve()
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
