import { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import {
  createSshWriteAuthorization,
  createWriteAuthorization,
  normalizeSshEd25519PublicKey,
  regestaSshSignatureNamespace,
  sshEd25519PublicKeyId,
  writeIntentPayloadBytes,
  type Ed25519PrivateKeyJwk,
  type WriteAuthorization,
  type WriteIntent,
} from '@regesta/auth'

export interface CreateConfiguredWriteAuthorizationInput {
  authKey?: string
  cwd: string
  kid?: string
  signingFormat?: string
  sshSigningKey?: string
  sshSigningProgram?: string
}

export async function createConfiguredWriteAuthorization(
  intent: WriteIntent,
  input: CreateConfiguredWriteAuthorizationInput,
): Promise<WriteAuthorization> {
  const format = normalizeSigningFormat(
    input.signingFormat ?? (input.authKey ? 'ed25519' : 'ssh'),
  )

  if (format === 'ed25519') {
    return createWriteAuthorization(
      intent,
      await readAuthKey(input.authKey, input.kid),
    )
  }

  const signingKey = input.sshSigningKey
  if (!signingKey) {
    throw new Error('Missing --ssh-signing-key for ssh signed publish')
  }

  const publicKey = await resolveSshPublicKey(signingKey, input.cwd)
  const kid = input.kid ?? sshEd25519PublicKeyId(publicKey)
  const signature = await signWithSshProgram({
    cwd: input.cwd,
    payload: writeIntentPayloadBytes(intent),
    program: input.sshSigningProgram ?? 'ssh-keygen',
    signingKey,
  })

  return createSshWriteAuthorization(intent, {
    kid,
    signature,
  })
}

export async function resolveSshPublicKey(
  signingKey: string,
  cwd: string,
): Promise<string> {
  const trimmed = signingKey.trim()
  if (trimmed.startsWith('ssh-ed25519 ')) {
    return normalizeSshEd25519PublicKey(trimmed)
  }

  const keyPath = resolvePath(cwd, trimmed)
  const directPublicKey = await readSshPublicKeyFile(keyPath)
  if (directPublicKey) {
    return directPublicKey
  }

  const publicKey = await readSshPublicKeyFile(`${keyPath}.pub`)
  if (publicKey) {
    return publicKey
  }

  throw new Error(
    'SSH signing key must be an ssh-ed25519 public key, public key file, or private key path with a .pub file',
  )
}

async function readAuthKey(
  path: string | undefined,
  kid: string | undefined,
): Promise<{ kid: string; privateKeyJwk: Ed25519PrivateKeyJwk }> {
  if (!path) {
    throw new Error('Missing --auth-key for Ed25519 signed publish')
  }

  const value: unknown = JSON.parse(await readFile(path, 'utf8'))
  const keyFile = normalizeAuthKeyFile(value)
  const resolvedKid = kid ?? keyFile.kid

  if (!resolvedKid) {
    throw new Error('Missing --kid or kid in auth key file')
  }

  return {
    kid: resolvedKid,
    privateKeyJwk: keyFile.privateKeyJwk,
  }
}

function normalizeAuthKeyFile(value: unknown): {
  kid?: string
  privateKeyJwk: Ed25519PrivateKeyJwk
} {
  if (!isRecord(value)) {
    throw new Error('Auth key file must be a JSON object')
  }

  const privateKeyJwk =
    value.privateKeyJwk === undefined ? value : value.privateKeyJwk

  return {
    ...(typeof value.kid === 'string' ? { kid: value.kid } : {}),
    privateKeyJwk: normalizePrivateKeyJwk(privateKeyJwk),
  }
}

function normalizePrivateKeyJwk(value: unknown): Ed25519PrivateKeyJwk {
  if (!isRecord(value)) {
    throw new TypeError('privateKeyJwk must be an object')
  }

  if (value.kty !== 'OKP' || value.crv !== 'Ed25519') {
    throw new Error('privateKeyJwk must be an Ed25519 OKP JWK')
  }

  if (typeof value.x !== 'string' || typeof value.d !== 'string') {
    throw new TypeError('privateKeyJwk must include x and d')
  }

  return {
    crv: value.crv,
    d: value.d,
    kty: value.kty,
    x: value.x,
  }
}

function normalizeSigningFormat(value: string): 'ed25519' | 'ssh' {
  if (value === 'ed25519' || value === 'ssh') {
    return value
  }

  throw new Error(`Unsupported signing format: ${value}`)
}

async function signWithSshProgram(input: {
  cwd: string
  payload: Uint8Array
  program: string
  signingKey: string
}): Promise<string> {
  const tempDir = await mkdtemp(join(tmpdir(), 'regesta-ssh-sign-'))
  const payloadPath = join(tempDir, 'payload')
  const signaturePath = `${payloadPath}.sig`

  try {
    await writeFile(payloadPath, input.payload)

    const result = await execFile(
      input.program,
      [
        '-Y',
        'sign',
        '-f',
        input.signingKey,
        '-n',
        regestaSshSignatureNamespace,
        payloadPath,
      ],
      {
        cwd: input.cwd,
      },
    )

    const fileSignature = await readOptionalText(signaturePath)
    if (fileSignature) {
      return fileSignature
    }

    const stdoutSignature = extractSshSignature(result.stdout)
    if (stdoutSignature) {
      return stdoutSignature
    }

    throw new Error(
      `SSH signing program did not produce a signature: ${result.stderr.trim()}`,
    )
  } finally {
    await rm(tempDir, { force: true, recursive: true })
  }
}

async function readSshPublicKeyFile(path: string): Promise<string | undefined> {
  let text: string

  try {
    text = await readFile(path, 'utf8')
  } catch {
    return undefined
  }

  const line = text
    .split(/\r?\n/u)
    .map((item) => item.trim())
    .find((item) => item.startsWith('ssh-ed25519 '))

  return line === undefined ? undefined : normalizeSshEd25519PublicKey(line)
}

async function readOptionalText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return undefined
  }
}

function extractSshSignature(value: string): string | undefined {
  const match = value.match(
    /-----BEGIN SSH SIGNATURE-----[\s\S]*?-----END SSH SIGNATURE-----/u,
  )

  return match?.[0]
}

function execFile(
  command: string,
  args: string[],
  options: { cwd: string },
): Promise<{ stderr: string; stdout: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []

    child.stdout.on('data', (chunk: Buffer) => {
      stdout.push(chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr.push(chunk)
    })
    child.on('error', reject)
    child.on('close', (code) => {
      const result = {
        stderr: Buffer.concat(stderr).toString('utf8'),
        stdout: Buffer.concat(stdout).toString('utf8'),
      }

      if (code === 0) {
        resolvePromise(result)
        return
      }

      reject(
        new Error(
          `${command} ${args.join(' ')} failed with exit code ${code}: ${result.stderr.trim()}`,
        ),
      )
    })
  })
}

function resolvePath(cwd: string, path: string): string {
  return isAbsolute(path) ? path : resolve(cwd, path)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
