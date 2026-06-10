import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { generateKeyMaterial, writeGeneratedKeyFiles } from './keygen.ts'

describe('generateKeyMaterial', () => {
  it('generates matching private, public, and domain binding key material', () => {
    const material = generateKeyMaterial({
      domain: 'example.com',
      kid: 'ed25519:test',
    })

    expect(material.privateKeyFile.kid).toBe('ed25519:test')
    expect(material.publicKeyFile).toEqual({
      alg: 'EdDSA',
      kid: 'ed25519:test',
      publicKeyJwk: {
        crv: 'Ed25519',
        kty: 'OKP',
        x: material.privateKeyFile.privateKeyJwk.x,
      },
      use: 'regesta-write',
    })
    expect(material.domainBinding).toEqual({
      domain: 'example.com',
      keys: [material.publicKeyFile],
      object: 'regesta.domain-binding',
    })
  })

  it('can generate private and public key files without a domain binding', () => {
    const material = generateKeyMaterial({ kid: 'ed25519:test' })

    expect(material.domainBinding).toBeUndefined()
    expect(material.privateKeyFile.privateKeyJwk.crv).toBe('Ed25519')
    expect(material.publicKeyFile.publicKeyJwk.x).toBe(
      material.privateKeyFile.privateKeyJwk.x,
    )
  })
})

describe('writeGeneratedKeyFiles', () => {
  it('writes private, public, and domain binding key files', async () => {
    const outputDir = await mkdtemp(join(tmpdir(), 'regesta-keygen-'))

    try {
      const files = await writeGeneratedKeyFiles({
        domain: 'example.com',
        kid: 'ed25519:test',
        outputDir,
      })

      await expect(readJson(files.privateKey)).resolves.toMatchObject({
        kid: 'ed25519:test',
        privateKeyJwk: {
          crv: 'Ed25519',
          kty: 'OKP',
        },
      })
      await expect(readJson(files.publicKey)).resolves.toMatchObject({
        alg: 'EdDSA',
        kid: 'ed25519:test',
        publicKeyJwk: {
          crv: 'Ed25519',
          kty: 'OKP',
        },
        use: 'regesta-write',
      })
      await expect(readJson(required(files.domainBinding))).resolves.toEqual({
        domain: 'example.com',
        keys: [
          {
            alg: 'EdDSA',
            kid: 'ed25519:test',
            publicKeyJwk: {
              crv: 'Ed25519',
              kty: 'OKP',
              x: expect.any(String),
            },
            use: 'regesta-write',
          },
        ],
        object: 'regesta.domain-binding',
      })
    } finally {
      await rm(outputDir, { force: true, recursive: true })
    }
  })

  it('does not overwrite existing key files unless force is enabled', async () => {
    const outputDir = await mkdtemp(join(tmpdir(), 'regesta-keygen-'))

    try {
      await writeFile(join(outputDir, 'private-key.json'), '{}\n')

      await expect(
        writeGeneratedKeyFiles({ force: false, outputDir }),
      ).rejects.toThrow()
      await expect(
        writeGeneratedKeyFiles({ force: true, outputDir }),
      ).resolves.toMatchObject({
        privateKey: join(outputDir, 'private-key.json'),
        publicKey: join(outputDir, 'public-key.json'),
      })
    } finally {
      await rm(outputDir, { force: true, recursive: true })
    }
  })
})

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8'))
}

function required(value: string | undefined): string {
  if (value === undefined) {
    throw new Error('Expected value to be defined')
  }

  return value
}
