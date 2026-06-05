import type { Sha256Digest } from './digest.ts'

export type PackageId = `${string}:${string}`

export const defaultPackageChannel = 'latest'

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
