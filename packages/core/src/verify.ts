import {
  assertArtifactDescriptorString,
  assertCanonicalTimestamp,
  assertCompatibilityString,
  assertObjectMediaType,
  assertPackageVersion,
  assertSha256Digest,
  canonicalJson,
  defaultPackageChannel,
  parsePackageId,
  registryEventDigest,
  sha256,
  type ObjectDescriptor,
  type PackageId,
  type PublishReleaseEvent,
  type RegistryEvent,
  type ReleaseArtifact,
  type ReleaseManifest,
  type WriteAuthorizationProof,
} from '@regesta/protocol'
import { base64UrlToBytes, isBase64Url } from './base64.ts'
import type { RegistryAdapters } from './storage.ts'

export interface ReleaseVerifier {
  verify: (
    adapters: RegistryAdapters,
    packageId: PackageId,
    version: string,
  ) => Promise<VerificationResult>
}

export interface VerificationResult {
  manifest?: ReleaseManifest
  ok: boolean
  problems: string[]
}

export const defaultReleaseVerifier: ReleaseVerifier = {
  verify: verifyRelease,
}

export async function verifyRelease(
  adapters: RegistryAdapters,
  packageId: PackageId,
  version: string,
): Promise<VerificationResult> {
  const problems: string[] = []
  const release = await adapters.database.getRelease(packageId, version)

  if (!release) {
    return {
      ok: false,
      problems: [`Release not found: ${packageId}@${version}`],
    }
  }

  const manifestProtocolProblems = verifyManifestProtocol(
    release.manifest,
    release.manifestDescriptor,
  )
  problems.push(
    ...manifestProtocolProblems,
    ...verifyManifestIdentity(release.manifest, packageId, version),
    ...verifyProvenance(release.manifest),
  )

  if (isReferenceableObjectDescriptor(release.manifestDescriptor)) {
    const manifestBytes = canonicalJsonBytes(
      release.manifest,
      'Release manifest',
      problems,
    )

    if (
      manifestBytes &&
      sha256(manifestBytes) !== release.manifestDescriptor.digest
    ) {
      problems.push('Release manifest digest does not match stored descriptor')
    }
  }

  problems.push(
    ...verifyPublishEvent(
      release.event,
      release.manifest,
      release.manifestDescriptor,
    ),
  )

  const loggedEvent = await adapters.database.getEvent(release.event.id)
  if (!loggedEvent) {
    problems.push('Publish event is missing from the append-only event log')
  } else if (!sameCanonicalJson(loggedEvent, release.event)) {
    problems.push('Publish event log entry does not match stored release event')
  }

  problems.push(
    ...(isReferenceableObjectDescriptor(release.manifestDescriptor)
      ? await verifyObjectReference(
          adapters,
          'Release manifest',
          release.manifestDescriptor,
        )
      : []),
    ...(isReferenceableObjectDescriptor(release.manifest.source)
      ? await verifyObjectReference(adapters, 'Source', release.manifest.source)
      : []),
  )

  if (Array.isArray(release.manifest.artifacts)) {
    for (const artifact of release.manifest.artifacts) {
      if (isReferenceableObjectDescriptor(artifact)) {
        const role =
          typeof artifact.role === 'string' ? artifact.role : 'unknown'
        problems.push(
          ...(await verifyObjectReference(
            adapters,
            `Artifact ${role}`,
            artifact,
          )),
        )
      }
    }
  }

  return {
    manifest: release.manifest,
    ok: problems.length === 0,
    problems,
  }
}

