import {
  assertCanonicalTimestamp,
  assertPackageChannel,
  assertPackageVersion,
  assertRegistryEventId,
  assertSha256Digest,
  parsePackageId,
  type Ed25519PublicKeyJwk,
  type RegistryEvent,
} from '@regesta/protocol'
import { base64UrlToBytes, isBase64Url } from './base64.ts'
import { RegistryEventIntegrityError } from './storage.ts'

export function assertRegistryEventIntegrity(event: RegistryEvent): void {
  try {
    assertRegistryEventId(event)
  } catch (error) {
    throw new RegistryEventIntegrityError(
      error instanceof Error ? error.message : String(error),
    )
  }

  try {
    assertRegistryEventSemantics(event)
  } catch (error) {
    throw new RegistryEventIntegrityError(
      error instanceof Error ? error.message : String(error),
    )
  }
}

export function assertRegistryEventSemantics(event: RegistryEvent): void {
  assertRegistryEventKnownFields(event)

  if (event.object !== 'regesta.event') {
    throw new TypeError('Registry event object must be regesta.event')
  }

  if (event.specVersion !== 0) {
    throw new TypeError('Registry event specVersion must be 0')
  }

  assertCanonicalTimestamp(event.timestamp, 'Registry event timestamp')
  assertAuthorizationProof(event)

  switch (event.eventType) {
    case 'release.published': {
      assertKnownFields(event.release, ['id', 'manifestDigest', 'version'], {
        label: 'Registry event release',
      })
      parsePackageId(event.release.id)
      assertPackageChannel(event.channel, 'Registry event channel')
      assertPackageVersion(
        event.release.version,
        'Registry event release version',
      )
      assertSha256Digest(event.release.manifestDigest)
      assertSha256Digest(event.sourceDigest)
      assertNonEmptyArray(
        event.artifactDigests,
        'Registry event artifactDigests',
      )

      for (const digest of event.artifactDigests) {
        assertSha256Digest(digest)
      }
      break
    }
    case 'channel.deleted': {
      parsePackageId(event.package)
      assertPackageChannel(event.channel, 'Registry event channel')
      assertOptionalPackageVersion(
        event.previousVersion,
        'Registry event previousVersion',
      )
      break
    }
    case 'channel.updated': {
      parsePackageId(event.package)
      assertPackageChannel(event.channel, 'Registry event channel')
      assertOptionalPackageVersion(
        event.previousVersion,
        'Registry event previousVersion',
      )
      assertPackageVersion(event.version, 'Registry event version')
      break
    }
    default: {
      throw new TypeError('Unsupported registry event type')
    }
  }
}

function assertAuthorizationProof(event: RegistryEvent): void {
  if (!event.authorization) {
    return
  }

  const { authorization } = event
  assertKnownFields(
    authorization,
    [
      'alg',
      'domain',
      'kid',
      'object',
      'payloadDigest',
      'publicKeyJwk',
      'signature',
      'signedAt',
      'specVersion',
      'wellKnownDigest',
    ],
    { label: 'Registry event authorization' },
  )

  if (authorization.object !== 'regesta.authorization-proof') {
    throw new TypeError(
      'Registry event authorization object must be regesta.authorization-proof',
    )
  }

  if (authorization.specVersion !== 0) {
    throw new TypeError('Registry event authorization specVersion must be 0')
  }

  if (authorization.alg !== 'EdDSA') {
    throw new TypeError('Registry event authorization alg must be EdDSA')
  }

  if (authorization.domain !== eventOwnerDomain(event)) {
    throw new TypeError(
      'Registry event authorization domain does not match package owner',
    )
  }

  assertNonEmptyString(authorization.kid, 'Registry event authorization kid')
  assertEd25519Signature(
    authorization.signature,
    'Registry event authorization signature',
  )
  assertSha256Digest(authorization.payloadDigest)
  assertSha256Digest(authorization.wellKnownDigest)
  assertCanonicalTimestamp(
    authorization.signedAt,
    'Registry event authorization signedAt',
  )

  if (authorization.signedAt !== event.timestamp) {
    throw new TypeError(
      'Registry event authorization signedAt must match event timestamp',
    )
  }

  assertEd25519PublicKeyJwk(authorization.publicKeyJwk)
}

