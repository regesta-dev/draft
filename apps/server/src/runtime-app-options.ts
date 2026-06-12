import {
  createPublishArtifactProcessor,
  type RegestaAppOptions,
} from './app.ts'
import type { RuntimeOptions } from './runtime-options.ts'

export function regestaAppOptionsFromRuntimeOptions(
  runtimeOptions: RuntimeOptions,
): RegestaAppOptions {
  const { npmArtifactProcessing, ...appOptions } = runtimeOptions

  return {
    ...appOptions,
    ...(npmArtifactProcessing === false
      ? { processPublishArtifacts: createPublishArtifactProcessor([]) }
      : {}),
  }
}
