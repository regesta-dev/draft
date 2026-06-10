import { Buffer } from 'node:buffer'
import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto'
import {
  assertArtifactDescriptorString,
  assertCanonicalTimestamp,
  assertObjectMediaType,
  assertPackageChannel,
  assertPackageVersion,
  assertSha256Digest,
  canonicalJson,
  defaultPackageChannel,
  isCanonicalOwnerDomain,
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
  timestamp: string
}

export interface ReleasePublishIntent extends WriteIntentBase {
  artifactDescriptorDigest: Sha256Digest
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
  artifactDescriptorDigest: Sha256Digest
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

export interface VerifyPublishAuthorizationInput {
  artifacts: Array<{
    bytes: Uint8Array
    compatibility?: unknown
    filename?: string
    format?: string
    mediaType: string
    role: string
  }>
  authorization: unknown
  configDigest: Sha256Digest
  fetchBinding: typeof fetch
  packageId: PackageId
  source: Uint8Array
  version: string
}

export interface VerifyChannelUpdateAuthorizationInput {
  authorization: unknown
  channel: string
  fetchBinding: typeof fetch
  packageId: PackageId
  previousVersion?: string
  version: string
}

export interface VerifyChannelDeleteAuthorizationInput {
  authorization: unknown
  channel: string
  fetchBinding: typeof fetch
  packageId: PackageId
  previousVersion?: string
}

export class WriteAuthorizationError extends Error {
  readonly issues: string[]

