import type { ObjectDescriptor, Sha256Digest } from './digest.ts'

export type RegestaPackageExport =
  | null
  | string
  | RegestaPackageExport[]
  | { [key: string]: RegestaPackageExport }

export interface RegestaArtifactConfig {
  npmTarball?: {
    path?: string
  }
}

export interface RegestaCompatibility {
  packageManagers?: string[]
  runtimes?: string[]
}

export interface RegestaConfig {
  artifacts?: RegestaArtifactConfig
  compatibility?: RegestaCompatibility
  description?: string
  exports?: RegestaPackageExport
  files?: string[]
  package: `@${string}/${string}`
  provenance: RegestaProvenance
  repository?: string
  schema?: 'regesta.config.v0'
  source: RegestaSourceConfig
  version: string
}

export interface RegestaProvenance {
  command?: string
  level: 'declared-build' | 'source-attached'
  toolchain?: Record<string, string>
}

export interface RegestaSourceConfig {
  exclude?: string[]
  include?: string[]
}

export interface ReleaseMetadata {
  description?: string
  exports?: RegestaPackageExport
  repository?: string
}

export interface ReleaseManifest {
  artifacts: {
    npmTarball: ObjectDescriptor
  }
  compatibility?: RegestaCompatibility
  configDigest: Sha256Digest
  createdAt: string
  metadata?: ReleaseMetadata
  package: `@${string}/${string}`
  provenance: ReleaseProvenance
  schema: 'regesta.release-manifest.v0'
  source: ObjectDescriptor
  version: string
}

export interface ReleaseProvenance {
  command?: string
  level: 'declared-build' | 'source-attached'
  toolchain?: Record<string, string>
  verified: false
}

export interface RegistryEvent {
  id: Sha256Digest
  manifestDigest: Sha256Digest
  package: `@${string}/${string}`
  schema: 'regesta.event.v0'
  sourceDigest: Sha256Digest
  timestamp: string
  type: 'PUBLISH_RELEASE'
  version: string
}

export interface NpmPackument {
  'dist-tags': Record<string, string>
  name: `@${string}/${string}`
  versions: Record<string, NpmPackumentVersion>
}

export interface NpmPackumentVersion {
  dist: {
    integrity: string
    tarball: string
  }
  name: `@${string}/${string}`
  version: string
}
