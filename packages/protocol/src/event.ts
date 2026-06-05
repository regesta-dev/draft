import type { WriteAuthorizationProof } from './auth.ts'
import type { Sha256Digest } from './digest.ts'
import type { PackageId } from './package.ts'

export type RegistryEvent =
  | ChannelDeletedEvent
  | ChannelUpdatedEvent
  | PublishReleaseEvent

export interface PublishReleaseEvent {
  authorization?: WriteAuthorizationProof
  artifactDigests: Sha256Digest[]
  channel: string
  eventType: 'release.published'
  id: Sha256Digest
  object: 'regesta.event'
  release: {
    id: PackageId
    manifestDigest: Sha256Digest
    version: string
  }
  sourceDigest: Sha256Digest
  specVersion: 0
  timestamp: string
}

export interface ChannelUpdatedEvent {
  authorization?: WriteAuthorizationProof
  channel: string
  eventType: 'channel.updated'
  id: Sha256Digest
  object: 'regesta.event'
  package: PackageId
  previousVersion?: string
  specVersion: 0
  timestamp: string
  version: string
}

export interface ChannelDeletedEvent {
  authorization?: WriteAuthorizationProof
  channel: string
  eventType: 'channel.deleted'
  id: Sha256Digest
  object: 'regesta.event'
  package: PackageId
  previousVersion?: string
  specVersion: 0
  timestamp: string
}
