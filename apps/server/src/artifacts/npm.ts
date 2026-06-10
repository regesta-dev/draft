import { processNpmPublishArtifacts } from '@regesta/npm'
import type {
  ProcessPublishArtifactsInput,
  ProcessPublishArtifactsOutput,
} from './process.ts'

export async function processNpmArtifacts(
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
