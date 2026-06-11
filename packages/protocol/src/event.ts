import { canonicalJson } from './canonical-json.ts'
import { assertSha256Digest, sha256, type Sha256Digest } from './digest.ts'
import { parsePackageId } from './package-id.ts'
import {
  assertPackageChannel,
  assertPackageVersion,
  type PackageId,
} from './package.ts'
import { assertCanonicalTimestamp } from './timestamp.ts'
import type { WriteAuthorizationProof } from './auth.ts'

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

export function parseRegistryEvent(
  value: unknown,
  label = 'Registry event',
  options: { verifyId?: boolean } = {},
): RegistryEvent {
  const record = readRecord(value, label)
  const eventType = readString(record.eventType, `${label} eventType`)
  const id = assertSha256Digest(readString(record.id, `${label} id`))

  if (options.verifyId !== false) {
    assertRawRegistryEventId(record, id)
  }

  switch (eventType) {
    case 'channel.deleted': {
      assertKnownFields(
        record,
        [
          'authorization',
          'channel',
          'eventType',
          'id',
          'object',
          'package',
          'previousVersion',
          'timestamp',
        ],
        label,
      )

      const event: ChannelDeletedEvent = {
        ...optionalAuthorization(record.authorization, label),
        channel: assertPackageChannel(record.channel, `${label} channel`),
        eventType,
        id,
        object: readLiteral(record.object, 'regesta.event', `${label} object`),
        package: parsePackageId(readString(record.package, `${label} package`))
          .id,
        ...optionalPreviousVersion(record.previousVersion, label),
        timestamp: assertCanonicalTimestamp(
          readString(record.timestamp, `${label} timestamp`),
          `${label} timestamp`,
        ),
      }

      if (options.verifyId !== false) {
        assertRegistryEventId(event)
      }
      return event
    }
    case 'channel.updated': {
      assertKnownFields(
        record,
        [
          'authorization',
          'channel',
          'eventType',
          'id',
          'object',
          'package',
          'previousVersion',
          'timestamp',
          'version',
        ],
        label,
      )

      const event: ChannelUpdatedEvent = {
        ...optionalAuthorization(record.authorization, label),
        channel: assertPackageChannel(record.channel, `${label} channel`),
        eventType,
        id,
        object: readLiteral(record.object, 'regesta.event', `${label} object`),
        package: parsePackageId(readString(record.package, `${label} package`))
          .id,
        ...optionalPreviousVersion(record.previousVersion, label),
        timestamp: assertCanonicalTimestamp(
          readString(record.timestamp, `${label} timestamp`),
          `${label} timestamp`,
        ),
        version: assertPackageVersion(record.version, `${label} version`),
      }

      if (options.verifyId !== false) {
        assertRegistryEventId(event)
      }
      return event
    }
    case 'release.published': {
      assertKnownFields(
        record,
        [
          'artifactDigests',
          'authorization',
          'channel',
          'eventType',
          'id',
          'object',
          'release',
          'sourceDigest',
          'timestamp',
        ],
        label,
      )

      const release = readRecord(record.release, `${label} release`)
      assertKnownFields(
        release,
        ['id', 'manifestDigest', 'version'],
        `${label} release`,
      )

      const event: PublishReleaseEvent = {
        ...optionalAuthorization(record.authorization, label),
        artifactDigests: readDigestArray(
          record.artifactDigests,
          `${label} artifactDigests`,
        ),
        channel: assertPackageChannel(record.channel, `${label} channel`),
        eventType,
        id,
        object: readLiteral(record.object, 'regesta.event', `${label} object`),
        release: {
          id: parsePackageId(readString(release.id, `${label} release id`)).id,
          manifestDigest: assertSha256Digest(
            readString(
              release.manifestDigest,
              `${label} release manifestDigest`,
            ),
          ),
          version: assertPackageVersion(
            release.version,
            `${label} release version`,
          ),
        },
        sourceDigest: assertSha256Digest(
          readString(record.sourceDigest, `${label} sourceDigest`),
        ),
        timestamp: assertCanonicalTimestamp(
          readString(record.timestamp, `${label} timestamp`),
          `${label} timestamp`,
        ),
      }

      if (options.verifyId !== false) {
        assertRegistryEventId(event)
      }
      return event
    }
    default: {
      throw new TypeError(`Unsupported registry event type: ${eventType}`)
    }
  }
}

