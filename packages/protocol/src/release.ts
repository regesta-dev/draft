import type { RegestaCompatibility } from './compatibility.ts'
import type { RegestaPackageExport } from './config.ts'
import type { ObjectDescriptor, Sha256Digest } from './digest.ts'
import type { NpmReleaseMetadata } from './npm.ts'
import type { PackageEcosystem, PackageId } from './package.ts'

export interface ReleaseMetadata {
  description?: string
  exports?: RegestaPackageExport
  repository?: string
}

export interface ReleaseEcosystemMetadata {
  npm?: NpmReleaseMetadata
}

export type ArtifactRole =
  | 'ai-context'
  | 'attestation'
  | 'docs'
  | 'install'
  | 'signature'
  | 'types'
  | (string & {})

export interface ReleaseArtifact extends ObjectDescriptor {
  ecosystem?: PackageEcosystem
  filename?: string
  format?: string
  role: ArtifactRole
}

export interface ReleaseManifest {
  object: 'regesta.release-manifest'
  specVersion: 0
  id: PackageId
  ecosystem: PackageEcosystem
  name: string
  version: string
  artifacts: ReleaseArtifact[]
  compatibility?: RegestaCompatibility
  configDigest: Sha256Digest
  createdAt: string
  ecosystemMetadata?: ReleaseEcosystemMetadata
  family?: string
  languages?: string[]
  metadata?: ReleaseMetadata
  provenance: ReleaseProvenance
  source: ObjectDescriptor
}

export interface ReleaseProvenance {
  level: 'source-attached'
  verified: false
}
