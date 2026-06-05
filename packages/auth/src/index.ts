import { Buffer } from 'node:buffer'
import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto'
import {
  assertSha256Digest,
  canonicalJson,
  defaultPackageChannel,
  parsePackageId,
  sha256,
  type CanonicalJsonValue,
  type PackageId,
  type Sha256Digest,
  type WriteAuthorizationProof,
} from '@regesta/protocol'

export type WriteOperation =
  | 'channel.delete'
  | 'channel.update'
  | 'release.publish'

export interface Ed25519PublicKeyJwk {
  crv: 'Ed25519'
  kty: 'OKP'
  x: string
}

export interface Ed25519PrivateKeyJwk extends Ed25519PublicKeyJwk {
  d: string
}

export interface DomainBinding {
  domain: string
  keys: DomainBindingKey[]
  object: 'regesta.domain-binding'
  specVersion: 0
}

export interface DomainBindingKey {
  alg: 'EdDSA'
  createdAt?: string
  expiresAt?: string
  kid: string
  publicKeyJwk: Ed25519PublicKeyJwk
  use: 'regesta-write'
}

export interface WriteAuthorization {
  alg: 'EdDSA'
  kid: string
  payload: WriteIntent
  signature: string
}

export type WriteIntent =
  | ChannelDeleteIntent
  | ChannelUpdateIntent
  | ReleasePublishIntent

export interface WriteIntentBase {
  domain: string
  nonce: string
  object: 'regesta.write-intent'
  operation: WriteOperation
  package: PackageId
  specVersion: 0
  timestamp: string
}

export interface ReleasePublishIntent extends WriteIntentBase {
  artifactDigests: Sha256Digest[]
  channel: string
  configDigest: Sha256Digest
  operation: 'release.publish'
  sourceDigest: Sha256Digest
  version: string
}

export interface ChannelUpdateIntent extends WriteIntentBase {
  channel: string
  operation: 'channel.update'
  previousVersion?: string
  version: string
}

export interface ChannelDeleteIntent extends WriteIntentBase {
  channel: string
  operation: 'channel.delete'
  previousVersion?: string
}

export interface CreateReleasePublishIntentInput {
  artifactDigests: Sha256Digest[]
  configDigest: Sha256Digest
  nonce: string
  packageId: PackageId
  sourceDigest: Sha256Digest
  timestamp: string
  version: string
}

export interface CreateChannelUpdateIntentInput {
  channel: string
  nonce: string
  packageId: PackageId
  previousVersion?: string
  timestamp: string
  version: string
}

export interface CreateChannelDeleteIntentInput {
  channel: string
  nonce: string
  packageId: PackageId
  previousVersion?: string
  timestamp: string
}

export interface CreateWriteAuthorizationInput {
  kid: string
  privateKeyJwk: Ed25519PrivateKeyJwk
}

export interface VerifyWriteAuthorizationInput {
  authorization: unknown
  expectedIntent: WriteIntent
  fetchBinding?: typeof fetch
  now?: Date
  timestampToleranceMs?: number
}

export class WriteAuthorizationError extends Error {
  readonly issues: string[]

  constructor(message: string, issues: string[] = []) {
    super(message)
    this.name = 'WriteAuthorizationError'
    this.issues = issues
  }
}

const defaultTimestampToleranceMs = 10 * 60 * 1000

export function createReleasePublishIntent(
  input: CreateReleasePublishIntentInput,
): ReleasePublishIntent {
  const packageId = parsePackageId(input.packageId).id

  return {
    artifactDigests: input.artifactDigests,
    channel: defaultPackageChannel,
    configDigest: input.configDigest,
    domain: ownerDomainFromPackageId(packageId),
    nonce: input.nonce,
    object: 'regesta.write-intent',
    operation: 'release.publish',
    package: packageId,
    sourceDigest: input.sourceDigest,
    specVersion: 0,
    timestamp: input.timestamp,
    version: input.version,
  }
}

export function createChannelUpdateIntent(
  input: CreateChannelUpdateIntentInput,
): ChannelUpdateIntent {
  const packageId = parsePackageId(input.packageId).id

  return {
    channel: input.channel,
    domain: ownerDomainFromPackageId(packageId),
    nonce: input.nonce,
    object: 'regesta.write-intent',
    operation: 'channel.update',
    package: packageId,
    ...(input.previousVersion
      ? { previousVersion: input.previousVersion }
      : {}),
    specVersion: 0,
    timestamp: input.timestamp,
    version: input.version,
  }
}