  constructor(message: string, issues: string[] = []) {
    super(message)
    this.name = 'WriteAuthorizationError'
    this.issues = issues
  }
}

export interface ReleasePublishArtifactDescriptorInput {
  compatibility?: unknown
  digest: Sha256Digest
  filename?: string
  format?: string
  mediaType: string
  role: string
}

const defaultTimestampToleranceMs = 10 * 60 * 1000
const defaultDomainBindingFetchTimeoutMs = 10 * 1000
const maxDomainBindingBytes = 64 * 1024

export function createReleasePublishIntent(
  input: CreateReleasePublishIntentInput,
): ReleasePublishIntent {
  const packageId = parsePackageId(input.packageId).id

  return {
    artifactDescriptorDigest: normalizeDigest(
      input.artifactDescriptorDigest,
      'artifactDescriptorDigest',
    ),
    artifactDigests: normalizeDigestArray(input.artifactDigests),
    channel: defaultPackageChannel,
    configDigest: normalizeDigest(input.configDigest, 'configDigest'),
    domain: ownerDomainFromPackageId(packageId),
    nonce: normalizeTokenString(input.nonce, 'nonce'),
    object: 'regesta.write-intent',
    operation: 'release.publish',
    package: packageId,
    sourceDigest: normalizeDigest(input.sourceDigest, 'sourceDigest'),
    timestamp: normalizeTimestamp(input.timestamp, 'timestamp'),
    version: normalizeVersion(input.version, 'version'),
  }
}

export function createChannelUpdateIntent(
  input: CreateChannelUpdateIntentInput,
): ChannelUpdateIntent {
  const packageId = parsePackageId(input.packageId).id

  return {
    channel: normalizeChannel(input.channel),
    domain: ownerDomainFromPackageId(packageId),
    nonce: normalizeTokenString(input.nonce, 'nonce'),
    object: 'regesta.write-intent',
    operation: 'channel.update',
    package: packageId,
    ...(input.previousVersion === undefined
      ? {}
      : {
          previousVersion: normalizeVersion(
            input.previousVersion,
            'previousVersion',
          ),
        }),
    timestamp: normalizeTimestamp(input.timestamp, 'timestamp'),
    version: normalizeVersion(input.version, 'version'),
  }
}

export function createChannelDeleteIntent(
  input: CreateChannelDeleteIntentInput,
): ChannelDeleteIntent {
  const packageId = parsePackageId(input.packageId).id

  return {
    channel: normalizeChannel(input.channel),
    domain: ownerDomainFromPackageId(packageId),
    nonce: normalizeTokenString(input.nonce, 'nonce'),
    object: 'regesta.write-intent',
    operation: 'channel.delete',
    package: packageId,
    ...(input.previousVersion === undefined
      ? {}
      : {
          previousVersion: normalizeVersion(
            input.previousVersion,
            'previousVersion',
          ),
        }),
    timestamp: normalizeTimestamp(input.timestamp, 'timestamp'),
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
    kid: normalizeTokenString(input.kid, 'kid'),
    payload,
    signature: base64UrlEncode(signature),
  }
}

export function readWriteAuthorization(value: unknown): WriteAuthorization {
  return normalizeWriteAuthorization(value)
}

export function verifyPublishAuthorization(
  input: VerifyPublishAuthorizationInput,
): Promise<WriteAuthorizationProof> {
  const authorization = readWriteAuthorization(input.authorization)

  return verifyWriteAuthorization({
    authorization,
    expectedIntent: createReleasePublishIntent({
      artifactDescriptorDigest: releasePublishArtifactDescriptorDigest(
        input.artifacts.map((artifact) => ({
          ...(artifact.compatibility === undefined
            ? {}
            : { compatibility: artifact.compatibility }),
          digest: sha256(artifact.bytes),
          ...(artifact.filename === undefined
            ? {}
            : { filename: artifact.filename }),
          ...(artifact.format === undefined ? {} : { format: artifact.format }),
          mediaType: artifact.mediaType,
          role: artifact.role,
        })),
      ),
      artifactDigests: input.artifacts.map((artifact) =>
        sha256(artifact.bytes),
      ),
      configDigest: input.configDigest,
      nonce: authorization.payload.nonce,
      packageId: input.packageId,
      sourceDigest: sha256(input.source),
      timestamp: authorization.payload.timestamp,
      version: input.version,
    }),
    fetchBinding: input.fetchBinding,
  })
}

export function releasePublishArtifactDescriptorDigest(
  artifacts: ReleasePublishArtifactDescriptorInput[],
): Sha256Digest {
  if (!Array.isArray(artifacts)) {
    throw new WriteAuthorizationError('artifactDescriptors must be an array')
  }

  if (artifacts.length === 0) {
    throw new WriteAuthorizationError('artifactDescriptors must not be empty')
  }

  return sha256(
    canonicalJson(
      artifacts.map((artifact) => {
        return releasePublishArtifactDescriptorJson(artifact)
      }),
    ),
  )
}

export function verifyChannelUpdateAuthorization(
  input: VerifyChannelUpdateAuthorizationInput,
): Promise<WriteAuthorizationProof> {
  const authorization = readWriteAuthorization(input.authorization)

  return verifyWriteAuthorization({
    authorization,
    expectedIntent: createChannelUpdateIntent({
      channel: input.channel,
      nonce: authorization.payload.nonce,
      packageId: input.packageId,
      ...(input.previousVersion
        ? { previousVersion: input.previousVersion }
        : {}),
      timestamp: authorization.payload.timestamp,
      version: input.version,
    }),
    fetchBinding: input.fetchBinding,
  })
}

export function verifyChannelDeleteAuthorization(
  input: VerifyChannelDeleteAuthorizationInput,
): Promise<WriteAuthorizationProof> {
  const authorization = readWriteAuthorization(input.authorization)

  return verifyWriteAuthorization({
    authorization,
    expectedIntent: createChannelDeleteIntent({
      channel: input.channel,
      nonce: authorization.payload.nonce,
      packageId: input.packageId,
      ...(input.previousVersion
        ? { previousVersion: input.previousVersion }
        : {}),
      timestamp: authorization.payload.timestamp,
    }),
    fetchBinding: input.fetchBinding,
  })
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
  const binding = normalizeDomainBindingText(
    bindingResponse.text,
    authorization.payload.domain,
  )
  const key = activeWriteKey(
    binding,
    authorization.kid,
    input.now ?? new Date(),
    authorization.payload.timestamp,
  )

  if (!key) {
    throw new WriteAuthorizationError(
      'Domain binding key not found or inactive',
    )
  }

  if (authorization.alg !== key.alg) {
    throw new WriteAuthorizationError('Write authorization algorithm mismatch')
  }

  let publicKey: ReturnType<typeof createPublicKey>

  try {
    publicKey = createPublicKey({
      format: 'jwk',
      key: key.publicKeyJwk,
    })
  } catch {
    throw new WriteAuthorizationError('Invalid domain binding public key')
  }

  const signature = ed25519SignatureBytes(authorization.signature)
  let ok: boolean

  try {
    ok = verify(null, payloadBytes(authorization.payload), publicKey, signature)
  } catch {
    throw new WriteAuthorizationError('Invalid write authorization signature')
  }

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
    wellKnownDigest: bindingResponse.digest,
  }
}

export function ownerDomainFromPackageId(packageId: PackageId): string {
  const parsed = parsePackageId(packageId)
  return parsed.ownerDomain
}

