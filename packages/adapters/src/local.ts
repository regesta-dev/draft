import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import {
  assertObjectMediaType,
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

  async checkReadiness(): Promise<void> {
    const probeDirectory = join(this.root, 'objects')
    const probePath = join(probeDirectory, `.regesta-readiness-${randomUUID()}`)
    const probeText = 'regesta-readiness'

    await mkdir(probeDirectory, { recursive: true })

    try {
      await writeFile(probePath, probeText, { flag: 'wx' })

      if ((await readFile(probePath, 'utf8')) !== probeText) {
        throw new TypeError('Local object readiness probe read mismatch')
      }
    } finally {
      await rm(probePath, { force: true })
    }
  }

  async get(digest: Sha256Digest): Promise<StoredObject | undefined> {
    const objectPath = this.objectPath(digest)
    const metaPath = this.metaPath(digest)
    const bytes = await readLocalObjectFile(objectPath, digest, metaPath)

    if (!bytes) {
      return undefined
    }

    const descriptor = normalizeStoredObjectDescriptor(
      parseLocalObjectMetadata(
        await readLocalObjectMetadataFile(metaPath, digest),
        digest,
      ),
      digest,
    )

    if (descriptor.size !== bytes.byteLength) {
      throw new TypeError(`Local object size mismatch: ${digest}`)
    }

    if (sha256(bytes) !== digest) {
      throw new TypeError(`Local object bytes digest mismatch: ${digest}`)
    }

    return {
      bytes,
      descriptor,
    }
  }

  async getDescriptor(
    digest: Sha256Digest,
  ): Promise<StoredObject['descriptor'] | undefined> {
    const objectPath = this.objectPath(digest)
    const metaPath = this.metaPath(digest)
    const rawMetadata = await readOptionalLocalObjectMetadata(metaPath)

    if (rawMetadata === undefined) {
      if (await exists(objectPath)) {
        throw new TypeError(`Local object metadata missing: ${digest}`)
      }

      return undefined
    }

    const descriptor = normalizeStoredObjectDescriptor(
      parseLocalObjectMetadata(rawMetadata, digest),
      digest,
    )
    const objectStats = await statLocalObjectFile(objectPath, digest)

    if (objectStats.size !== descriptor.size) {
      throw new TypeError(`Local object size mismatch: ${digest}`)
    }

    return descriptor
  }

  async put(
    bytes: Uint8Array,
    mediaType: string,
  ): Promise<StoredObject['descriptor']> {
    assertObjectMediaType(mediaType)

    const objectBytes = bytes.slice()
    const digest = sha256(objectBytes)
    const descriptor = {
      digest,
      mediaType,
      size: objectBytes.byteLength,
    }
    const objectPath = this.objectPath(digest)
    const metaPath = this.metaPath(digest)
    const existing = await readLocalObjectForPut(objectPath, digest, metaPath)

    if (
      existing.descriptor?.mediaType !== undefined &&
      existing.descriptor.mediaType !== mediaType
    ) {
      throw new TypeError(`Local object mediaType conflict: ${digest}`)
    }

    if (existing.complete && existing.descriptor) {
      return existing.descriptor
    }

    await writeFileAtomically(objectPath, objectBytes)
    await writeFileAtomically(metaPath, `${canonicalJson(descriptor)}\n`)

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

async function statLocalObjectFile(
  objectPath: string,
  digest: Sha256Digest,
): Promise<{ size: number }> {
  try {
    return await stat(objectPath)
  } catch (error) {
    if (isNotFoundError(error)) {
      throw new TypeError(`Local object bytes missing: ${digest}`, {
        cause: error,
      })
    }

    throw error
  }
}

async function readLocalObjectForPut(
  objectPath: string,
  digest: Sha256Digest,
  metaPath: string,
): Promise<{
  complete: boolean
  descriptor?: StoredObject['descriptor']
}> {
  const [bytes, metadata] = await Promise.all([
    readOptionalLocalObjectBytes(objectPath),
    readOptionalLocalObjectMetadata(metaPath),
  ])
  const descriptor =
    metadata === undefined
      ? undefined
      : normalizeStoredObjectDescriptor(
          parseLocalObjectMetadata(metadata, digest),
          digest,
        )

  if (bytes === undefined) {
    return {
      complete: false,
      ...(descriptor ? { descriptor } : {}),
    }
  }

  if (sha256(bytes) !== digest) {
    throw new TypeError(`Local object bytes digest mismatch: ${digest}`)
  }

  if (descriptor === undefined) {
    return {
      complete: false,
    }
  }

  if (descriptor.size !== bytes.byteLength) {
    throw new TypeError(`Local object size mismatch: ${digest}`)
  }

  return {
    complete: true,
    descriptor,
  }
}

async function readLocalObjectFile(
  objectPath: string,
  digest: Sha256Digest,
  metaPath: string,
): Promise<Uint8Array | undefined> {
  try {
    return await readFile(objectPath)
  } catch (error) {
    if (!isNotFoundError(error)) {
      throw error
    }

    if (await exists(metaPath)) {
      throw new TypeError(`Local object bytes missing: ${digest}`, {
        cause: error,
      })
    }

    return undefined
  }
}

async function readOptionalLocalObjectBytes(
  objectPath: string,
): Promise<Uint8Array | undefined> {
  try {
    return await readFile(objectPath)
  } catch (error) {
    if (isNotFoundError(error)) {
      return undefined
    }

    throw error
  }
}

async function readOptionalLocalObjectMetadata(
  metaPath: string,
): Promise<string | undefined> {
  try {
    return await readFile(metaPath, 'utf8')
  } catch (error) {
    if (isNotFoundError(error)) {
      return undefined
    }

    throw error
  }
}

async function readLocalObjectMetadataFile(
  metaPath: string,
  digest: Sha256Digest,
): Promise<string> {
  try {
    return await readFile(metaPath, 'utf8')
  } catch (error) {
    if (isNotFoundError(error)) {
      throw new TypeError(`Local object metadata missing: ${digest}`, {
        cause: error,
      })
    }

    throw error
  }
}

async function writeFileAtomically(
  path: string,
  data: string | Uint8Array,
): Promise<void> {
  const directory = dirname(path)
  const temporaryPath = join(
    directory,
    `.${basename(path)}.${randomUUID()}.tmp`,
  )

  await mkdir(directory, { recursive: true })

  try {
    await writeFile(temporaryPath, data, { flag: 'wx' })
    await rename(temporaryPath, path)
  } catch (error) {
    await rm(temporaryPath, { force: true })
    throw error
  }
}

function parseLocalObjectMetadata(raw: string, digest: Sha256Digest): unknown {
  try {
    return JSON.parse(raw)
  } catch (error) {
    throw new TypeError(`Local object metadata invalid JSON: ${digest}`, {
      cause: error,
    })
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (isNotFoundError(error)) {
      return false
    }

    throw error
  }
}

function isNotFoundError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function normalizeStoredObjectDescriptor(
  value: unknown,
  expectedDigest: Sha256Digest,
): StoredObject['descriptor'] {
  if (!isRecord(value)) {
    throw new TypeError('Local object metadata must be an object')
  }

  const descriptor = value
  const unknownFields = Object.keys(descriptor).filter(
    (field) => !['digest', 'mediaType', 'size'].includes(field),
  )

  if (unknownFields.length > 0) {
    throw new TypeError(
      `Local object metadata must not include unknown field: ${unknownFields[0]}`,
    )
  }

  const digest =
    typeof descriptor.digest === 'string'
      ? assertSha256Digest(descriptor.digest)
      : undefined

  if (digest !== expectedDigest) {
    throw new TypeError(
      `Local object metadata digest mismatch: ${expectedDigest}`,
    )
  }

  if (
    typeof descriptor.size !== 'number' ||
    !Number.isSafeInteger(descriptor.size) ||
    descriptor.size < 0
  ) {
    throw new TypeError(
      `Local object metadata size mismatch: ${expectedDigest}`,
    )
  }

  if (
    typeof descriptor.mediaType !== 'string' ||
    descriptor.mediaType.length === 0
  ) {
    throw new TypeError(
      `Local object metadata media type mismatch: ${expectedDigest}`,
    )
  }
  assertObjectMediaType(descriptor.mediaType)

  return {
    digest,
    mediaType: descriptor.mediaType,
    size: descriptor.size,
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

  async checkReadiness(): Promise<void> {
    const probePath = join(
      this.root,
      `.regesta-queue-readiness-${randomUUID()}`,
    )
    const probeText = 'regesta-queue-readiness'

    await mkdir(this.root, { recursive: true })

    try {
      await writeFile(probePath, probeText, { flag: 'wx' })

      if ((await readFile(probePath, 'utf8')) !== probeText) {
        throw new TypeError('Local queue readiness probe read mismatch')
      }
    } finally {
      await rm(probePath, { force: true })
    }
  }

  async enqueue(topic: string, payload: unknown): Promise<void> {
    const line = `${JSON.stringify({ payload, topic })}\n`
    const queuePath = join(this.root, 'queue.ndjson')
    await mkdir(this.root, { recursive: true })
    await writeFile(queuePath, line, { flag: 'a' })
  }
}

export class LocalSignerAdapter implements SignerAdapter {
  async checkReadiness(): Promise<void> {
    const signature = await this.sign(
      new TextEncoder().encode('regesta-signer-readiness'),
    )

    if (signature.byteLength === 0) {
      throw new TypeError('Local signer readiness probe returned empty bytes')
    }
  }

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