export function createChannelDeleteIntent(
  input: CreateChannelDeleteIntentInput,
): ChannelDeleteIntent {
  const packageId = parsePackageId(input.packageId).id

  return {
    channel: input.channel,
    domain: ownerDomainFromPackageId(packageId),
    nonce: input.nonce,
    object: 'regesta.write-intent',
    operation: 'channel.delete',
    package: packageId,
    ...(input.previousVersion
      ? { previousVersion: input.previousVersion }
      : {}),
    specVersion: 0,
    timestamp: input.timestamp,
  }
}

export function createWriteAuthorization(
  intent: WriteIntent,
  input: CreateWriteAuthorizationInput,
): WriteAuthorization {
  const payload = canonicalIntent(intent)
  const signature = sign(
    null,
    payloadBytes(payload),
    createPrivateKey({
      format: 'jwk',
      key: input.privateKeyJwk,
    }),
  )

  return {
    alg: 'EdDSA',
    kid: input.kid,
    payload,
    signature: base64UrlEncode(signature),
  }
}

export function readWriteAuthorization(value: unknown): WriteAuthorization {
  return normalizeWriteAuthorization(value)
}

export async function verifyWriteAuthorization(
  input: VerifyWriteAuthorizationInput,
): Promise<WriteAuthorizationProof> {
  const authorization = normalizeWriteAuthorization(input.authorization)
  const expectedIntent = canonicalIntent(input.expectedIntent)

  if (
    canonicalJsonIntent(authorization.payload) !==
    canonicalJsonIntent(expectedIntent)
  ) {
    throw new WriteAuthorizationError('Write authorization payload mismatch')
  }

  assertFreshTimestamp(
    authorization.payload.timestamp,
    input.now ?? new Date(),
    input.timestampToleranceMs ?? defaultTimestampToleranceMs,
  )

  const bindingResponse = await fetchDomainBinding(
    authorization.payload.domain,
    input.fetchBinding ?? fetch,
  )
  const binding = normalizeDomainBinding(
    JSON.parse(bindingResponse.text),
    authorization.payload.domain,
  )
  const key = activeWriteKey(
    binding,
    authorization.kid,
    input.now ?? new Date(),
  )

  if (!key) {
    throw new WriteAuthorizationError(
      'Domain binding key not found or inactive',
    )
  }

  if (authorization.alg !== key.alg) {
    throw new WriteAuthorizationError('Write authorization algorithm mismatch')
  }

  const ok = verify(
    null,
    payloadBytes(authorization.payload),
    createPublicKey({
      format: 'jwk',
      key: key.publicKeyJwk,
    }),
    base64UrlDecode(authorization.signature),
  )

  if (!ok) {
    throw new WriteAuthorizationError('Invalid write authorization signature')
  }

  return {
    alg: authorization.alg,
    domain: authorization.payload.domain,
    kid: authorization.kid,
    object: 'regesta.authorization-proof',
    payloadDigest: sha256(canonicalJsonIntent(authorization.payload)),
    publicKeyJwk: key.publicKeyJwk,
    signature: authorization.signature,
    signedAt: authorization.payload.timestamp,
    specVersion: 0,
    wellKnownDigest: sha256(bindingResponse.text),
  }
}

export function ownerDomainFromPackageId(packageId: PackageId): string {
  const parsed = parsePackageId(packageId)

  if (parsed.ecosystem === 'npm' && parsed.scope) {
    return parsed.scope
  }

  const domain = parsed.name.split('/')[0]

  if (!domain?.includes('.')) {
    throw new WriteAuthorizationError(
      `Package id does not include an owner domain: ${packageId}`,
    )
  }

  return domain.toLowerCase()
}

export function domainBindingUrl(domain: string): string {
  return `https://${domain}/.well-known/regesta.json`
}

async function fetchDomainBinding(
  domain: string,
  fetchBinding: typeof fetch,
): Promise<{ text: string }> {
  const response = await fetchBinding(domainBindingUrl(domain), {
    headers: {
      accept: 'application/json',
    },
  })

  if (!response.ok) {
    throw new WriteAuthorizationError('Domain binding not found')
  }

  return {
    text: await response.text(),
  }
}

