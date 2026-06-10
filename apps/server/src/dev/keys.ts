import domainBindingJson from './domain-binding.json' with { type: 'json' }
import privateKeyJson from './private-key.json' with { type: 'json' }
import publicKeyJson from './public-key.json' with { type: 'json' }
import type {
  DomainBinding,
  DomainBindingKey,
  Ed25519PrivateKeyJwk,
  Ed25519PublicKeyJwk,
} from '@regesta/auth'

interface DevPrivateKeyFile {
  kid: string
  privateKeyJwk: Ed25519PrivateKeyJwk
}

interface DevPublicKeyFile {
  alg: 'EdDSA'
  kid: string
  publicKeyJwk: Ed25519PublicKeyJwk
  use: 'regesta-write'
}

// Public demo credentials for local development only. Never use these in production.
export const devLocalhostDomainBinding =
  normalizeDomainBinding(domainBindingJson)
export const devLocalhostPrivateKeyFile =
  normalizePrivateKeyFile(privateKeyJson)
export const devLocalhostPublicKeyFile = normalizePublicKeyFile(publicKeyJson)
const devLocalhostWriteKey = primaryWriteKey(devLocalhostDomainBinding)

export const devLocalhostDomain = devLocalhostDomainBinding.domain
export const devLocalhostKeyId = devLocalhostWriteKey.kid

assertDevKeyFilesMatch()

export const devLocalhostDomainBindingText = jsonText(devLocalhostDomainBinding)
export const devLocalhostPrivateKeyFileText = jsonText(
  devLocalhostPrivateKeyFile,
)
export const devLocalhostPublicKeyFileText = jsonText(devLocalhostPublicKeyFile)

export function jsonResponse(body: string): Response {
  return new Response(body, {
    headers: {
      'cache-control': 'no-store',
      'content-type': 'application/json; charset=utf-8',
    },
  })
}

function jsonText(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

function assertDevKeyFilesMatch(): void {
  if (devLocalhostDomain !== 'dev.localhost') {
    throw new Error('dev domain binding must be for dev.localhost')
  }

  if (devLocalhostPrivateKeyFile.kid !== devLocalhostKeyId) {
    throw new Error('dev private key kid must match domain binding key')
  }

  if (devLocalhostPublicKeyFile.kid !== devLocalhostKeyId) {
    throw new Error('dev public key kid must match domain binding key')
  }

  if (
    devLocalhostPrivateKeyFile.privateKeyJwk.x !==
    devLocalhostWriteKey.publicKeyJwk.x
  ) {
    throw new Error(
      'dev private key public component must match domain binding key',
    )
  }

  if (
    devLocalhostPublicKeyFile.publicKeyJwk.x !==
    devLocalhostWriteKey.publicKeyJwk.x
  ) {
    throw new Error('dev public key must match domain binding key')
  }
}

function normalizeDomainBinding(value: unknown): DomainBinding {
  const record = recordValue(value, 'dev domain binding')

  if (record.object !== 'regesta.domain-binding') {
    throw new Error('dev domain binding object must be regesta.domain-binding')
  }

  if (!Array.isArray(record.keys)) {
    throw new TypeError('dev domain binding keys must be an array')
  }

  return {
    domain: stringValue(record.domain, 'dev domain binding domain'),
    keys: record.keys.map((key) => normalizeDomainBindingKey(key)),
    object: 'regesta.domain-binding',
  }
}

function normalizeDomainBindingKey(value: unknown): DomainBindingKey {
  const record = recordValue(value, 'dev domain binding key')

  if (record.alg !== 'EdDSA') {
    throw new Error('dev domain binding key alg must be EdDSA')
  }

  if (record.use !== 'regesta-write') {
    throw new Error('dev domain binding key use must be regesta-write')
  }

  return {
    alg: 'EdDSA',
    kid: stringValue(record.kid, 'dev domain binding key kid'),
    publicKeyJwk: normalizePublicKeyJwk(record.publicKeyJwk),
    use: 'regesta-write',
  }
}

function normalizePrivateKeyFile(value: unknown): DevPrivateKeyFile {
  const record = recordValue(value, 'dev private key file')

  return {
    kid: stringValue(record.kid, 'dev private key kid'),
    privateKeyJwk: normalizePrivateKeyJwk(record.privateKeyJwk),
  }
}

function normalizePublicKeyFile(value: unknown): DevPublicKeyFile {
  const record = recordValue(value, 'dev public key file')

  if (record.alg !== 'EdDSA') {
    throw new Error('dev public key alg must be EdDSA')
  }

  if (record.use !== 'regesta-write') {
    throw new Error('dev public key use must be regesta-write')
  }

  return {
    alg: 'EdDSA',
    kid: stringValue(record.kid, 'dev public key kid'),
    publicKeyJwk: normalizePublicKeyJwk(record.publicKeyJwk),
    use: 'regesta-write',
  }
}

function normalizePrivateKeyJwk(value: unknown): Ed25519PrivateKeyJwk {
  const publicKey = normalizePublicKeyJwk(value)
  const record = recordValue(value, 'dev private key JWK')

  return {
    ...publicKey,
    d: stringValue(record.d, 'dev private key JWK d'),
  }
}

function normalizePublicKeyJwk(value: unknown): Ed25519PublicKeyJwk {
  const record = recordValue(value, 'dev public key JWK')

  if (record.crv !== 'Ed25519') {
    throw new Error('dev public key JWK crv must be Ed25519')
  }

  if (record.kty !== 'OKP') {
    throw new Error('dev public key JWK kty must be OKP')
  }

  return {
    crv: 'Ed25519',
    kty: 'OKP',
    x: stringValue(record.x, 'dev public key JWK x'),
  }
}

function primaryWriteKey(binding: DomainBinding): DomainBindingKey {
  const key = binding.keys[0]

  if (!key) {
    throw new Error('dev domain binding must include a write key')
  }

  return key
}

function recordValue(
  value: unknown,
  description: string,
): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${description} must be an object`)
  }

  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function stringValue(value: unknown, description: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${description} must be a non-empty string`)
  }

  return value
}
