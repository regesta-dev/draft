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
const npmScopedNamePattern = /^@([^/]+)\/[^/]+$/

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

  if (ecosystem !== 'npm') {
    return {
      ecosystem,
      id: `${ecosystem}:${name}`,
      name,
    }
  }

  const match = npmScopedNamePattern.exec(name)
  if (!match) {
    throw new TypeError(`Invalid npm package id: ${value}`)
  }

  const [, scope] = match
  if (!scope.includes('.')) {
    throw new TypeError(`Regesta v0 requires a domain npm scope: ${value}`)
  }

  return {
    ecosystem,
    id: `${ecosystem}:${name}`,
    name,
    scope,
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
