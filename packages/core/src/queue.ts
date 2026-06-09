import type { RegistryAdapters } from './storage.ts'

export function enqueueDerivedRegistryJob(
  adapters: RegistryAdapters,
  topic: string,
  payload: unknown,
): void {
  try {
    const enqueue = adapters.queue.enqueue(topic, payload)
    enqueue.catch((error: unknown) => {
      logDerivedQueueFailure(topic, payload, error)
    })
  } catch (error) {
    logDerivedQueueFailure(topic, payload, error)
  }
}

function logDerivedQueueFailure(
  topic: string,
  payload: unknown,
  error: unknown,
): void {
  // Queue jobs are derived from committed registry events and can be rebuilt.
  console.error('Regesta derived queue enqueue failed', {
    error,
    kind: 'regesta.derived-queue-failure',
    payload,
    topic,
  })
}