export function domainBindingUrl(domain: string): string {
  if (!isCanonicalOwnerDomain(domain)) {
    throw new TypeError('Domain must be a canonical DNS domain')
  }

  return `https://${domain}/.well-known/regesta.json`
}

async function fetchDomainBinding(
  domain: string,
  fetchBinding: typeof fetch,
): Promise<{ digest: Sha256Digest; text: string }> {
  const controller = new AbortController()
  const timeout = setTimeout(() => {
    controller.abort()
  }, defaultDomainBindingFetchTimeoutMs)
  let response: Response

  try {
    response = await fetchBinding(domainBindingUrl(domain), {
      cache: 'no-store',
      credentials: 'omit',
      headers: {
        accept: 'application/json',
      },
      method: 'GET',
      redirect: 'error',
      signal: controller.signal,
    })
  } catch (error) {
    throw new WriteAuthorizationError('Domain binding fetch failed', [
      error instanceof Error ? error.message : String(error),
    ])
  } finally {
    clearTimeout(timeout)
  }

  if (!response.ok) {
    throw new WriteAuthorizationError('Domain binding not found')
  }

  try {
    return await readDomainBinding(response)
  } catch (error) {
    if (error instanceof WriteAuthorizationError) {
      throw error
    }

    throw new WriteAuthorizationError('Domain binding read failed', [
      error instanceof Error ? error.message : String(error),
    ])
  }
}

async function readDomainBinding(
  response: Response,
): Promise<{ digest: Sha256Digest; text: string }> {
  assertDomainBindingContentType(response.headers.get('content-type'))
  const declaredLength = domainBindingContentLength(
    response.headers.get('content-length'),
  )
  const bytes = await readDomainBindingBytes(response)
  assertDomainBindingContentLengthMatches(declaredLength, bytes)

  return {
    digest: sha256(bytes),
    text: decodeDomainBindingText(bytes),
  }
}

async function readDomainBindingBytes(response: Response): Promise<Uint8Array> {
  if (!response.body) {
    const text = await response.text()
    const bytes = new TextEncoder().encode(text)

    if (bytes.byteLength > maxDomainBindingBytes) {
      throw new WriteAuthorizationError('Domain binding response is too large')
    }

    return bytes
  }

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let totalBytes = 0

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }

      if (!value) {
        continue
      }

      totalBytes += value.byteLength
      if (totalBytes > maxDomainBindingBytes) {
        throw new WriteAuthorizationError(
          'Domain binding response is too large',
        )
      }

      chunks.push(value)
    }
  } catch (error) {
    try {
      await reader.cancel()
    } catch {
      // Preserve the original stream read or validation error.
    }

    throw error
  } finally {
    reader.releaseLock()
  }

  const bytes = new Uint8Array(totalBytes)
  let offset = 0

  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }

  return bytes
}

function decodeDomainBindingText(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new WriteAuthorizationError('Domain binding response must be UTF-8')
  }
}

function assertDomainBindingContentType(value: string | null): void {
  if (value === null) {
    throw new WriteAuthorizationError('Domain binding response must be JSON')
  }

  const mediaType = value.split(';', 1)[0]?.trim().toLowerCase()

  if (mediaType !== 'application/json' && !mediaType?.endsWith('+json')) {
    throw new WriteAuthorizationError('Domain binding response must be JSON')
  }
}

function domainBindingContentLength(value: string | null): number | undefined {
  if (value === null) {
    return undefined
  }

  if (!/^(?:0|[1-9]\d*)$/u.test(value)) {
    throw new WriteAuthorizationError(
      'Domain binding Content-Length is invalid',
    )
  }

  const size = Number(value)

  if (!Number.isSafeInteger(size) || size > maxDomainBindingBytes) {
    throw new WriteAuthorizationError('Domain binding response is too large')
  }

  return size
}

function assertDomainBindingContentLengthMatches(
  declaredLength: number | undefined,
  bytes: Uint8Array,
): void {
  if (declaredLength === undefined) {
    return
  }

  if (declaredLength !== bytes.byteLength) {
    throw new WriteAuthorizationError(
      'Domain binding Content-Length does not match response body',
    )
  }
}

