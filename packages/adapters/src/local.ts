import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  assertSha256Digest,
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

interface LocalDatabaseFile {
  channels: Record<string, Record<string, string>>
  events: RegistryEvent[]
  releases: Record<string, Record<string, StoredRelease>>
}

const emptyDatabase = (): LocalDatabaseFile => ({
  channels: {},
  events: [],
  releases: {},
})

export class LocalObjectStore implements ObjectStore {
  private readonly root: string

  constructor(root: string) {
    this.root = root
  }

  async get(digest: Sha256Digest): Promise<StoredObject | undefined> {
    try {
      const bytes = await readFile(this.objectPath(digest))
      const meta = JSON.parse(
        await readFile(this.metaPath(digest), 'utf8'),
      ) as StoredObject['descriptor']

      return {
        bytes,
        descriptor: {
          digest: assertSha256Digest(meta.digest),
          mediaType: meta.mediaType,
          size: meta.size,
        },
      }
    } catch (error) {
      if (
        error instanceof Error &&
        'code' in error &&
        error.code === 'ENOENT'
      ) {
        return undefined
      }

      throw error
    }
  }

  async put(
    bytes: Uint8Array,
    mediaType: string,
  ): Promise<StoredObject['descriptor']> {
    const digest = sha256(bytes)
    const descriptor = {
      digest,
      mediaType,
      size: bytes.byteLength,
    }

    await mkdir(dirname(this.objectPath(digest)), { recursive: true })
    await writeFile(this.objectPath(digest), bytes)
    await writeFile(this.metaPath(digest), `${canonicalJson(descriptor)}\n`)

    return descriptor
  }

  private metaPath(digest: Sha256Digest): string {
    return `${this.objectPath(digest)}.json`
  }

  private objectPath(digest: Sha256Digest): string {
    const hex = digest.slice('sha256:'.length)
    return join(this.root, 'objects', hex.slice(0, 2), hex)
  }
}

export class LocalRegistryDatabase implements RegistryDatabase {
  private readonly root: string

  constructor(root: string) {
    this.root = root
  }

  async appendEvent(event: RegistryEvent): Promise<void> {
    const database = await this.read()
    database.events.push(event)
    await this.write(database)
  }

  async getEventLog(): Promise<RegistryEvent[]> {
    return (await this.read()).events
  }

  async deletePackageChannel(
    packageId: PackageId,
    channel: string,
  ): Promise<string | undefined> {
    const database = await this.read()
    database.channels[packageId] ??= {}
    const previousVersion = database.channels[packageId][channel]
    delete database.channels[packageId][channel]
    await this.write(database)
    return previousVersion
  }

  async getPackageChannels(
    packageId: PackageId,
  ): Promise<Record<string, string>> {
    const channels = (await this.read()).channels[packageId]
    return channels ? { ...channels } : {}
  }

  async getRelease(
    packageId: PackageId,
    version: string,
  ): Promise<StoredRelease | undefined> {
    return (await this.read()).releases[packageId]?.[version]
  }

  async listPackageReleases(packageId: PackageId): Promise<StoredRelease[]> {
    return Object.values((await this.read()).releases[packageId] ?? {})
  }

  async putRelease(release: StoredRelease): Promise<void> {
    const database = await this.read()
    const packageId = release.manifest.id
    database.releases[packageId] ??= {}

    if (database.releases[packageId]![release.manifest.version]) {
      throw new Error(
        `Release already exists: ${packageId}@${release.manifest.version}`,
      )
    }

    database.releases[packageId]![release.manifest.version] = release
    await this.write(database)
  }

  async setPackageChannel(
    packageId: PackageId,
    channel: string,
    version: string,
  ): Promise<string | undefined> {
    const database = await this.read()
    database.channels[packageId] ??= {}
    const previousVersion = database.channels[packageId][channel]
    database.channels[packageId][channel] = version
    await this.write(database)
    return previousVersion
  }

  private async read(): Promise<LocalDatabaseFile> {
    try {
      const database = JSON.parse(
        await readFile(this.databasePath(), 'utf8'),
      ) as LocalDatabaseFile
      database.channels ??= {}
      database.events ??= []
      database.releases ??= {}
      return database
    } catch (error) {
      if (
        error instanceof Error &&
        'code' in error &&
        error.code === 'ENOENT'
      ) {
        return emptyDatabase()
      }

      throw error
    }
  }

  private databasePath(): string {
    return join(this.root, 'db.json')
  }

  private async write(database: LocalDatabaseFile): Promise<void> {
    await mkdir(this.root, { recursive: true })
    const temporaryPath = `${this.databasePath()}.tmp`
    await writeFile(temporaryPath, `${canonicalJson(database as never)}\n`)
    await rename(temporaryPath, this.databasePath())
  }
}

export class LocalQueueAdapter implements QueueAdapter {
  private readonly root: string

  constructor(root: string) {
    this.root = root
  }

  async enqueue(topic: string, payload: unknown): Promise<void> {
    const line = `${JSON.stringify({ payload, topic })}\n`
    const queuePath = join(this.root, 'queue.ndjson')
    await mkdir(this.root, { recursive: true })
    await writeFile(queuePath, line, { flag: 'a' })
  }
}

export class LocalSignerAdapter implements SignerAdapter {
  sign(bytes: Uint8Array): Promise<Uint8Array> {
    return Promise.resolve(new TextEncoder().encode(sha256(bytes)))
  }
}

export function createLocalRegistryAdapters(root: string): RegistryAdapters {
  return {
    database: new LocalRegistryDatabase(root),
    objects: new LocalObjectStore(root),
    queue: new LocalQueueAdapter(root),
    signer: new LocalSignerAdapter(),
  }
}
