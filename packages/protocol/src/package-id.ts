import type { PackageId } from './package.ts'

export interface ParsedPackageId {
  ecosystem: string
  id: PackageId
  name: string
  scope?: string
}

export interface PackageVersion {
  id: PackageId
  version: string
}

const ecosystemPattern = /^[a-z0-9-]+$/
const packageNamePattern = /^([^/]+)\/.+$/

export function parsePackageId(value: string): ParsedPackageId {
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
  if (!ownerDomain.includes('.')) {
    throw new TypeError(`Package id owner must be a domain: ${value}`)
  }

  return {
    ecosystem,
    id: `${ecosystem}:${name}`,
    name,
    ...(ecosystem === 'npm' ? { scope: ownerDomain } : {}),
  }
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0)!
    return code <= 0x1f || code === 0x7f
  })
}

export function parsePackageVersion(value: string): PackageVersion {
  const separatorIndex = value.lastIndexOf('@')
  const ecosystemSeparatorIndex = value.indexOf(':')

  if (separatorIndex <= ecosystemSeparatorIndex) {
    throw new TypeError(`Package version must include a version: ${value}`)
  }

  const packageId = value.slice(0, separatorIndex)
  const version = value.slice(separatorIndex + 1)
  if (!version) {
    throw new TypeError(`Package version must include a version: ${value}`)
  }

  return {
    id: parsePackageId(packageId).id,
    version,
  }
}
