import { generateKeyPairSync, randomBytes } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  DomainBinding,
  Ed25519DomainBindingKey,
  Ed25519PrivateKeyJwk,
  Ed25519PublicKeyJwk,
} from '@regesta/auth'

export interface GenerateKeyMaterialInput {
  domain?: string
  kid?: string
}

export interface GeneratedKeyMaterial {
  domainBinding?: DomainBinding
  privateKeyFile: PrivateKeyFile
  publicKeyFile: PublicKeyFile
}

export interface PrivateKeyFile {
  kid: string
  privateKeyJwk: Ed25519PrivateKeyJwk
}

export interface PublicKeyFile extends Ed25519DomainBindingKey {}

export interface WriteGeneratedKeyFilesInput extends GenerateKeyMaterialInput {
  force?: boolean
  outputDir: string
}

export interface WrittenGeneratedKeyFiles {
  domainBinding?: string
  privateKey: string
  publicKey: string
}

export function generateKeyMaterial(
  input: GenerateKeyMaterialInput = {},
): GeneratedKeyMaterial {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const privateKeyJwk = normalizePrivateKeyJwk(
    privateKey.export({ format: 'jwk' }),
  )
  const publicKeyJwk = normalizePublicKeyJwk(
    publicKey.export({ format: 'jwk' }),
  )
  const kid = input.kid ?? randomKeyId()

  if (privateKeyJwk.x !== publicKeyJwk.x) {
    throw new Error('Generated private key public component does not match')
  }

  const publicKeyFile: PublicKeyFile = {
    alg: 'EdDSA',
    kid,
    publicKeyJwk,
    use: 'regesta-write',
  }

  return {
    ...(input.domain === undefined
      ? {}
      : {
          domainBinding: {
            domain: input.domain,
            keys: [publicKeyFile],
            object: 'regesta.domain-binding',
          },
        }),
    privateKeyFile: {
      kid,
      privateKeyJwk,
    },
    publicKeyFile,
  }
}

export async function writeGeneratedKeyFiles(
  input: WriteGeneratedKeyFilesInput,
): Promise<WrittenGeneratedKeyFiles> {
  const material = generateKeyMaterial(input)
  await mkdir(input.outputDir, { recursive: true })

  const privateKeyPath = join(input.outputDir, 'private-key.json')
  const publicKeyPath = join(input.outputDir, 'public-key.json')
  const domainBindingPath = join(input.outputDir, 'domain-binding.json')

  await writeJsonFile(privateKeyPath, material.privateKeyFile, {
    force: input.force,
    private: true,
  })
  await writeJsonFile(publicKeyPath, material.publicKeyFile, {
    force: input.force,
  })

  if (material.domainBinding !== undefined) {
    await writeJsonFile(domainBindingPath, material.domainBinding, {
      force: input.force,
    })
  }

  return {
    ...(material.domainBinding === undefined
      ? {}
      : { domainBinding: domainBindingPath }),
    privateKey: privateKeyPath,
    publicKey: publicKeyPath,
  }
}

function randomKeyId(): string {
  return `ed25519:${randomBytes(8).toString('base64url')}`
}

async function writeJsonFile(
  path: string,
  value: unknown,
  options: { force?: boolean; private?: boolean } = {},
): Promise<void> {
  const flag = options.force ? 'w' : 'wx'
  const text = `${JSON.stringify(value, null, 2)}\n`

  if (options.private) {
    await writeFile(path, text, { flag, mode: 0o600 })
    return
  }

  await writeFile(path, text, { flag })
}

function normalizePrivateKeyJwk(value: unknown): Ed25519PrivateKeyJwk {
  const publicKey = normalizePublicKeyJwk(value)
  const record = recordValue(value, 'private key JWK')

  if (typeof record.d !== 'string' || record.d.length === 0) {
    throw new Error('private key JWK d must be a non-empty string')
  }

  return {
    ...publicKey,
    d: record.d,
  }
}

function normalizePublicKeyJwk(value: unknown): Ed25519PublicKeyJwk {
  const record = recordValue(value, 'public key JWK')

  if (record.crv !== 'Ed25519') {
    throw new Error('public key JWK crv must be Ed25519')
  }

  if (record.kty !== 'OKP') {
    throw new Error('public key JWK kty must be OKP')
  }

  if (typeof record.x !== 'string' || record.x.length === 0) {
    throw new Error('public key JWK x must be a non-empty string')
  }

  return {
    crv: 'Ed25519',
    kty: 'OKP',
    x: record.x,
  }
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
