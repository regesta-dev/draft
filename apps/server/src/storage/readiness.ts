import { assertSha256Digest } from '@regesta/protocol'
import type { RegistryAdapters } from '@regesta/core'

const objectReadinessProbeDigest = assertSha256Digest(
  `sha256:${'0'.repeat(64)}`,
)
const signerReadinessProbeBytes = new TextEncoder().encode(
  'regesta-signer-readiness',
)

export function createStorageReadinessCheck(
  adapters: RegistryAdapters,
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
  return async () => {
    const checks = {
      database: await databaseReady(adapters),
      objects: await objectsReady(adapters),
      queue: await queueReady(adapters),
      signer: await signerReady(adapters),
    }

    return {
      checks,
      kind: 'regesta.readiness',
      ok: checks.database && checks.objects && checks.queue && checks.signer,
    }
  }
}

async function databaseReady(adapters: RegistryAdapters): Promise<boolean> {
  try {
    if (adapters.database.checkReadiness) {
      await adapters.database.checkReadiness()
      return true
    }

    await adapters.database.listEvents({ limit: 1 })
    return true
  } catch {
    return false
  }
}

async function queueReady(adapters: RegistryAdapters): Promise<boolean> {
  try {
    if (adapters.queue.checkReadiness) {
      await adapters.queue.checkReadiness()
      return true
    }

    return true
  } catch {
    return false
  }
}

async function signerReady(adapters: RegistryAdapters): Promise<boolean> {
  try {
    if (adapters.signer.checkReadiness) {
      await adapters.signer.checkReadiness()
      return true
    }

    const signature = await adapters.signer.sign(signerReadinessProbeBytes)
    return signature.byteLength > 0
  } catch {
    return false
  }
}

async function objectsReady(adapters: RegistryAdapters): Promise<boolean> {
  try {
    if (adapters.objects.checkReadiness) {
      await adapters.objects.checkReadiness()
      return true
    }

    await adapters.objects.getDescriptor(objectReadinessProbeDigest)
    return true
  } catch {
    return false
  }
}