function verifyManifestProtocol(
  manifest: ReleaseManifest,
  manifestDescriptor: ObjectDescriptor,
): string[] {
  const problems: string[] = []

  collectKnownFields(
    manifest,
    [
      'artifacts',
      'configDigest',
      'createdAt',
      'ecosystem',
      'family',
      'id',
      'languages',
      'metadata',
      'name',
      'object',
      'provenance',
      'source',
      'version',
    ],
    'Release manifest',
    problems,
  )
  collectSha256Digest(
    manifest.configDigest,
    'Release manifest configDigest',
    problems,
  )
  collectCanonicalTimestamp(
    manifest.createdAt,
    'Release manifest createdAt',
    problems,
  )
  collectOptionalString(manifest.family, 'Release manifest family', problems)
  collectOptionalStringArray(
    manifest.languages,
    'Release manifest languages',
    problems,
  )
  collectObjectDescriptor(
    manifestDescriptor,
    'Release manifest descriptor',
    problems,
  )
  collectObjectDescriptor(
    manifest.source,
    'Release source descriptor',
    problems,
  )

  if (manifest.metadata !== undefined) {
    collectReleaseMetadata(manifest.metadata, problems)
  }

  if (manifest.provenance) {
    collectReleaseProvenance(manifest.provenance, problems)
  }

  if (Array.isArray(manifest.artifacts)) {
    for (const artifact of manifest.artifacts) {
      collectReleaseArtifact(artifact, problems)
    }
  } else {
    problems.push('Release manifest artifacts must be an array')
  }

  return problems
}

function collectReleaseMetadata(metadata: unknown, problems: string[]): void {
  if (
    collectKnownFields(
      metadata,
      ['description', 'exports', 'repository'],
      'Release metadata',
      problems,
    )
  ) {
    collectOptionalString(
      metadata.description,
      'Release metadata description',
      problems,
    )
    collectOptionalString(
      metadata.repository,
      'Release metadata repository',
      problems,
    )
    if (metadata.exports !== undefined) {
      collectPackageExport(
        metadata.exports,
        'Release metadata exports',
        problems,
      )
    }
  }
}

function collectReleaseProvenance(
  provenance: unknown,
  problems: string[],
): void {
  collectKnownFields(
    provenance,
    ['level', 'verified'],
    'Release provenance',
    problems,
  )
}

function collectReleaseArtifact(
  artifact: ReleaseArtifact,
  problems: string[],
): void {
  if (
    !collectObjectDescriptor(
      artifact,
      'Release artifact descriptor',
      problems,
      ['compatibility', 'ecosystemMetadata', 'filename', 'format', 'role'],
    )
  ) {
    return
  }

  collectArtifactDescriptorString(
    artifact.role,
    'Release artifact role',
    problems,
  )
  collectOptionalArtifactDescriptorString(
    artifact.filename,
    'Release artifact filename',
    problems,
  )
  collectOptionalArtifactDescriptorString(
    artifact.format,
    'Release artifact format',
    problems,
  )

  const compatibility: unknown = artifact.compatibility
  if (compatibility !== undefined) {
    collectReleaseCompatibility(compatibility, problems)
  }

  if (
    artifact.ecosystemMetadata !== undefined &&
    !isRecord(artifact.ecosystemMetadata)
  ) {
    problems.push('Release artifact ecosystemMetadata must be an object')
  }
}