function normalizeWriteAuthorization(value: unknown): WriteAuthorization {
  if (!isRecord(value)) {
    throw new WriteAuthorizationError('Write authorization must be an object')
  }

  assertKnownFields(
    value,
    ['alg', 'kid', 'payload', 'signature'],
    'Write authorization',
  )

  if (value.alg !== 'EdDSA') {
    throw new WriteAuthorizationError('Write authorization alg must be EdDSA')
  }

  if (typeof value.signature !== 'string' || value.signature.length === 0) {
    throw new WriteAuthorizationError(
      'Write authorization must include signature',
    )
  }

  return {
    alg: value.alg,
    kid: normalizeTokenString(value.kid, 'kid'),
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
    assertKnownFields(
      value,
      [
        'artifactDescriptorDigest',
        'artifactDigests',
        'channel',
        'configDigest',
        'domain',
        'nonce',
        'object',
        'operation',
        'package',
        'sourceDigest',
        'timestamp',
        'version',
      ],
      'Write intent',
    )

    return {
      ...base,
      artifactDescriptorDigest: normalizeDigest(
        value.artifactDescriptorDigest,
        'artifactDescriptorDigest',
      ),
      artifactDigests: normalizeDigestArray(value.artifactDigests),
      channel:
        value.channel === undefined
          ? defaultPackageChannel
          : normalizeChannel(value.channel),
      configDigest: normalizeDigest(value.configDigest, 'configDigest'),
      operation: 'release.publish',
      sourceDigest: normalizeDigest(value.sourceDigest, 'sourceDigest'),
      version: normalizeVersion(value.version, 'version'),
    }
  }

  if (value.operation === 'channel.update') {
    assertKnownFields(
      value,
      [
        'channel',
        'domain',
        'nonce',
        'object',
        'operation',
        'package',
        'previousVersion',
        'timestamp',
        'version',
      ],
      'Write intent',
    )

    return {
      ...base,
      channel: normalizeChannel(value.channel),
      operation: 'channel.update',
      ...(value.previousVersion === undefined
        ? {}
        : {
            previousVersion: normalizeVersion(
              value.previousVersion,
              'previousVersion',
            ),
          }),
      version: normalizeVersion(value.version, 'version'),
    }
  }

  if (value.operation === 'channel.delete') {
    assertKnownFields(
      value,
      [
        'channel',
        'domain',
        'nonce',
        'object',
        'operation',
        'package',
        'previousVersion',
        'timestamp',
      ],
      'Write intent',
    )

    return {
      ...base,
      channel: normalizeChannel(value.channel),
      operation: 'channel.delete',
      ...(value.previousVersion === undefined
        ? {}
        : {
            previousVersion: normalizeVersion(
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

  return {
    domain: normalizeDomain(value.domain),
    nonce: normalizeTokenString(value.nonce, 'nonce'),
    object: 'regesta.write-intent',
    package: parsePackageId(normalizeString(value.package, 'package')).id,
    timestamp: normalizeTimestamp(value.timestamp, 'timestamp'),
  }
}

function normalizeDomainBinding(
  value: unknown,
  expectedDomain: string,
): DomainBinding {
  if (!isRecord(value)) {
    throw new WriteAuthorizationError('Domain binding must be an object')
  }

  assertKnownFields(value, ['domain', 'keys', 'object'], 'Domain binding')

  if (value.object !== 'regesta.domain-binding') {
    throw new WriteAuthorizationError(
      'Domain binding object must be regesta.domain-binding',
    )
  }

  const domain = normalizeDomain(value.domain)
  if (domain !== expectedDomain) {
    throw new WriteAuthorizationError('Domain binding domain mismatch')
  }

  if (!Array.isArray(value.keys)) {
    throw new WriteAuthorizationError('Domain binding keys must be an array')
  }

  if (value.keys.length === 0) {
    throw new WriteAuthorizationError('Domain binding keys must not be empty')
  }

  const keys = value.keys.map((key) => normalizeDomainBindingKey(key))
  assertUniqueDomainBindingKeyIds(keys)

  return {
    domain,
    keys,
    object: 'regesta.domain-binding',
  }
}

function assertUniqueDomainBindingKeyIds(keys: DomainBindingKey[]): void {
  const seen = new Set<string>()

  for (const key of keys) {
    if (seen.has(key.kid)) {
      throw new WriteAuthorizationError(
        `Domain binding key kid must be unique: ${key.kid}`,
      )
    }

    seen.add(key.kid)
  }
}

function normalizeDomainBindingText(
  text: string,
  expectedDomain: string,
): DomainBinding {
  let value: unknown

  try {
    value = JSON.parse(text)
  } catch {
    throw new WriteAuthorizationError('Domain binding JSON is invalid')
  }

  return normalizeDomainBinding(value, expectedDomain)
}

function normalizeDomainBindingKey(value: unknown): DomainBindingKey {
  if (!isRecord(value)) {
    throw new WriteAuthorizationError('Domain binding key must be an object')
  }

  assertKnownFields(
    value,
    ['alg', 'createdAt', 'expiresAt', 'kid', 'publicKeyJwk', 'use'],
    'Domain binding key',
  )

  if (value.alg !== 'EdDSA') {
    throw new WriteAuthorizationError('Domain binding key alg must be EdDSA')
  }

  if (value.use !== 'regesta-write') {
    throw new WriteAuthorizationError(
      'Domain binding key use must be regesta-write',
    )
  }

  const createdAt =
    value.createdAt === undefined
      ? undefined
      : normalizeTimestamp(value.createdAt, 'createdAt')
  const expiresAt =
    value.expiresAt === undefined
      ? undefined
      : normalizeTimestamp(value.expiresAt, 'expiresAt')

  if (
    createdAt !== undefined &&
    expiresAt !== undefined &&
    Date.parse(expiresAt) <= Date.parse(createdAt)
  ) {
    throw new WriteAuthorizationError(
      'Domain binding key expiresAt must be after createdAt',
    )
  }

  return {
    alg: value.alg,
    ...(createdAt === undefined ? {} : { createdAt }),
    ...(expiresAt === undefined ? {} : { expiresAt }),
    kid: normalizeTokenString(value.kid, 'kid'),
    publicKeyJwk: normalizePublicKeyJwk(value.publicKeyJwk),
    use: value.use,
  }
}

function normalizePublicKeyJwk(value: unknown): Ed25519PublicKeyJwk {
  if (!isRecord(value)) {
    throw new WriteAuthorizationError('publicKeyJwk must be an object')
  }

  assertKnownFields(value, ['crv', 'kty', 'x'], 'publicKeyJwk')

  if (value.kty !== 'OKP') {
    throw new WriteAuthorizationError('publicKeyJwk kty must be OKP')
  }

  if (value.crv !== 'Ed25519') {
    throw new WriteAuthorizationError('publicKeyJwk crv must be Ed25519')
  }

  return {
    crv: value.crv,
    kty: value.kty,
    x: ed25519PublicKey(value.x),
  }
}

function activeWriteKey(
  binding: DomainBinding,
  kid: string,
  now: Date,
  signedAt: string,
): DomainBindingKey | undefined {
  const signedAtTime = Date.parse(signedAt)

  return binding.keys.find((key) => {
    if (key.kid !== kid) {
      return false
    }

    if (!keyIsActiveAt(key, now.getTime())) {
      return false
    }

    if (!keyIsActiveAt(key, signedAtTime)) {
      return false
    }

    return true
  })
}

function keyIsActiveAt(key: DomainBindingKey, timestamp: number): boolean {
  if (key.createdAt && Date.parse(key.createdAt) > timestamp) {
    return false
  }

  if (key.expiresAt && Date.parse(key.expiresAt) <= timestamp) {
    return false
  }

  return true
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
    timestamp: intent.timestamp,
  }

  if (intent.operation === 'release.publish') {
    return {
      ...base,
      artifactDescriptorDigest: intent.artifactDescriptorDigest,
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

function releasePublishArtifactDescriptorJson(
  artifact: ReleasePublishArtifactDescriptorInput,
): CanonicalJsonValue {
  return {
    ...(artifact.compatibility === undefined
      ? {}
      : {
          compatibility: normalizeCanonicalJsonValue(
            artifact.compatibility,
            'artifact compatibility',
          ),
        }),
    digest: normalizeDigest(artifact.digest, 'artifact descriptor digest'),
    ...(artifact.filename === undefined
      ? {}
      : {
          filename: normalizeArtifactDescriptorString(
            artifact.filename,
            'artifact filename',
          ),
        }),
    ...(artifact.format === undefined
      ? {}
      : {
          format: normalizeArtifactDescriptorString(
            artifact.format,
            'artifact format',
          ),
        }),
    mediaType: normalizeObjectMediaType(artifact.mediaType),
    role: normalizeArtifactDescriptorString(artifact.role, 'artifact role'),
  }
}

function normalizeCanonicalJsonValue(
  value: unknown,
  field: string,
): CanonicalJsonValue {
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'string'
  ) {
    return value
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new WriteAuthorizationError(`${field} must be JSON-compatible`)
    }

    return value
  }

  if (Array.isArray(value)) {
    return value.map((item, index) => {
      return normalizeCanonicalJsonValue(item, `${field}[${index}]`)
    })
  }

  if (isRecord(value)) {
    const output: Record<string, CanonicalJsonValue> = {}

    for (const [key, item] of Object.entries(value)) {
      if (item !== undefined) {
        output[key] = normalizeCanonicalJsonValue(item, `${field}.${key}`)
      }
    }

    return output
  }

  throw new WriteAuthorizationError(`${field} must be JSON-compatible`)
}

function normalizeDigestArray(value: unknown): Sha256Digest[] {
  if (!Array.isArray(value)) {
    throw new WriteAuthorizationError('artifactDigests must be an array')
  }

  if (value.length === 0) {
    throw new WriteAuthorizationError('artifactDigests must not be empty')
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
  const domain = normalizeString(value, 'domain')

  if (!isCanonicalOwnerDomain(domain)) {
    throw new WriteAuthorizationError('Domain must be a canonical DNS domain')
  }

  return domain
}

function normalizeString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new WriteAuthorizationError(`${field} must be a non-empty string`)
  }

  return value
}

function normalizeTokenString(value: unknown, field: string): string {
  const text = normalizeString(value, field)

  if (hasControlCharacter(text)) {
    throw new WriteAuthorizationError(
      `${field} must not include control characters`,
    )
  }

  return text
}

function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0)
    return codePoint !== undefined && (codePoint < 0x20 || codePoint === 0x7f)
  })
}

