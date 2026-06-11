import { processNpmArtifacts } from './npm.ts'
import { createPublishArtifactProcessor } from './process.ts'

export function createDefaultPublishArtifactProcessor(): ReturnType<
  typeof createPublishArtifactProcessor
> {
  return createPublishArtifactProcessor([processNpmArtifacts])
}
