import { canonicalJson } from './canonical-json.ts'
import { sha256, type Sha256Digest } from './digest.ts'
import type { WriteAuthorizationProof } from './auth.ts'
import type { PackageId } from './package.ts'

export type RegistryEvent =
  | ChannelDeletedEvent
  | ChannelUpdatedEvent
  | PublishReleaseEvent

export type RegistryEventPayload =
  | ChannelDeletedEventPayload
  | ChannelUpdatedEventPayload
  | PublishReleaseEventPayload

export type PublishReleaseEventPayload = Omit<PublishReleaseEvent, 'id'>
export type ChannelUpdatedEventPayload = Omit<ChannelUpdatedEvent, 'id'>
export type ChannelDeletedEventPayload = Omit<ChannelDeletedEvent, 'id'>

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

export function registryEventPayload(
  event: RegistryEvent,
): RegistryEventPayload {
  assertRegistryEventRecord(event)

  switch (event.eventType) {
    case 'channel.deleted': {
      const { id: _id, ...payload } = event
      return payload
    }
    case 'channel.updated': {
      const { id: _id, ...payload } = event
      return payload
    }
    case 'release.published': {
      const { id: _id, ...payload } = event
      return payload
    }
  }

  throw new TypeError('Unsupported registry event type')
}

export function registryEventDigest(
  event: RegistryEvent | RegistryEventPayload,
): Sha256Digest {
  return sha256(canonicalJson(registryEventCanonicalPayload(event)))
}

function registryEventCanonicalPayload(
  event: RegistryEvent | RegistryEventPayload,
): RegistryEventPayload {
  assertRegistryEventRecord(event)

  if ('id' in event) {
    return registryEventPayload(event)
  }

  assertSupportedRegistryEventType(event.eventType)
  return event
}

function assertRegistryEventRecord(
  event: RegistryEvent | RegistryEventPayload,
): void {
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    throw new TypeError('Registry event must be an object')
  }
}

function assertSupportedRegistryEventType(eventType: string): void {
  if (
    eventType !== 'channel.deleted' &&
    eventType !== 'channel.updated' &&
    eventType !== 'release.published'
  ) {
    throw new TypeError('Unsupported registry event type')
  }
}

export function assertRegistryEventId(event: RegistryEvent): Sha256Digest {
  const digest = registryEventDigest(event)

  if (event.id !== digest) {
    throw new TypeError(
      `Registry event id does not match canonical event payload: ${event.id}`,
    )
  }

  return digest
}
