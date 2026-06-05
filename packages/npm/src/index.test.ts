import { describe, expect, it } from 'vitest'
import { npmPackageIdFromName, npmPackageName } from './index.ts'

describe('npm package projection', () => {
  it('projects canonical package ids to native npm names', () => {
    expect(npmPackageName('npm:some.dev/sdk')).toBe('@some.dev/sdk')
  })

  it('projects native npm names to canonical package ids', () => {
    expect(npmPackageIdFromName('@some.dev/sdk')).toBe('npm:some.dev/sdk')
  })

  it('rejects unscoped native npm names', () => {
    expect(() => npmPackageIdFromName('some-dev-sdk')).toThrow(
      'npm package name must be domain-scoped',
    )
  })
})
