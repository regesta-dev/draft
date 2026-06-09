import { describe, expect, it } from 'vitest'
import { assertPackageChannel, assertPackageVersion } from './package.ts'

describe('assertPackageChannel', () => {
  it('returns custom channel names', () => {
    expect(assertPackageChannel('latest')).toBe('latest')
    expect(assertPackageChannel('beta')).toBe('beta')
    expect(assertPackageChannel('internal-preview')).toBe('internal-preview')
  })

  it('rejects invalid runtime inputs', () => {
    expect(() => assertPackageChannel(JSON.parse('null'))).toThrow(
      'Package channel must be a non-empty string',
    )
    expect(() => assertPackageChannel('')).toThrow(
      'Package channel must be a non-empty string',
    )
    expect(() => assertPackageChannel('latest\r\nx')).toThrow(
      'Package channel must not include control characters',
    )
  })
})

describe('assertPackageVersion', () => {
  it('returns ecosystem-defined version strings', () => {
    expect(assertPackageVersion('1.0.0')).toBe('1.0.0')
    expect(assertPackageVersion('2026.06.09')).toBe('2026.06.09')
  })

  it('rejects invalid runtime inputs', () => {
    expect(() => assertPackageVersion(JSON.parse('null'))).toThrow(
      'Package version must be a non-empty string',
    )
    expect(() => assertPackageVersion('')).toThrow(
      'Package version must be a non-empty string',
    )
    expect(() => assertPackageVersion('1.0.0\r\nx')).toThrow(
      'Package version must not include control characters',
    )
  })
})
