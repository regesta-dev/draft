import { assertPackageVersion, type PackageId } from './package.ts'

export interface ParsedPackageId {
  ecosystem: string
  id: PackageId
  name: string
  ownerDomain: string
}

export interface PackageVersion {
  id: PackageId
  version: string
}

const ecosystemPattern = /^[a-z0-9-]+$/
const packageNamePattern = /^([^/]+)\/.*$/
const domainLabelPattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

export function parsePackageId(value: string): ParsedPackageId {
  if (typeof value !== 'string') {
    throw new TypeError('Package id must be a string')
  }

  const separatorIndex = value.indexOf(':')
  if (separatorIndex <= 0 || separatorIndex === value.length - 1) {
    throw new TypeError(`Invalid package id: ${value}`)
  }

  const ecosystem = value.slice(0, separatorIndex)
  const name = value.slice(separatorIndex + 1)

  if (!ecosystemPattern.test(ecosystem)) {
    throw new TypeError(`Invalid package ecosystem: ${ecosystem}`)
  }

  if (name.length === 0 || hasControlCharacter(name)) {
    throw new TypeError(`Invalid package name: ${value}`)
  }

  if (name.startsWith('@')) {
    throw new TypeError(
      `Package id must not include native package syntax: ${value}`,
    )
  }

  const match = packageNamePattern.exec(name)
  if (!match) {
    throw new TypeError(`Package id must include an owner domain: ${value}`)
  }

  const [, ownerDomain] = match
  const packageName = name.slice(ownerDomain.length + 1)
  if (!isCanonicalOwnerDomain(ownerDomain)) {
    throw new TypeError(`Package id owner must be a domain: ${value}`)
  }

  if (packageName.split('/').some((segment) => segment.length === 0)) {
    throw new TypeError(
      `Package id name must not contain empty segments: ${value}`,
    )
  }

  return {
    ecosystem,
    id: `${ecosystem}:${name}`,
    name,
    ownerDomain,
  }
}

export function isCanonicalOwnerDomain(value: string): boolean {
  if (value.length > 253 || !value.includes('.')) {
    return false
  }

  return value.split('.').every((label) => {
    return domainLabelPattern.test(label)
  })
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0)!
    return code <= 0x1f || code === 0x7f
  })
}

export function parsePackageVersion(value: string): PackageVersion {
  if (typeof value !== 'string') {
    throw new TypeError('Package version must be a string')
  }

  const separatorIndex = value.lastIndexOf('@')
  const ecosystemSeparatorIndex = value.indexOf(':')

  if (separatorIndex <= ecosystemSeparatorIndex) {
    throw new TypeError(`Package version must include a version: ${value}`)
  }

  const packageId = value.slice(0, separatorIndex)
  const version = assertPackageVersion(value.slice(separatorIndex + 1))

  return {
    id: parsePackageId(packageId).id,
    version,
  }
}