function collectReleaseCompatibility(
  compatibility: unknown,
  problems: string[],
): void {
  if (
    !collectKnownFields(
      compatibility,
      ['abi', 'modules', 'platforms', 'runtimes'],
      'Release artifact compatibility',
      problems,
    )
  ) {
    return
  }

  for (const abi of optionalArray(
    compatibility.abi,
    'Release artifact compatibility abi',
    problems,
  )) {
    if (
      collectKnownFields(
        abi,
        ['name', 'versions'],
        'Release artifact ABI compatibility',
        problems,
      )
    ) {
      collectCompatibilityString(
        abi.name,
        'Release artifact ABI compatibility name',
        problems,
      )
      collectOptionalStringArray(
        abi.versions,
        'Release artifact ABI compatibility versions',
        problems,
      )
    }
  }

  collectOptionalStringArray(
    compatibility.modules,
    'Release artifact compatibility modules',
    problems,
  )

  for (const platform of optionalArray(
    compatibility.platforms,
    'Release artifact compatibility platforms',
    problems,
  )) {
    if (
      collectKnownFields(
        platform,
        ['arch', 'libc', 'os'],
        'Release artifact platform compatibility',
        problems,
      )
    ) {
      collectOptionalStringArray(
        platform.arch,
        'Release artifact platform compatibility arch',
        problems,
      )
      collectOptionalStringArray(
        platform.libc,
        'Release artifact platform compatibility libc',
        problems,
      )
      collectOptionalStringArray(
        platform.os,
        'Release artifact platform compatibility os',
        problems,
      )
    }
  }

  for (const runtime of optionalArray(
    compatibility.runtimes,
    'Release artifact compatibility runtimes',
    problems,
  )) {
    if (typeof runtime === 'string') {
      collectCompatibilityString(
        runtime,
        'Release artifact runtime compatibility',
        problems,
      )
      continue
    }

    if (
      collectKnownFields(
        runtime,
        ['conditions', 'name', 'versions'],
        'Release artifact runtime compatibility',
        problems,
      )
    ) {
      collectOptionalStringArray(
        runtime.conditions,
        'Release artifact runtime compatibility conditions',
        problems,
      )
      collectCompatibilityString(
        runtime.name,
        'Release artifact runtime compatibility name',
        problems,
      )
      if (runtime.versions !== undefined) {
        collectCompatibilityString(
          runtime.versions,
          'Release artifact runtime compatibility versions',
          problems,
        )
      }
    }
  }
}

function optionalArray(
  value: unknown,
  label: string,
  problems: string[],
): unknown[] {
  if (value === undefined) {
    return []
  }

  if (!Array.isArray(value)) {
    problems.push(`${label} must be an array`)
    return []
  }

  return value
}

function collectOptionalStringArray(
  value: unknown,
  label: string,
  problems: string[],
): void {
  if (value === undefined) {
    return
  }

  if (!Array.isArray(value)) {
    problems.push(`${label} must be an array`)
    return
  }

  value.forEach((item, index) => {
    collectCompatibilityString(item, `${label}[${index}]`, problems)
  })
}

function collectCompatibilityString(
  value: unknown,
  label: string,
  problems: string[],
): void {
  try {
    assertCompatibilityString(value, label)
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error))
  }
}

function collectOptionalString(
  value: unknown,
  label: string,
  problems: string[],
): void {
  if (value !== undefined && typeof value !== 'string') {
    problems.push(`${label} must be a string`)
  }
}

function collectArtifactDescriptorString(
  value: unknown,
  label: string,
  problems: string[],
): void {
  try {
    assertArtifactDescriptorString(value, label)
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error))
  }
}

function collectOptionalArtifactDescriptorString(
  value: unknown,
  label: string,
  problems: string[],
): void {
  if (value !== undefined) {
    collectArtifactDescriptorString(value, label, problems)
  }
}

function collectPackageExport(
  value: unknown,
  label: string,
  problems: string[],
): void {
  if (isPackageExport(value)) {
    return
  }

  problems.push(`${label} must be JSON string, null, array, or object values`)
}

function isPackageExport(value: unknown): boolean {
  if (value === null || typeof value === 'string') {
    return true
  }

  if (Array.isArray(value)) {
    return value.every((item) => isPackageExport(item))
  }

  if (isRecord(value)) {
    return Object.values(value).every((item) => isPackageExport(item))
  }

  return false
}

function verifyManifestIdentity(
  manifest: ReleaseManifest,
  expectedPackageId: PackageId,
  expectedVersion: string,
): string[] {
  const problems: string[] = []
  const parsed = parseManifestPackageId(manifest.id, problems)
  const installArtifacts = Array.isArray(manifest.artifacts)
    ? manifest.artifacts.filter((artifact) => {
        return artifact.role === 'install'
      })
    : []

  if (manifest.object !== 'regesta.release-manifest') {
    problems.push('Release manifest object must be regesta.release-manifest')
  }

  collectPackageVersion(manifest.version, 'Release manifest version', problems)

  if (manifest.id !== expectedPackageId) {
    problems.push(
      'Release manifest package id does not match requested package id',
    )
  }

  if (manifest.version !== expectedVersion) {
    problems.push('Release manifest version does not match requested version')
  }

  if (parsed && manifest.ecosystem !== parsed.ecosystem) {
    problems.push('Release manifest ecosystem does not match package id')
  }

  if (parsed && manifest.name !== parsed.name) {
    problems.push('Release manifest name does not match package id')
  }

  if (installArtifacts.length !== 1) {
    problems.push('Release manifest must include exactly one install artifact')
  }

  return problems
}

