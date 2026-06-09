import process from 'node:process'
import { createLocalRegistryAdapters } from '@regesta/adapters'
import { createRegestaApp } from './src/app.ts'
import type { PublishUploadLimits } from './src/core/app.ts'
import type { RequestSizeLimitOptions } from './src/transport/request-size.ts'
import type { Hono } from 'hono'

const dataDir = process.env.REGESTA_DATA_DIR ?? '.regesta-data'
const app: Hono = createRegestaApp(createLocalRegistryAdapters(dataDir), {
  auditLog: (entry) => {
    console.info(JSON.stringify(entry))
  },
  publishUploadLimits: readPublishUploadLimits(process.env),
  requestSizeLimit: readRequestSizeLimit(process.env),
  requestLog: (entry) => {
    console.info(JSON.stringify(entry))
  },
})

// eslint-disable-next-line import/no-default-export
export default app

function readPublishUploadLimits(
  env: NodeJS.ProcessEnv,
): PublishUploadLimits | undefined {
  const limits = {
    artifactBytes: readOptionalByteLimit(
      env.REGESTA_MAX_PUBLISH_ARTIFACT_BYTES,
      'REGESTA_MAX_PUBLISH_ARTIFACT_BYTES',
    ),
    sourceBytes: readOptionalByteLimit(
      env.REGESTA_MAX_PUBLISH_SOURCE_BYTES,
      'REGESTA_MAX_PUBLISH_SOURCE_BYTES',
    ),
  }

  return limits.artifactBytes === undefined && limits.sourceBytes === undefined
    ? undefined
    : limits
}

function readRequestSizeLimit(
  env: NodeJS.ProcessEnv,
): RequestSizeLimitOptions | undefined {
  const maxBytes = readOptionalByteLimit(
    env.REGESTA_MAX_REQUEST_BYTES,
    'REGESTA_MAX_REQUEST_BYTES',
  )

  return maxBytes === undefined ? undefined : { maxBytes }
}

function readOptionalByteLimit(
  value: string | undefined,
  name: string,
): number | undefined {
  if (value === undefined || value.length === 0) {
    return undefined
  }

  const limit = Number(value)

  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`)
  }

  return limit
}
