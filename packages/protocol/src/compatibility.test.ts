import { describe, expect, it } from 'vitest'
import { assertCompatibilityString } from './compatibility.ts'

describe('assertCompatibilityString', () => {
  it('returns ecosystem-defined compatibility strings', () => {
    expect(assertCompatibilityString('node')).toBe('node')
    expect(assertCompatibilityString('>=20 || >=22')).toBe('>=20 || >=22')
    expect(assertCompatibilityString('linux')).toBe('linux')
  })

  it('rejects invalid runtime inputs', () => {
    expect(() => assertCompatibilityString(JSON.parse('null'))).toThrow(
      'Compatibility string must be a non-empty string',
    )
    expect(() => assertCompatibilityString('')).toThrow(
      'Compatibility string must be a non-empty string',
    )
    expect(() => assertCompatibilityString('node\r\nx')).toThrow(
      'Compatibility string must not include control characters',
    )
  })
})