function normalizeChannel(value: unknown): string {
  try {
    return assertPackageChannel(normalizeString(value, 'channel'), 'channel')
  } catch (error) {
    throw new WriteAuthorizationError(
      error instanceof Error ? error.message : String(error),
    )
  }
}

function normalizeVersion(value: unknown, field: string): string {
  try {
    return assertPackageVersion(normalizeString(value, field), field)
  } catch (error) {
    throw new WriteAuthorizationError(
      error instanceof Error ? error.message : String(error),
    )
  }
}

function normalizeArtifactDescriptorString(
  value: unknown,
  field: string,
): string {
  try {
    return assertArtifactDescriptorString(normalizeString(value, field), field)
  } catch (error) {
    throw new WriteAuthorizationError(
      error instanceof Error ? error.message : String(error),
    )
  }
}

function normalizeObjectMediaType(value: unknown): string {
  try {
    return assertObjectMediaType(
      normalizeString(value, 'artifact mediaType'),
      'artifact mediaType',
    )
  } catch (error) {
    throw new WriteAuthorizationError(
      error instanceof Error ? error.message : String(error),
    )
  }
}

function normalizeTimestamp(value: unknown, field: string): string {
  const timestamp = normalizeString(value, field)

  if (!Number.isFinite(Date.parse(timestamp))) {
    throw new WriteAuthorizationError(`${field} timestamp is invalid`)
  }

  try {
    return assertCanonicalTimestamp(timestamp, field)
  } catch {
    throw new WriteAuthorizationError(`${field} must be canonical ISO 8601`)
  }
}

