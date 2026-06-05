import type { RegestaCompatibility } from './compatibility.ts'
import type { PackageId } from './package.ts'

export interface RegestaConfig {
  id: PackageId
  version: string
  description?: string
  exports?: RegestaPackageExport
  files?: string[]
  family?: string
  languages?: string[]
  compatibility?: RegestaCompatibility
  provenance: RegestaProvenance
  repository?: string
  source: RegestaSourceConfig
}

export interface RegestaProvenance {
  level: 'source-attached'
}

export interface RegestaSourceConfig {
  exclude?: string[]
  include?: string[]
}

export type RegestaPackageExport =
  | null
  | string
  | RegestaPackageExport[]
  | { [key: string]: RegestaPackageExport }
