import type { Sha256Digest } from './digest.ts'

export type PackageId = `${string}:${string}`

export const defaultPackageChannel = 'latest'

export function assertPackageChannel(
  value: unknown,
  label = 'Package channel',
): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`)
  }

  if (hasControlCharacter(value)) {
    throw new TypeError(`${label} must not include control characters`)
  }

  return value
}

export function assertPackageVersion(
  value: unknown,
  label = 'Package version',
): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`)
  }

  if (hasControlCharacter(value)) {
    throw new TypeError(`${label} must not include control characters`)
  }

  return value
}

export type PackageEcosystem =
  | 'cargo'
  | 'go'
  | 'npm'
  | 'oci'
  | 'pypi'
  | (string & {})

export interface PackageState {
  channels?: Record<string, string>
  ecosystem: PackageEcosystem
  id: PackageId
  name: string
  object: 'regesta.package-state'
  releases: PackageStateRelease[]
  specVersion: 0
}

export interface PackageStateRelease {
  createdAt: string
  manifestDigest: Sha256Digest
  version: string
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0)

    if (code !== undefined && (code <= 0x1f || code === 0x7f)) {
      return true
    }
  }

  return false
}
