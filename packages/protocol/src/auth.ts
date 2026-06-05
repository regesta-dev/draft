import type { Sha256Digest } from './digest.ts'

export interface Ed25519PublicKeyJwk {
  crv: 'Ed25519'
  kty: 'OKP'
  x: string
}

export interface WriteAuthorizationProof {
  alg: 'EdDSA'
  domain: string
  kid: string
  object: 'regesta.authorization-proof'
  payloadDigest: Sha256Digest
  publicKeyJwk: Ed25519PublicKeyJwk
  signature: string
  signedAt: string
  specVersion: 0
  wellKnownDigest: Sha256Digest
}
