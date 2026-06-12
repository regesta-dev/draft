import { describe, expect, it } from 'vitest'
import {
  isCanonicalOwnerDomain,
  parsePackageId,
  parsePackageVersion,
} from './package-id.ts'

describe('parsePackageId', () => {
  it('parses canonical domain-scoped package ids', () => {
    expect(parsePackageId('npm:some.dev/sdk')).toEqual({
      ecosystem: 'npm',
      id: 'npm:some.dev/sdk',
      name: 'some.dev/sdk',
      ownerDomain: 'some.dev',
    })
  })

  it('parses owner domains without ecosystem-specific package concepts', () => {
    expect(parsePackageId('pypi:some.dev/sdk')).toEqual({
      ecosystem: 'pypi',
      id: 'pypi:some.dev/sdk',
      name: 'some.dev/sdk',
      ownerDomain: 'some.dev',
    })
  })

  it('uses the same domain-scoped package id shape for documented example ecosystems', () => {
    for (const ecosystem of ['npm', 'pypi', 'cargo', 'go', 'oci']) {
      expect(parsePackageId(`${ecosystem}:some.dev/sdk`)).toEqual({
        ecosystem,
        id: `${ecosystem}:some.dev/sdk`,
        name: 'some.dev/sdk',
        ownerDomain: 'some.dev',
      })
    }
  })

  it('accepts future ecosystem keys without changing the core id parser', () => {
    expect(parsePackageId('maven:some.dev/group/artifact')).toEqual({
      ecosystem: 'maven',
      id: 'maven:some.dev/group/artifact',
      name: 'some.dev/group/artifact',
      ownerDomain: 'some.dev',
    })
    expect(parsePackageId('swift-pm:some.dev/sdk')).toEqual({
      ecosystem: 'swift-pm',
      id: 'swift-pm:some.dev/sdk',
      name: 'some.dev/sdk',
      ownerDomain: 'some.dev',
    })
  })

  it('allows multi-segment package names for ecosystems that need paths', () => {
    expect(parsePackageId('go:some.dev/releases/pkg')).toEqual({
      ecosystem: 'go',
      id: 'go:some.dev/releases/pkg',
      name: 'some.dev/releases/pkg',
      ownerDomain: 'some.dev',
    })
  })

  it('rejects native package-manager syntax in canonical ids', () => {
    expect(() => parsePackageId('npm:@some.dev/sdk')).toThrow(
      'Package id must not include native package syntax',
    )
  })

  it('requires ecosystem keys to be lowercase portable identifiers', () => {
    for (const id of [
      'NPM:some.dev/sdk',
      'npm_js:some.dev/sdk',
      'npm.js:some.dev/sdk',
      'npm+js:some.dev/sdk',
    ]) {
      expect(() => parsePackageId(id)).toThrow('Invalid package ecosystem')
    }
  })

  it('rejects non-string package id inputs', () => {
    expect(() => parsePackageId(JSON.parse('null'))).toThrow(
      'Package id must be a string',
    )
  })

  it('requires the owner segment to be a domain', () => {
    expect(() => parsePackageId('npm:some/sdk')).toThrow(
      'Package id owner must be a domain',
    )
  })

  it('requires canonical lowercase DNS-style owner domains', () => {
    for (const id of [
      'npm:Some.dev/sdk',
      'npm:some .dev/sdk',
      'npm:-some.dev/sdk',
      'npm:some-.dev/sdk',
      'npm:some..dev/sdk',
    ]) {
      expect(() => parsePackageId(id)).toThrow(
        'Package id owner must be a domain',
      )
    }
  })

  it('rejects empty package name path segments', () => {
    for (const id of [
      'npm:some.dev/',
      'npm:some.dev//sdk',
      'go:some.dev/releases/',
      'go:some.dev/releases//pkg',
    ]) {
      expect(() => parsePackageId(id)).toThrow(
        'Package id name must not contain empty segments',
      )
    }
  })
})

describe('isCanonicalOwnerDomain', () => {
  it('accepts only lowercase DNS-style owner domains', () => {
    expect(isCanonicalOwnerDomain('some.dev')).toBe(true)
    expect(isCanonicalOwnerDomain('Some.dev')).toBe(false)
    expect(isCanonicalOwnerDomain('some')).toBe(false)
    expect(isCanonicalOwnerDomain('some..dev')).toBe(false)
    expect(isCanonicalOwnerDomain('some-.dev')).toBe(false)
  })
})

describe('parsePackageVersion', () => {
  it('splits version from package id at the last at sign', () => {
    expect(parsePackageVersion('npm:some.dev/sdk@1.2.3')).toEqual({
      id: 'npm:some.dev/sdk',
      version: '1.2.3',
    })
  })

  it('rejects non-string package version inputs', () => {
    expect(() => parsePackageVersion(JSON.parse('null'))).toThrow(
      'Package version must be a string',
    )
  })

  it('rejects invalid package version values', () => {
    expect(() => parsePackageVersion('npm:some.dev/sdk@')).toThrow(
      'Package version must be a non-empty string',
    )
    expect(() => parsePackageVersion('npm:some.dev/sdk@1.2.3\r\nx')).toThrow(
      'Package version must not include control characters',
    )
  })
})