function assertRawRegistryEventId(
  record: Record<string, unknown>,
  id: Sha256Digest,
): void {
  const { id: _id, ...payload } = record
  const digest = sha256(canonicalJson(payload))

  if (id !== digest) {
    throw new TypeError(
      `Registry event id does not match canonical event payload: ${id}`,
    )
  }
}

function optionalAuthorization(
  value: unknown,
  label: string,
): { authorization?: WriteAuthorizationProof } {
  if (value === undefined) {
    return {}
  }

  return {
    authorization: parseAuthorizationProof(value, `${label} authorization`),
  }
}

function optionalPreviousVersion(
  value: unknown,
  label: string,
): { previousVersion?: string } {
  if (value === undefined) {
    return {}
  }

  return {
    previousVersion: assertPackageVersion(value, `${label} previousVersion`),
  }
}

function parseAuthorizationProof(
  value: unknown,
  label: string,
): WriteAuthorizationProof {
  const record = readRecord(value, label)
  const alg = readString(record.alg, `${label} alg`)
  const common = {
    domain: readString(record.domain, `${label} domain`),
    kid: readString(record.kid, `${label} kid`),
    object: readLiteral(
      record.object,
      'regesta.authorization-proof',
      `${label} object`,
    ),
    payloadDigest: assertSha256Digest(
      readString(record.payloadDigest, `${label} payloadDigest`),
    ),
    signature: readString(record.signature, `${label} signature`),
    signedAt: assertCanonicalTimestamp(
      readString(record.signedAt, `${label} signedAt`),
      `${label} signedAt`,
    ),
    wellKnownDigest: assertSha256Digest(
      readString(record.wellKnownDigest, `${label} wellKnownDigest`),
    ),
  }

  if (alg === 'EdDSA') {
    assertKnownFields(
      record,
      [
        'alg',
        'domain',
        'kid',
        'object',
        'payloadDigest',
        'publicKeyJwk',
        'signature',
        'signedAt',
        'wellKnownDigest',
      ],
      label,
    )

    return {
      ...common,
      alg,
      publicKeyJwk: parseEd25519PublicKeyJwk(
        record.publicKeyJwk,
        `${label} publicKeyJwk`,
      ),
    }
  }

  if (alg === 'ssh-ed25519') {
    assertKnownFields(
      record,
      [
        'alg',
        'domain',
        'kid',
        'object',
        'payloadDigest',
        'publicKey',
        'signature',
        'signedAt',
        'wellKnownDigest',
      ],
      label,
    )

    return {
      ...common,
      alg,
      publicKey: readString(record.publicKey, `${label} publicKey`),
    }
  }

  throw new TypeError(`${label} alg must be EdDSA or ssh-ed25519`)
}

function parseEd25519PublicKeyJwk(
  value: unknown,
  label: string,
): Extract<WriteAuthorizationProof, { alg: 'EdDSA' }>['publicKeyJwk'] {
  const record = readRecord(value, label)
  assertKnownFields(record, ['crv', 'kty', 'x'], label)

  return {
    crv: readLiteral(record.crv, 'Ed25519', `${label} crv`),
    kty: readLiteral(record.kty, 'OKP', `${label} kty`),
    x: readString(record.x, `${label} x`),
  }
}

function readDigestArray(value: unknown, label: string): Sha256Digest[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty array`)
  }

  return value.map((item, index) => {
    return assertSha256Digest(readString(item, `${label}[${index}]`))
  })
}

function assertKnownFields(
  record: Record<string, unknown>,
  knownFields: readonly string[],
  label: string,
): void {
  const known = new Set(knownFields)
  const unknown = Object.keys(record).find((key) => {
    return !known.has(key)
  })

  if (unknown) {
    throw new TypeError(`${label} must not include unknown field: ${unknown}`)
  }
}

function readRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`)
  }

  return Object.fromEntries(Object.entries(value))
}

function readString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`)
  }

  if (hasControlCharacter(value)) {
    throw new TypeError(`${label} must not include control characters`)
  }

  return value
}

function readLiteral<const T extends string>(
  value: unknown,
  expected: T,
  label: string,
): T {
  if (value !== expected) {
    throw new TypeError(`${label} must be ${expected}`)
  }

  return expected
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0)

    if (code !== undefined && (code <= 0x1f || code === 0x7f)) {
      return true
    }
  }

  return false
}