function parseManifestPackageId(
  packageId: PackageId,
  problems: string[],
): ReturnType<typeof parsePackageId> | undefined {
  try {
    return parsePackageId(packageId)
  } catch (error) {
    problems.push(
      error instanceof Error
        ? error.message
        : 'Release manifest package id is invalid',
    )
    return undefined
  }
}

function verifyProvenance(manifest: ReleaseManifest): string[] {
  const provenance: unknown = manifest.provenance
  const problems: string[] = []

  if (!isRecord(provenance)) {
    problems.push('Release provenance must be an object')
    return problems
  }

  if (provenance.level !== 'source-attached') {
    problems.push('Release provenance must be source-attached')
  }

  if (provenance.verified !== false) {
    problems.push('V0 release provenance must not claim verified build status')
  }

  return problems
}

function collectObjectDescriptor(
  descriptor: ObjectDescriptor,
  label: string,
  problems: string[],
  additionalFields: readonly string[] = [],
): descriptor is ObjectDescriptor {
  if (
    !collectKnownFields(
      descriptor,
      ['digest', 'mediaType', 'size', ...additionalFields],
      label,
      problems,
    )
  ) {
    return false
  }

  collectSha256Digest(descriptor.digest, `${label} digest`, problems)

  if (!Number.isSafeInteger(descriptor.size) || descriptor.size < 0) {
    problems.push(`${label} size must be non-negative`)
  }

  if (typeof descriptor.mediaType !== 'string' || descriptor.mediaType === '') {
    problems.push(`${label} mediaType must not be empty`)
  } else {
    try {
      assertObjectMediaType(descriptor.mediaType, `${label} mediaType`)
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error))
    }
  }

  return true
}

function isReferenceableObjectDescriptor(
  descriptor: unknown,
): descriptor is ObjectDescriptor {
  if (!isRecord(descriptor) || typeof descriptor.digest !== 'string') {
    return false
  }

  try {
    assertSha256Digest(descriptor.digest)
    return true
  } catch {
    return false
  }
}

function collectSha256Digest(
  digest: string,
  label: string,
  problems: string[],
): void {
  try {
    assertSha256Digest(digest)
  } catch (error) {
    problems.push(
      `${label} is invalid: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }
}

function collectCanonicalTimestamp(
  timestamp: string,
  label: string,
  problems: string[],
): void {
  try {
    assertCanonicalTimestamp(timestamp, label)
  } catch (error) {
    problems.push(
      `${label} is invalid: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }
}

function collectNonEmptyString(
  value: unknown,
  label: string,
  problems: string[],
): void {
  if (typeof value !== 'string' || value.length === 0) {
    problems.push(`${label} must not be empty`)
  }
}

function collectPackageVersion(
  value: unknown,
  label: string,
  problems: string[],
): void {
  try {
    assertPackageVersion(value, label)
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error))
  }
}

function collectEd25519Signature(
  value: unknown,
  label: string,
  problems: string[],
): void {
  const bytes = collectBase64UrlBytes(value, label, problems)

  if (bytes && bytes.byteLength !== 64) {
    problems.push(`${label} must be an Ed25519 signature`)
  }
}

function collectEd25519PublicKey(
  value: unknown,
  label: string,
  problems: string[],
): void {
  const bytes = collectBase64UrlBytes(value, label, problems)

  if (bytes && bytes.byteLength !== 32) {
    problems.push(`${label} must be an Ed25519 public key`)
  }
}

