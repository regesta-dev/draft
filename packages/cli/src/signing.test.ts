import { Buffer } from 'node:buffer'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createReleasePublishIntent,
  sshEd25519PublicKeyId,
  type Ed25519PrivateKeyJwk,
} from '@regesta/auth'
import { sha256 } from '@regesta/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createConfiguredWriteAuthorization,
  resolveSshPublicKey,
} from './signing.ts'

const tempDirs: string[] = []

describe('signing helpers', () => {
  afterEach(async () => {
    await Promise.all(
      tempDirs.splice(0).map((path) => {
        return rm(path, { force: true, recursive: true })
      }),
    )
  })

  it('resolves ssh-ed25519 public keys from private key paths with .pub files', async () => {
    const tempDir = await tempDirectory()
    const privateKeyPath = join(tempDir, 'id_ed25519')
    const publicKey = sshPublicKey()

    await writeFile(`${privateKeyPath}.pub`, `${publicKey} test@example.com\n`)

    await expect(resolveSshPublicKey(privateKeyPath, tempDir)).resolves.toBe(
      publicKey,
    )
  })

  it('keeps --auth-key on the Ed25519 path by default', async () => {
    const tempDir = await tempDirectory()
    const privateKeyPath = join(tempDir, 'private-key.json')
    const privateKeyJwk = ed25519PrivateKeyJwk()
    const intent = createReleasePublishIntent({
      artifactDescriptorDigest: sha256(bytes('artifact descriptors')),
      artifactDigests: [sha256(bytes('artifact'))],
      configDigest: sha256(bytes('config')),
      nonce: 'signing-test',
      packageId: 'npm:example.com/signing-test',
      sourceDigest: sha256(bytes('source')),
      timestamp: '2026-06-01T00:00:00.000Z',
      version: '1.0.0',
    })

    await writeFile(
      privateKeyPath,
      JSON.stringify({
        kid: 'ed25519:test',
        privateKeyJwk,
      }),
    )

    await expect(
      createConfiguredWriteAuthorization(intent, {
        authKey: privateKeyPath,
        cwd: tempDir,
      }),
    ).resolves.toMatchObject({
      alg: 'EdDSA',
      kid: 'ed25519:test',
    })
  })

  it('derives ssh key ids from the configured ssh signing public key', async () => {
    const tempDir = await tempDirectory()
    const publicKey = sshPublicKey()

    await expect(
      createConfiguredWriteAuthorization(createIntent(), {
        cwd: tempDir,
        sshSigningKey: publicKey,
        sshSigningProgram: join(tempDir, 'missing-signer'),
      }),
    ).rejects.toThrow(join(tempDir, 'missing-signer'))
    await expect(resolveSshPublicKey(publicKey, tempDir)).resolves.toBe(
      publicKey,
    )
    expect(sshEd25519PublicKeyId(publicKey)).toMatch(/^ssh-ed25519:/u)
  })
})

async function tempDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'regesta-signing-test-'))
  tempDirs.push(path)
  return path
}

function createIntent() {
  return createReleasePublishIntent({
    artifactDescriptorDigest: sha256(bytes('artifact descriptors')),
    artifactDigests: [sha256(bytes('artifact'))],
    configDigest: sha256(bytes('config')),
    nonce: 'signing-test',
    packageId: 'npm:example.com/signing-test',
    sourceDigest: sha256(bytes('source')),
    timestamp: '2026-06-01T00:00:00.000Z',
    version: '1.0.0',
  })
}

function sshPublicKey(): string {
  const { publicKey } = generateKeyPairSync('ed25519')
  const jwk = publicKey.export({ format: 'jwk' })

  if (jwk.crv !== 'Ed25519' || typeof jwk.x !== 'string') {
    throw new Error('Generated key must be Ed25519')
  }

  return sshEd25519PublicKeyText(Buffer.from(jwk.x, 'base64url'))
}

function sshEd25519PublicKeyText(publicKey: Uint8Array): string {
  return `ssh-ed25519 ${Buffer.from(sshEd25519PublicKeyBlob(publicKey)).toString('base64')}`
}

function sshEd25519PublicKeyBlob(publicKey: Uint8Array): Uint8Array {
  return concatBytes(sshString(bytes('ssh-ed25519')), sshString(publicKey))
}

function sshString(value: Uint8Array): Uint8Array {
  return concatBytes(uint32(value.byteLength), value)
}

function uint32(value: number): Uint8Array {
  const output = new Uint8Array(4)
  const view = new DataView(output.buffer)

  view.setUint32(0, value, false)

  return output
}

function concatBytes(...chunks: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(
    chunks.reduce((total, chunk) => total + chunk.byteLength, 0),
  )
  let offset = 0

  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.byteLength
  }

  return output
}

function ed25519PrivateKeyJwk(): Ed25519PrivateKeyJwk {
  const { privateKey } = generateKeyPairSync('ed25519')
  const jwk = privateKey.export({ format: 'jwk' })

  if (
    jwk.kty !== 'OKP' ||
    jwk.crv !== 'Ed25519' ||
    typeof jwk.x !== 'string' ||
    typeof jwk.d !== 'string'
  ) {
    throw new Error('Generated key must be Ed25519')
  }

  return {
    crv: 'Ed25519',
    d: jwk.d,
    kty: 'OKP',
    x: jwk.x,
  }
}

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value)
}
