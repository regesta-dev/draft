import { sha256 } from '@regesta/protocol'
import type { ReleasePublishArtifactDescriptorInput } from '@regesta/auth'
import type { PublishArtifactInput } from '@regesta/core'

export function releasePublishArtifactDescriptors(
  artifacts: PublishArtifactInput[],
): ReleasePublishArtifactDescriptorInput[] {
  return artifacts.map((artifact) => ({
    ...(artifact.compatibility === undefined
      ? {}
      : { compatibility: artifact.compatibility }),
    digest: sha256(artifact.bytes),
    ...(artifact.filename === undefined ? {} : { filename: artifact.filename }),
    ...(artifact.format === undefined ? {} : { format: artifact.format }),
    mediaType: artifact.mediaType,
    role: artifact.role,
  }))
}
