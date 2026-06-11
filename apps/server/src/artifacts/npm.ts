import { processNpmPublishArtifacts } from '@regesta/npm'
import type {
  ProcessPublishArtifactsInput,
  ProcessPublishArtifactsOutput,
  PublishArtifactForProcessing,
} from './process.ts'
import type { ArtifactEcosystemMetadata } from '@regesta/protocol'

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

  if (
    input.config.description !== undefined &&
    input.config.description !== npmProcessing.description
  ) {
    throw new TypeError(
      'regesta.json description must match npm package.json description',
    )
  }

  return {
    artifacts: input.artifacts.map((artifact) =>
      artifact.role === 'install'
        ? applyNpmEcosystemMetadata(
            artifact,
            npmProcessing.ecosystemMetadata?.npm,
          )
        : artifact,
    ),
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

function applyNpmEcosystemMetadata(
  artifact: PublishArtifactForProcessing,
  npmMetadata: unknown,
): PublishArtifactForProcessing {
  const { ecosystemMetadata, ...artifactWithoutMetadata } = artifact
  const retainedMetadata = omitNpmEcosystemMetadata(ecosystemMetadata)
  const nextMetadata = {
    ...retainedMetadata,
    ...(npmMetadata === undefined ? {} : { npm: npmMetadata }),
  }

  return Object.keys(nextMetadata).length > 0
    ? {
        ...artifactWithoutMetadata,
        ecosystemMetadata: nextMetadata,
      }
    : artifactWithoutMetadata
}

function omitNpmEcosystemMetadata(
  metadata: ArtifactEcosystemMetadata | undefined,
): ArtifactEcosystemMetadata {
  return Object.fromEntries(
    Object.entries(metadata ?? {}).filter(([key]) => {
      return key !== 'npm'
    }),
  )
}
