import { processNpmPublishArtifacts } from '@regesta/npm'
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

export const processPublishArtifacts = createPublishArtifactProcessor([
  processNpmArtifacts,
])

async function processNpmArtifacts(
  input: ProcessPublishArtifactsInput,
): Promise<ProcessPublishArtifactsOutput> {
  const npmProcessing = await processNpmPublishArtifacts(
    input.config,
    input.artifacts,
  )

  if (!npmProcessing) {
    return input
  }

  return {
    artifacts: input.artifacts.map((artifact) => ({
      ...artifact,
      ...(artifact.role === 'install' && npmProcessing.ecosystemMetadata
        ? {
            ecosystemMetadata: {
              ...artifact.ecosystemMetadata,
              ...npmProcessing.ecosystemMetadata,
            },
          }
        : {}),
    })),
    config:
      input.config.description === undefined &&
      npmProcessing.description !== undefined
        ? {
            ...input.config,
            description: npmProcessing.description,
          }
        : input.config,
  }
}