function normalizeWriteAuthorization(value: unknown): WriteAuthorization {
  if (!isRecord(value)) {
    throw new WriteAuthorizationError('Write authorization must be an object')
  }

  if (value.alg !== 'EdDSA') {
    throw new WriteAuthorizationError('Write authorization alg must be EdDSA')
  }

  if (typeof value.kid !== 'string' || value.kid.length === 0) {
    throw new WriteAuthorizationError('Write authorization must include kid')
  }

  if (typeof value.signature !== 'string' || value.signature.length === 0) {
    throw new WriteAuthorizationError(
      'Write authorization must include signature',
    )
  }

  return {
    alg: value.alg,
    kid: value.kid,
    payload: normalizeWriteIntent(value.payload),
    signature: value.signature,
  }
}

function normalizeWriteIntent(value: unknown): WriteIntent {
  if (!isRecord(value)) {
    throw new WriteAuthorizationError('Write intent must be an object')
  }

  const base = normalizeWriteIntentBase(value)

  if (value.operation === 'release.publish') {
    return {
      ...base,
      artifactDigests: normalizeDigestArray(value.artifactDigests),
      channel:
        value.channel === undefined
          ? defaultPackageChannel
          : normalizeString(value.channel, 'channel'),
      configDigest: normalizeDigest(value.configDigest, 'configDigest'),
      operation: 'release.publish',
      sourceDigest: normalizeDigest(value.sourceDigest, 'sourceDigest'),
      version: normalizeString(value.version, 'version'),
    }
  }

  if (value.operation === 'channel.update') {
    return {
      ...base,
      channel: normalizeString(value.channel, 'channel'),
      operation: 'channel.update',
      ...(value.previousVersion === undefined
        ? {}
        : {
            previousVersion: normalizeString(
              value.previousVersion,
              'previousVersion',
            ),
          }),
      version: normalizeString(value.version, 'version'),
    }
  }

  if (value.operation === 'channel.delete') {
    return {
      ...base,
      channel: normalizeString(value.channel, 'channel'),
      operation: 'channel.delete',
      ...(value.previousVersion === undefined
        ? {}
        : {
            previousVersion: normalizeString(
              value.previousVersion,
              'previousVersion',
            ),
          }),
    }
  }

  throw new WriteAuthorizationError('Unsupported write intent operation')
}

type WriteIntentBaseFields = Omit<WriteIntentBase, 'operation'>

function normalizeWriteIntentBase(
  value: Record<string, unknown>,
): WriteIntentBaseFields {
  if (value.object !== 'regesta.write-intent') {
    throw new WriteAuthorizationError(
      'Write intent object must be regesta.write-intent',
    )
  }

  if (value.specVersion !== 0) {
    throw new WriteAuthorizationError('Write intent specVersion must be 0')
  }

  return {
    domain: normalizeDomain(value.domain),
    nonce: normalizeString(value.nonce, 'nonce'),
    object: 'regesta.write-intent',
    package: parsePackageId(normalizeString(value.package, 'package')).id,
    specVersion: 0,
    timestamp: normalizeString(value.timestamp, 'timestamp'),
  }
}

function normalizeDomainBinding(
  value: unknown,
  expectedDomain: string,
): DomainBinding {
  if (!isRecord(value)) {
    throw new WriteAuthorizationError('Domain binding must be an object')
  }

  if (value.object !== 'regesta.domain-binding') {
    throw new WriteAuthorizationError(
      'Domain binding object must be regesta.domain-binding',
    )
  }

  if (value.specVersion !== 0) {
    throw new WriteAuthorizationError('Domain binding specVersion must be 0')
  }

  const domain = normalizeDomain(value.domain)
  if (domain !== expectedDomain) {
    throw new WriteAuthorizationError('Domain binding domain mismatch')
  }

  if (!Array.isArray(value.keys)) {
    throw new WriteAuthorizationError('Domain binding keys must be an array')
  }

  return {
    domain,
    keys: value.keys.map((key) => normalizeDomainBindingKey(key)),
    object: 'regesta.domain-binding',
    specVersion: 0,
  }
}

function normalizeDomainBindingKey(value: unknown): DomainBindingKey {
  if (!isRecord(value)) {
    throw new WriteAuthorizationError('Domain binding key must be an object')
  }

  if (value.alg !== 'EdDSA') {
    throw new WriteAuthorizationError('Domain binding key alg must be EdDSA')
  }

  if (value.use !== 'regesta-write') {
    throw new WriteAuthorizationError(
      'Domain binding key use must be regesta-write',
    )
  }

  return {
    alg: value.alg,
    ...(value.createdAt === undefined
      ? {}
      : { createdAt: normalizeString(value.createdAt, 'createdAt') }),
    ...(value.expiresAt === undefined
      ? {}
      : { expiresAt: normalizeString(value.expiresAt, 'expiresAt') }),
    kid: normalizeString(value.kid, 'kid'),
    publicKeyJwk: normalizePublicKeyJwk(value.publicKeyJwk),
    use: value.use,
  }
}