function collectBase64UrlBytes(
  value: unknown,
  label: string,
  problems: string[],
): Uint8Array | undefined {
  if (typeof value !== 'string' || !isBase64Url(value)) {
    problems.push(`${label} must be base64url`)
    return undefined
  }

  return base64UrlToBytes(value)
}

function collectKnownFields(
  value: unknown,
  knownFields: readonly string[],
  label: string,
  problems: string[],
): value is Record<string, unknown> {
  if (!isRecord(value)) {
    problems.push(`${label} must be an object`)
    return false
  }

  const known = new Set(knownFields)
  const unknown = Object.keys(value).find((key) => {
    return !known.has(key)
  })

  if (unknown) {
    problems.push(`${label} must not include unknown field: ${unknown}`)
  }

  return true
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function canonicalJsonBytes(
  value: unknown,
  label: string,
  problems: string[],
): Uint8Array | undefined {
  try {
    return new TextEncoder().encode(`${canonicalJson(value)}\n`)
  } catch (error) {
    problems.push(
      `${label} canonicalization failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
    return undefined
  }
}

function sameCanonicalJson(left: unknown, right: unknown): boolean {
  try {
    return canonicalJson(left) === canonicalJson(right)
  } catch {
    return false
  }
}

function verifyPublishEvent(
  event: RegistryEvent,
  manifest: ReleaseManifest,
  manifestDescriptor: ObjectDescriptor,
): string[] {
  const problems: string[] = []
  const expectedEvent = expectedPublishEventPayload(
    event,
    manifest,
    manifestDescriptor,
  )
  const expectedEventDigest = expectedEvent
    ? registryEventPayloadDigest(expectedEvent, problems)
    : undefined

  if (expectedEventDigest && event.id !== expectedEventDigest) {
    problems.push('Publish event id does not match canonical event payload')
  }

  if (event.eventType !== 'release.published') {
    problems.push('Publish event must have eventType release.published')
    return problems
  }

  collectPublishEventProtocol(event, manifest.id, problems)

  if (event.channel !== defaultPackageChannel) {
    problems.push(`Publish event channel must be ${defaultPackageChannel}`)
  }

  const eventRelease = isRecord(event.release) ? event.release : undefined
  if (!eventRelease) {
    return problems
  }

  const manifestDescriptorDigest = isRecord(manifestDescriptor)
    ? manifestDescriptor.digest
    : undefined
  const sourceDigest = isRecord(manifest.source)
    ? manifest.source.digest
    : undefined

  if (eventRelease.manifestDigest !== manifestDescriptorDigest) {
    problems.push(
      'Publish event manifest digest does not match stored descriptor',
    )
  }

  if (eventRelease.id !== manifest.id) {
    problems.push('Publish event package id does not match release manifest')
  }

  if (eventRelease.version !== manifest.version) {
    problems.push('Publish event version does not match release manifest')
  }

  if (event.sourceDigest !== sourceDigest) {
    problems.push('Publish event source digest does not match release manifest')
  }

  if (
    expectedEvent &&
    !sameCanonicalJson(event.artifactDigests, expectedEvent.artifactDigests)
  ) {
    problems.push(
      'Publish event artifact digests do not match release manifest',
    )
  }

  if (event.timestamp !== manifest.createdAt) {
    problems.push('Publish event timestamp does not match release manifest')
  }

  return problems
}

function registryEventPayloadDigest(
  event: Omit<PublishReleaseEvent, 'id'>,
  problems: string[],
): string | undefined {
  try {
    return registryEventDigest(event)
  } catch (error) {
    problems.push(
      `Publish event canonicalization failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
    return undefined
  }
}

function expectedPublishEventPayload(
  event: RegistryEvent,
  manifest: ReleaseManifest,
  manifestDescriptor: ObjectDescriptor,
): Omit<PublishReleaseEvent, 'id'> | undefined {
  if (
    !Array.isArray(manifest.artifacts) ||
    !isRecord(manifest.source) ||
    !isRecord(manifestDescriptor)
  ) {
    return undefined
  }

  const artifactDigests: PublishReleaseEvent['artifactDigests'] = []
  for (const artifact of manifest.artifacts) {
    if (!isRecord(artifact) || typeof artifact.digest !== 'string') {
      return undefined
    }

    try {
      artifactDigests.push(assertSha256Digest(artifact.digest))
    } catch {
      return undefined
    }
  }

  if (
    typeof manifest.id !== 'string' ||
    typeof manifest.version !== 'string' ||
    typeof manifest.createdAt !== 'string'
  ) {
    return undefined
  }

  if (
    typeof manifest.source.digest !== 'string' ||
    typeof manifestDescriptor.digest !== 'string'
  ) {
    return undefined
  }

  let sourceDigest: PublishReleaseEvent['sourceDigest']
  let manifestDigest: PublishReleaseEvent['release']['manifestDigest']

  try {
    sourceDigest = assertSha256Digest(manifest.source.digest)
    manifestDigest = assertSha256Digest(manifestDescriptor.digest)
  } catch {
    return undefined
  }

  return {
    ...(event.authorization ? { authorization: event.authorization } : {}),
    artifactDigests,
    channel: defaultPackageChannel,
    eventType: 'release.published',
    object: 'regesta.event',
    release: {
      id: manifest.id,
      manifestDigest,
      version: manifest.version,
    },
    sourceDigest,
    timestamp: manifest.createdAt,
  }
}

function collectPublishEventProtocol(
  event: PublishReleaseEvent,
  expectedPackageId: PackageId,
  problems: string[],
): void {
  collectKnownFields(
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
      'timestamp',
    ],
    'Publish event',
    problems,
  )

  if (event.object !== 'regesta.event') {
    problems.push('Publish event object must be regesta.event')
  }

  collectSha256Digest(event.id, 'Publish event id', problems)
  collectCanonicalTimestamp(
    event.timestamp,
    'Publish event timestamp',
    problems,
  )

  if (isRecord(event.release)) {
    collectKnownFields(
      event.release,
      ['id', 'manifestDigest', 'version'],
      'Publish event release',
      problems,
    )
    collectSha256Digest(
      event.release.manifestDigest,
      'Publish event release manifestDigest',
      problems,
    )
    collectPackageVersion(
      event.release.version,
      'Publish event release version',
      problems,
    )
  } else {
    problems.push('Publish event release must be an object')
  }

  collectSha256Digest(
    event.sourceDigest,
    'Publish event sourceDigest',
    problems,
  )

  if (Array.isArray(event.artifactDigests)) {
    if (event.artifactDigests.length === 0) {
      problems.push('Publish event artifactDigests must not be empty')
    }

    event.artifactDigests.forEach((digest, index) => {
      collectSha256Digest(
        digest,
        `Publish event artifactDigests[${index}]`,
        problems,
      )
    })
  } else {
    problems.push('Publish event artifactDigests must be an array')
  }

  if (event.authorization) {
    collectAuthorizationProof(
      event.authorization,
      expectedPackageId,
      event.timestamp,
      problems,
    )
  }
}

function collectAuthorizationProof(
  authorization: WriteAuthorizationProof,
  expectedPackageId: PackageId,
  eventTimestamp: string,
  problems: string[],
): void {
  if (
    !collectKnownFields(
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
        'wellKnownDigest',
      ],
      'Publish event authorization',
      problems,
    )
  ) {
    return
  }

  if (authorization.object !== 'regesta.authorization-proof') {
    problems.push(
      'Publish event authorization object must be regesta.authorization-proof',
    )
  }

  if (authorization.alg !== 'EdDSA') {
    problems.push('Publish event authorization alg must be EdDSA')
  }

  const parsedPackageId = parseManifestPackageId(expectedPackageId, problems)
  if (parsedPackageId && authorization.domain !== parsedPackageId.ownerDomain) {
    problems.push(
      'Publish event authorization domain does not match package owner',
    )
  }

  collectNonEmptyString(
    authorization.kid,
    'Publish event authorization kid',
    problems,
  )
  collectEd25519Signature(
    authorization.signature,
    'Publish event authorization signature',
    problems,
  )
  collectSha256Digest(
    authorization.payloadDigest,
    'Publish event authorization payloadDigest',
    problems,
  )
  collectSha256Digest(
    authorization.wellKnownDigest,
    'Publish event authorization wellKnownDigest',
    problems,
  )
  collectCanonicalTimestamp(
    authorization.signedAt,
    'Publish event authorization signedAt',
    problems,
  )

  if (authorization.signedAt !== eventTimestamp) {
    problems.push(
      'Publish event authorization signedAt must match event timestamp',
    )
  }

  collectPublicKeyJwk(authorization.publicKeyJwk, problems)
}

