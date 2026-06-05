import { describe, expect, it } from 'vitest'
import { parsePackageId, parsePackageVersion } from './package-id.ts'

describe('parsePackageId', () => {
  it('parses canonical domain-scoped package ids', () => {
    expect(parsePackageId('npm:some.dev/sdk')).toEqual({
      ecosystem: 'npm',
      id: 'npm:some.dev/sdk',
      name: 'some.dev/sdk',
      scope: 'some.dev',
    })
  })

  it('rejects native package-manager syntax in canonical ids', () => {
    expect(() => parsePackageId('npm:@some.dev/sdk')).toThrow(
      'Package id must not include native package syntax',
    )
  })

  it('requires the owner segment to be a domain', () => {
    expect(() => parsePackageId('npm:some/sdk')).toThrow(
      'Package id owner must be a domain',
    )
  })
})

describe('parsePackageVersion', () => {
  it('splits version from package id at the last at sign', () => {
    expect(parsePackageVersion('npm:some.dev/sdk@1.2.3')).toEqual({
      id: 'npm:some.dev/sdk',
      version: '1.2.3',
    })
  })
})
