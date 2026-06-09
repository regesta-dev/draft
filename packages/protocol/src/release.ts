import type { RegestaCompatibility } from './compatibility.ts'
import type { RegestaPackageExport } from './config.ts'
import type { ObjectDescriptor, Sha256Digest } from './digest.ts'
import type { PackageEcosystem, PackageId } from './package.ts'

export interface ReleaseMetadata {
  description?: string
  exports?: RegestaPackageExport
  repository?: string
}

export type ArtifactEcosystemMetadata = Record<string, unknown>

export type ArtifactRole =
  | 'ai-context'
  | 'attestation'
  | 'docs'
  | 'install'
  | 'signature'
  | 'types'
  | (string & {})

export function assertArtifactDescriptorString(
  value: unknown,
  label = 'Artifact descriptor string',
): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`)
  }

  if (hasControlCharacter(value)) {
    throw new TypeError(`${label} must not include control characters`)
  }

  return value
}

export interface ReleaseArtifact extends ObjectDescriptor {
  compatibility?: RegestaCompatibility
  ecosystemMetadata?: ArtifactEcosystemMetadata
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
  configDigest: Sha256Digest
  createdAt: string
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

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0)

    if (code !== undefined && (code <= 0x1f || code === 0x7f)) {
      return true
    }
  }

  return false
}
