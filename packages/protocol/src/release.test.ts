import { describe, expect, it } from 'vitest'
import { assertArtifactDescriptorString } from './release.ts'

describe('assertArtifactDescriptorString', () => {
  it('returns custom artifact descriptor strings', () => {
    expect(assertArtifactDescriptorString('install')).toBe('install')
    expect(assertArtifactDescriptorString('npm-tarball')).toBe('npm-tarball')
    expect(assertArtifactDescriptorString('sdk-1.0.0.tgz')).toBe(
      'sdk-1.0.0.tgz',
    )
  })

  it('rejects invalid runtime inputs', () => {
    expect(() => assertArtifactDescriptorString(JSON.parse('null'))).toThrow(
      'Artifact descriptor string must be a non-empty string',
    )
    expect(() => assertArtifactDescriptorString('')).toThrow(
      'Artifact descriptor string must be a non-empty string',
    )
    expect(() => assertArtifactDescriptorString('install\r\nx')).toThrow(
      'Artifact descriptor string must not include control characters',
    )
  })
})
