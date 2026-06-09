import { describe, expect, it } from 'vitest'
import { assertObjectMediaType, assertSha256Digest, sha256 } from './digest.ts'

describe('sha256', () => {
  it('hashes strings and byte arrays', () => {
    const expected =
      'sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'

    expect(sha256('hello')).toBe(expected)
    expect(sha256(new TextEncoder().encode('hello'))).toBe(expected)
  })

  it('rejects unsupported runtime inputs', () => {
    expect(() => sha256(JSON.parse('null'))).toThrow(
      'sha256 input must be a string or Uint8Array',
    )
  })
})

describe('assertSha256Digest', () => {
  it('returns canonical sha256 digests', () => {
    const digest = sha256('hello')

    expect(assertSha256Digest(digest)).toBe(digest)
  })

  it('rejects non-string runtime inputs', () => {
    expect(() => assertSha256Digest(JSON.parse('null'))).toThrow(
      'sha256 digest must be a string',
    )
  })

  it('rejects malformed digest strings', () => {
    expect(() => assertSha256Digest('sha256:not-a-digest')).toThrow(
      'Invalid sha256 digest',
    )
  })
})

describe('assertObjectMediaType', () => {
  it('returns media types safe to store in object descriptors', () => {
    expect(assertObjectMediaType('application/gzip')).toBe('application/gzip')
    expect(assertObjectMediaType('application/json; charset=utf-8')).toBe(
      'application/json; charset=utf-8',
    )
  })

  it('rejects invalid runtime inputs', () => {
    expect(() => assertObjectMediaType(JSON.parse('null'))).toThrow(
      'Object mediaType must be a non-empty string',
    )
    expect(() => assertObjectMediaType('')).toThrow(
      'Object mediaType must be a non-empty string',
    )
    expect(() => assertObjectMediaType('text/plain\r\nx: y')).toThrow(
      'Object mediaType must not include control characters',
    )
  })
})
