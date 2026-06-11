import { assertSha256Digest } from '@regesta/protocol'

const objectReadinessProbeDigest = assertSha256Digest(
  `sha256:${'0'.repeat(64)}`,
)
const signerReadinessProbeBytes = new TextEncoder().encode(
  'regesta-signer-readiness',
)
const defaultReadinessProbeTimeoutMs = 5_000

export interface StorageReadinessCheckOptions {
  timeoutMs?: number
}

export interface StorageReadinessAdapters {
  database: {
    checkReadiness?: () => Promise<void>
    listEvents: (options: { limit: number }) => Promise<unknown>
  }
  objects: {
    checkReadiness?: () => Promise<void>
    getDescriptor: (
      digest: typeof objectReadinessProbeDigest,
    ) => Promise<unknown>
  }
  queue: {
    checkReadiness?: () => Promise<void>
  }
  signer: {
    checkReadiness?: () => Promise<void>
    sign: (bytes: Uint8Array) => Promise<Uint8Array>
  }
}

export function createStorageReadinessCheck(
  adapters: StorageReadinessAdapters,
  options: StorageReadinessCheckOptions = {},
): () => Promise<{
  checks: {
    database: boolean
    objects: boolean
    queue: boolean
    signer: boolean
  }
  kind: 'regesta.readiness'
  ok: boolean
}> {
  const timeoutMs = normalizeReadinessProbeTimeout(options.timeoutMs)

  return async () => {
    const [database, objects, queue, signer] = await Promise.all([
      databaseReady(adapters, timeoutMs),
      objectsReady(adapters, timeoutMs),
      queueReady(adapters, timeoutMs),
      signerReady(adapters, timeoutMs),
    ])
    const checks = {
      database,
      objects,
      queue,
      signer,
    }

    return {
      checks,
      kind: 'regesta.readiness',
      ok: checks.database && checks.objects && checks.queue && checks.signer,
    }
  }
}

async function databaseReady(
  adapters: StorageReadinessAdapters,
  timeoutMs: number,
): Promise<boolean> {
  try {
    if (adapters.database.checkReadiness) {
      await withReadinessProbeTimeout(
        adapters.database.checkReadiness(),
        timeoutMs,
      )
      return true
    }

    await withReadinessProbeTimeout(
      adapters.database.listEvents({ limit: 1 }),
      timeoutMs,
    )
    return true
  } catch {
    return false
  }
}

async function queueReady(
  adapters: StorageReadinessAdapters,
  timeoutMs: number,
): Promise<boolean> {
  try {
    if (adapters.queue.checkReadiness) {
      await withReadinessProbeTimeout(
        adapters.queue.checkReadiness(),
        timeoutMs,
      )
      return true
    }

    return true
  } catch {
    return false
  }
}

async function signerReady(
  adapters: StorageReadinessAdapters,
  timeoutMs: number,
): Promise<boolean> {
  try {
    if (adapters.signer.checkReadiness) {
      await withReadinessProbeTimeout(
        adapters.signer.checkReadiness(),
        timeoutMs,
      )
      return true
    }

    const signature = await withReadinessProbeTimeout(
      adapters.signer.sign(signerReadinessProbeBytes),
      timeoutMs,
    )
    return signature.byteLength > 0
  } catch {
    return false
  }
}

async function objectsReady(
  adapters: StorageReadinessAdapters,
  timeoutMs: number,
): Promise<boolean> {
  try {
    if (adapters.objects.checkReadiness) {
      await withReadinessProbeTimeout(
        adapters.objects.checkReadiness(),
        timeoutMs,
      )
      return true
    }

    await withReadinessProbeTimeout(
      adapters.objects.getDescriptor(objectReadinessProbeDigest),
      timeoutMs,
    )
    return true
  } catch {
    return false
  }
}

function normalizeReadinessProbeTimeout(timeoutMs: number | undefined): number {
  const value = timeoutMs ?? defaultReadinessProbeTimeoutMs

  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(
      'Readiness probe timeout must be a positive safe integer',
    )
  }

  return value
}

function withReadinessProbeTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const timeout = setTimeout(() => {
      settled = true
      reject(new Error('Readiness probe timed out'))
    }, timeoutMs)

    promise.then(
      (value) => {
        if (settled) {
          return
        }

        settled = true
        clearTimeout(timeout)
        resolve(value)
      },
      (error: unknown) => {
        if (settled) {
          return
        }

        settled = true
        clearTimeout(timeout)
        reject(error)
      },
    )
  })
}
