import { createHash } from 'node:crypto'

export type Sha256Digest = `sha256:${string}`

export interface ObjectDescriptor {
  digest: Sha256Digest
  size: number
  mediaType: string
}

export function sha256(data: Uint8Array | string): Sha256Digest {
  const hash = createHash('sha256')
  hash.update(data)
  return `sha256:${hash.digest('hex')}`
}

export function assertSha256Digest(value: string): Sha256Digest {
  if (!/^sha256:[a-f0-9]{64}$/.test(value)) {
    throw new TypeError(`Invalid sha256 digest: ${value}`)
  }

  return value as Sha256Digest
}
