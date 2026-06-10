import type { RegestaConfig, ReleaseArtifact } from '@regesta/protocol'

export interface PublishArtifactForProcessing {
  bytes: Uint8Array
  compatibility?: ReleaseArtifact['compatibility']
  ecosystemMetadata?: ReleaseArtifact['ecosystemMetadata']
  filename?: string
  format?: string
  mediaType: string
  role: string
}

export interface ProcessPublishArtifactsInput {
  artifacts: PublishArtifactForProcessing[]
  config: RegestaConfig
}

export interface ProcessPublishArtifactsOutput {
  artifacts: PublishArtifactForProcessing[]
  config: RegestaConfig
}

export type PublishArtifactProcessor = (
  input: ProcessPublishArtifactsInput,
) => Promise<ProcessPublishArtifactsOutput> | ProcessPublishArtifactsOutput

export function createPublishArtifactProcessor(
  processors: PublishArtifactProcessor[],
): PublishArtifactProcessor {
  return async (input) => {
    let current = input

    for (const processor of processors) {
      current = await processor(current)
    }

    return current
  }
}
