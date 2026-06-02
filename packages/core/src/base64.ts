import { Buffer } from 'node:buffer'

export function base64ToBytes(value: string): Uint8Array {
  return Buffer.from(value, 'base64')
}

export function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64')
}