function normalizePublicKeyJwk(value: unknown): Ed25519PublicKeyJwk {
  if (!isRecord(value)) {
    throw new WriteAuthorizationError('publicKeyJwk must be an object')
  }

  if (value.kty !== 'OKP') {
    throw new WriteAuthorizationError('publicKeyJwk kty must be OKP')
  }

  if (value.crv !== 'Ed25519') {
    throw new WriteAuthorizationError('publicKeyJwk crv must be Ed25519')
  }

  return {
    crv: value.crv,
    kty: value.kty,
    x: normalizeString(value.x, 'publicKeyJwk.x'),
  }
}

function activeWriteKey(
  binding: DomainBinding,
  kid: string,
  now: Date,
): DomainBindingKey | undefined {
  return binding.keys.find((key) => {
    if (key.kid !== kid) {
      return false
    }

    if (key.createdAt && Date.parse(key.createdAt) > now.getTime()) {
      return false
    }

    if (key.expiresAt && Date.parse(key.expiresAt) <= now.getTime()) {
      return false
    }

    return true
  })
}

function assertFreshTimestamp(
  timestamp: string,
  now: Date,
  toleranceMs: number,
): void {
  const time = Date.parse(timestamp)

  if (!Number.isFinite(time)) {
    throw new WriteAuthorizationError('Write intent timestamp is invalid')
  }

  if (Math.abs(now.getTime() - time) > toleranceMs) {
    throw new WriteAuthorizationError(
      'Write intent timestamp is outside window',
    )
  }
}

function canonicalIntent(intent: WriteIntent): WriteIntent {
  return normalizeWriteIntent(intent)
}

function payloadBytes(payload: WriteIntent): Uint8Array {
  return new TextEncoder().encode(canonicalJsonIntent(payload))
}

function canonicalJsonIntent(intent: WriteIntent): string {
  return canonicalJson(writeIntentJson(intent))
}

function writeIntentJson(intent: WriteIntent): CanonicalJsonValue {
  const base = {
    domain: intent.domain,
    nonce: intent.nonce,
    object: intent.object,
    operation: intent.operation,
    package: intent.package,
    specVersion: intent.specVersion,
    timestamp: intent.timestamp,
  }

  if (intent.operation === 'release.publish') {
    return {
      ...base,
      artifactDigests: intent.artifactDigests,
      channel: intent.channel,
      configDigest: intent.configDigest,
      sourceDigest: intent.sourceDigest,
      version: intent.version,
    }
  }

  if (intent.operation === 'channel.update') {
    return {
      ...base,
      channel: intent.channel,
      ...(intent.previousVersion
        ? { previousVersion: intent.previousVersion }
        : {}),
      version: intent.version,
    }
  }

  return {
    ...base,
    channel: intent.channel,
    ...(intent.previousVersion
      ? { previousVersion: intent.previousVersion }
      : {}),
  }
}

function normalizeDigestArray(value: unknown): Sha256Digest[] {
  if (!Array.isArray(value)) {
    throw new WriteAuthorizationError('artifactDigests must be an array')
  }

  return value.map((item) => normalizeDigest(item, 'artifactDigests'))
}

function normalizeDigest(value: unknown, field: string): Sha256Digest {
  const digest = normalizeString(value, field)

  if (!/^sha256:[a-f0-9]{64}$/u.test(digest)) {
    throw new WriteAuthorizationError(`${field} must be a sha256 digest`)
  }

  return assertSha256Digest(digest)
}

function normalizeDomain(value: unknown): string {
  const domain = normalizeString(value, 'domain').toLowerCase()

  if (!domain.includes('.')) {
    throw new WriteAuthorizationError('Domain must include a dot')
  }

  return domain
}

function normalizeString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new WriteAuthorizationError(`${field} must be a non-empty string`)
  }

  return value
}

function base64UrlEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url')
}

function base64UrlDecode(value: string): Uint8Array {
  try {
    return new Uint8Array(Buffer.from(value, 'base64url'))
  } catch {
    throw new WriteAuthorizationError('Invalid base64url signature')
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