function collectPublicKeyJwk(
  publicKeyJwk: WriteAuthorizationProof['publicKeyJwk'],
  problems: string[],
): void {
  if (
    !collectKnownFields(
      publicKeyJwk,
      ['crv', 'kty', 'x'],
      'Publish event authorization publicKeyJwk',
      problems,
    )
  ) {
    return
  }

  if (publicKeyJwk.kty !== 'OKP') {
    problems.push('Publish event authorization publicKeyJwk kty must be OKP')
  }

  if (publicKeyJwk.crv !== 'Ed25519') {
    problems.push(
      'Publish event authorization publicKeyJwk crv must be Ed25519',
    )
  }

  collectNonEmptyString(
    publicKeyJwk.x,
    'Publish event authorization publicKeyJwk.x',
    problems,
  )
  collectEd25519PublicKey(
    publicKeyJwk.x,
    'Publish event authorization publicKeyJwk.x',
    problems,
  )
}

function verifyStoredObject(
  label: string,
  expected: ObjectDescriptor,
  actual: { bytes: Uint8Array; descriptor: ObjectDescriptor },
): string[] {
  const problems = verifyStoredObjectDescriptor(
    label,
    expected,
    actual.descriptor,
  )

  if (problems.length > 0) {
    return problems
  }

  if (actual.bytes.byteLength !== actual.descriptor.size) {
    problems.push(
      `${label} object byte length does not match descriptor: ${expected.digest}`,
    )
  }

  if (sha256(actual.bytes) !== expected.digest) {
    problems.push(`${label} object bytes digest mismatch: ${expected.digest}`)
  }

  return problems
}

