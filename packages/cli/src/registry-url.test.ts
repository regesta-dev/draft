import { describe, expect, it } from 'vitest'
import { normalizeRegistryUrl } from './registry-url.ts'

describe('normalizeRegistryUrl', () => {
  it('removes trailing slashes without changing the registry origin or path', () => {
    expect(normalizeRegistryUrl('https://registry.regesta.dev')).toBe(
      'https://registry.regesta.dev',
    )
    expect(normalizeRegistryUrl('https://registry.regesta.dev/')).toBe(
      'https://registry.regesta.dev',
    )
    expect(normalizeRegistryUrl('https://registry.example/prefix///')).toBe(
      'https://registry.example/prefix',
    )
  })
})
