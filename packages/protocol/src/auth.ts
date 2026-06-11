import type { Sha256Digest } from './digest.ts'

export interface Ed25519PublicKeyJwk {
  crv: 'Ed25519'
  kty: 'OKP'
  x: string
}

export type WriteAuthorizationProof =
  | Ed25519WriteAuthorizationProof
  | SshEd25519WriteAuthorizationProof

export interface WriteAuthorizationProofBase {
  domain: string
  kid: string
  object: 'regesta.authorization-proof'
  payloadDigest: Sha256Digest
  signature: string
  signedAt: string
  wellKnownDigest: Sha256Digest
}

export interface Ed25519WriteAuthorizationProof extends WriteAuthorizationProofBase {
  alg: 'EdDSA'
  publicKeyJwk: Ed25519PublicKeyJwk
}

export interface SshEd25519WriteAuthorizationProof extends WriteAuthorizationProofBase {
  alg: 'ssh-ed25519'
  publicKey: string
}
