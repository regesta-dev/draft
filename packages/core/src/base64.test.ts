import { describe, expect, it } from 'vitest'
import { base64UrlToBytes, isBase64Url } from './base64.ts'

describe('base64url helpers', () => {
  it('decodes unpadded base64url values', () => {
    expect(new TextDecoder().decode(base64UrlToBytes('aGVsbG8td29ybGQ'))).toBe(
      'hello-world',
    )
  })

  it('rejects invalid base64url values before decoding', () => {
    expect(isBase64Url('aGVsbG8=')).toBe(false)
    expect(isBase64Url('aGVsbG8!')).toBe(false)
    expect(isBase64Url('A')).toBe(false)
    expect(() => base64UrlToBytes('A')).toThrow('Invalid base64url value')
  })
})