function verifyStoredObjectDescriptor(
  label: string,
  expected: ObjectDescriptor,
  actual: ObjectDescriptor,
): string[] {
  const problems: string[] = []

  if (actual.digest !== expected.digest) {
    problems.push(
      `${label} object descriptor digest mismatch: ${expected.digest}`,
    )
  }

  if (actual.size !== expected.size) {
    problems.push(`${label} object size mismatch: ${expected.digest}`)
  }

  if (actual.mediaType !== expected.mediaType) {
    problems.push(`${label} object media type mismatch: ${expected.digest}`)
  }

  return problems
}

async function verifyObjectReference(
  adapters: RegistryAdapters,
  label: string,
  expected: ObjectDescriptor,
): Promise<string[]> {
  let descriptor: ObjectDescriptor | undefined
  let object: { bytes: Uint8Array; descriptor: ObjectDescriptor } | undefined

  try {
    descriptor = await adapters.objects.getDescriptor(expected.digest)
  } catch (error) {
    return [
      `${label} object descriptor read failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    ]
  }

  if (!descriptor) {
    return [`${label} object missing: ${expected.digest}`]
  }

  const descriptorProblems = verifyStoredObjectDescriptor(
    label,
    expected,
    descriptor,
  )
  if (descriptorProblems.length > 0) {
    return descriptorProblems
  }

  try {
    object = await adapters.objects.get(expected.digest)
  } catch (error) {
    return [
      `${label} object read failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    ]
  }

  if (!object) {
    return [`${label} object missing: ${expected.digest}`]
  }

  return verifyStoredObject(label, expected, object)
}
