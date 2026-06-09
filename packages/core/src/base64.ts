import { Buffer } from 'node:buffer'

export function base64ToBytes(value: string): Uint8Array {
  return Buffer.from(value, 'base64')
}

export function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64')
}

export function base64UrlToBytes(value: string): Uint8Array {
  if (!isBase64Url(value)) {
    throw new TypeError('Invalid base64url value')
  }

  return base64ToBytes(
    paddedBase64(value.replaceAll('-', '+').replaceAll('_', '/')),
  )
}

export function isBase64Url(value: string): boolean {
  return /^[\w-]+$/u.test(value) && value.length % 4 !== 1
}

function paddedBase64(value: string): string {
  const remainder = value.length % 4

  return remainder === 0
    ? value
    : value.padEnd(value.length + 4 - remainder, '=')
}