function assertKnownFields(
  value: Record<string, unknown>,
  knownFields: string[],
  label: string,
): void {
  const known = new Set(knownFields)
  const unknown = Object.keys(value).find((key) => !known.has(key))

  if (unknown) {
    throw new WriteAuthorizationError(
      `${label} must not include unknown field: ${unknown}`,
    )
  }
}

function base64UrlEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url')
}

function ed25519SignatureBytes(value: string): Uint8Array {
  const bytes = base64UrlBytes(value, 'Write authorization signature')

  if (bytes.byteLength !== 64) {
    throw new WriteAuthorizationError(
      'Write authorization signature must be an Ed25519 signature',
    )
  }

  return bytes
}

function ed25519PublicKey(value: unknown): string {
  const key = normalizeString(value, 'publicKeyJwk.x')
  const bytes = base64UrlBytes(key, 'publicKeyJwk.x')

  if (bytes.byteLength !== 32) {
    throw new WriteAuthorizationError(
      'publicKeyJwk.x must be an Ed25519 public key',
    )
  }

  return key
}

function base64UrlBytes(value: string, field: string): Uint8Array {
  if (!/^[\w-]+$/u.test(value)) {
    throw new WriteAuthorizationError(`${field} must be base64url`)
  }

  return new Uint8Array(Buffer.from(value, 'base64url'))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