function assertEd25519PublicKeyJwk(publicKeyJwk: Ed25519PublicKeyJwk): void {
  assertKnownFields(publicKeyJwk, ['crv', 'kty', 'x'], {
    label: 'Registry event authorization publicKeyJwk',
  })

  if (publicKeyJwk.kty !== 'OKP') {
    throw new TypeError(
      'Registry event authorization publicKeyJwk kty must be OKP',
    )
  }

  if (publicKeyJwk.crv !== 'Ed25519') {
    throw new TypeError(
      'Registry event authorization publicKeyJwk crv must be Ed25519',
    )
  }

  assertNonEmptyString(
    publicKeyJwk.x,
    'Registry event authorization publicKeyJwk.x',
  )
  assertEd25519PublicKey(
    publicKeyJwk.x,
    'Registry event authorization publicKeyJwk.x',
  )
}

function assertRegistryEventKnownFields(event: RegistryEvent): void {
  switch (event.eventType) {
    case 'channel.deleted': {
      assertKnownFields(
        event,
        [
          'authorization',
          'channel',
          'eventType',
          'id',
          'object',
          'package',
          'previousVersion',
          'specVersion',
          'timestamp',
        ],
        { label: 'Registry event' },
      )
      break
    }
    case 'channel.updated': {
      assertKnownFields(
        event,
        [
          'authorization',
          'channel',
          'eventType',
          'id',
          'object',
          'package',
          'previousVersion',
          'specVersion',
          'timestamp',
          'version',
        ],
        { label: 'Registry event' },
      )
      break
    }
    case 'release.published': {
      assertKnownFields(
        event,
        [
          'artifactDigests',
          'authorization',
          'channel',
          'eventType',
          'id',
          'object',
          'release',
          'sourceDigest',
          'specVersion',
          'timestamp',
        ],
        { label: 'Registry event' },
      )
      break
    }
    default: {
      throw new TypeError('Unsupported registry event type')
    }
  }
}

function assertKnownFields(
  value: object,
  knownFields: readonly string[],
  options: { label: string },
): void {
  const known = new Set(knownFields)
  const unknown = Object.keys(value).find((key) => {
    return !known.has(key)
  })

  if (unknown) {
    throw new TypeError(
      `${options.label} must not include unknown field: ${unknown}`,
    )
  }
}

function assertEd25519Signature(value: string, label: string): void {
  const bytes = base64UrlBytes(value, label)

  if (bytes.byteLength !== 64) {
    throw new TypeError(`${label} must be an Ed25519 signature`)
  }
}

function assertEd25519PublicKey(value: string, label: string): void {
  const bytes = base64UrlBytes(value, label)

  if (bytes.byteLength !== 32) {
    throw new TypeError(`${label} must be an Ed25519 public key`)
  }
}

function base64UrlBytes(value: string, label: string): Uint8Array {
  if (!isBase64Url(value)) {
    throw new TypeError(`${label} must be base64url`)
  }

  return base64UrlToBytes(value)
}

function eventOwnerDomain(event: RegistryEvent): string {
  return parsePackageId(eventPackageId(event)).ownerDomain
}

function eventPackageId(event: RegistryEvent): string {
  return event.eventType === 'release.published'
    ? event.release.id
    : event.package
}

function assertNonEmptyString(
  value: unknown,
  label: string,
): asserts value is string {
  if (typeof value !== 'string') {
    throw new TypeError(`${label} must be a string`)
  }

  if (value.length === 0) {
    throw new TypeError(`${label} must not be empty`)
  }
}

function assertOptionalPackageVersion(
  value: unknown,
  label: string,
): asserts value is string | undefined {
  if (value !== undefined) {
    assertPackageVersion(value, label)
  }
}

function assertNonEmptyArray(value: unknown, label: string): void {
  if (!Array.isArray(value)) {
    throw new TypeError(`${label} must be an array`)
  }

  if (value.length === 0) {
    throw new TypeError(`${label} must not be empty`)
  }
}
