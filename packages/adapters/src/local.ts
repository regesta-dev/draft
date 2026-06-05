import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  assertSha256Digest,
  canonicalJson,
  sha256,
  type Sha256Digest,
} from '@regesta/protocol'
import { SQLiteRegistryDatabase } from './sqlite.ts'
import type {
  ObjectStore,
  QueueAdapter,
  RegistryAdapters,
  RegistryDatabase,
  SignerAdapter,
  StoredObject,
} from './interfaces.ts'

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

export class LocalRegistryDatabase
  extends SQLiteRegistryDatabase
  implements RegistryDatabase
{
  constructor(root: string) {
    super(join(root, 'registry.sqlite'))
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
