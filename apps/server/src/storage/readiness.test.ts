import { createMemoryRegistryAdapters } from '@regesta/adapters'
import { describe, expect, it, vi } from 'vitest'
import { createStorageReadinessCheck } from './readiness.ts'

describe('createStorageReadinessCheck', () => {
  it('runs independent storage readiness probes concurrently', async () => {
    const adapters = createMemoryRegistryAdapters()
    const database = deferred<void>()
    const objects = deferred<void>()
    const queue = deferred<void>()
    const signer = deferred<void>()
    const started: string[] = []

    adapters.database.checkReadiness = () => {
      started.push('database')
      return database.promise
    }
    adapters.objects.checkReadiness = () => {
      started.push('objects')
      return objects.promise
    }
    adapters.queue.checkReadiness = () => {
      started.push('queue')
      return queue.promise
    }
    adapters.signer.checkReadiness = () => {
      started.push('signer')
      return signer.promise
    }

    const readiness = createStorageReadinessCheck(adapters)()

    await Promise.resolve()
    expect(started).toEqual(['database', 'objects', 'queue', 'signer'])

    database.resolve()
    objects.resolve()
    queue.resolve()
    signer.resolve()

    await expect(readiness).resolves.toEqual({
      checks: {
        database: true,
        objects: true,
        queue: true,
        signer: true,
      },
      kind: 'regesta.readiness',
      ok: true,
    })
  })

  it('does not short-circuit concurrent readiness probes after one fails', async () => {
    const adapters = createMemoryRegistryAdapters()
    const database = deferred<void>()
    const objects = deferred<void>()
    const queue = deferred<void>()
    const signer = deferred<void>()
    const started: string[] = []

    adapters.database.checkReadiness = () => {
      started.push('database')
      return database.promise
    }
    adapters.objects.checkReadiness = () => {
      started.push('objects')
      return objects.promise
    }
    adapters.queue.checkReadiness = () => {
      started.push('queue')
      return queue.promise
    }
    adapters.signer.checkReadiness = () => {
      started.push('signer')
      return signer.promise
    }

    const readiness = createStorageReadinessCheck(adapters)()

    await Promise.resolve()
    expect(started).toEqual(['database', 'objects', 'queue', 'signer'])

    database.reject(new Error('database unavailable'))
    objects.resolve()
    queue.resolve()
    signer.resolve()

    await expect(readiness).resolves.toEqual({
      checks: {
        database: false,
        objects: true,
        queue: true,
        signer: true,
      },
      kind: 'regesta.readiness',
      ok: false,
    })
  })

  it('bounds hung readiness probes with a timeout', async () => {
    vi.useFakeTimers()
    const adapters = createMemoryRegistryAdapters()
    const never = new Promise<void>(() => {})

    adapters.database.checkReadiness = () => never
    adapters.objects.checkReadiness = () => never
    adapters.queue.checkReadiness = () => never
    adapters.signer.checkReadiness = () => never

    try {
      const readiness = createStorageReadinessCheck(adapters, {
        timeoutMs: 50,
      })()

      await vi.advanceTimersByTimeAsync(50)

      await expect(readiness).resolves.toEqual({
        checks: {
          database: false,
          objects: false,
          queue: false,
          signer: false,
        },
        kind: 'regesta.readiness',
        ok: false,
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects invalid readiness probe timeout configuration', () => {
    expect(() =>
      createStorageReadinessCheck(createMemoryRegistryAdapters(), {
        timeoutMs: 0,
      }),
    ).toThrow('Readiness probe timeout must be a positive safe integer')
  })
})

function deferred<T>(): {
  promise: Promise<T>
  reject: (error: unknown) => void
  resolve: (value: T) => void
} {
  let rejectPromise: ((error: unknown) => void) | undefined
  let resolvePromise: ((value: T) => void) | undefined
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve
    rejectPromise = reject
  })

  if (!resolvePromise || !rejectPromise) {
    throw new Error('Failed to create deferred promise')
  }

  return {
    promise,
    reject: rejectPromise,
    resolve: resolvePromise,
  }
}
