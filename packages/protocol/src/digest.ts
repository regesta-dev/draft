import { createHash } from 'node:crypto'

export type Sha256Digest = `sha256:${string}`

export interface ObjectDescriptor {
  digest: Sha256Digest
  size: number
  mediaType: string
}

export function sha256(data: Uint8Array | string): Sha256Digest {
  if (typeof data !== 'string' && !(data instanceof Uint8Array)) {
    throw new TypeError('sha256 input must be a string or Uint8Array')
  }

  const hash = createHash('sha256')
  hash.update(data)
  return `sha256:${hash.digest('hex')}`
}

export function assertSha256Digest(value: string): Sha256Digest {
  if (typeof value !== 'string') {
    throw new TypeError('sha256 digest must be a string')
  }

  if (!/^sha256:[a-f0-9]{64}$/.test(value)) {
    throw new TypeError(`Invalid sha256 digest: ${value}`)
  }

  return `sha256:${value.slice('sha256:'.length)}`
}

export function assertObjectMediaType(
  value: unknown,
  label = 'Object mediaType',
): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`)
  }

  if (hasObjectMediaTypeControlCharacter(value)) {
    throw new TypeError(`${label} must not include control characters`)
  }

  return value
}

function hasObjectMediaTypeControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.codePointAt(index)

    if (code !== undefined && (code <= 0x1f || code === 0x7f)) {
      return true
    }
  }

  return false
}
