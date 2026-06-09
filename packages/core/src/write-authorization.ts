import type { RegistryAdapters } from './storage.ts'
import type { WriteAuthorizationProof } from '@regesta/protocol'

export class WriteAuthorizationReplayError extends Error {
  constructor(payloadDigest: string) {
    super(`Write authorization already used: ${payloadDigest}`)
    this.name = 'WriteAuthorizationReplayError'
  }
}

export async function assertWriteAuthorizationIsFresh(
  adapters: RegistryAdapters,
  authorization: WriteAuthorizationProof | undefined,
): Promise<void> {
  if (!authorization) {
    return
  }

  const replayed = await adapters.database.hasAuthorizationPayloadDigest(
    authorization.payloadDigest,
  )

  if (replayed) {
    throw new WriteAuthorizationReplayError(authorization.payloadDigest)
  }
}
