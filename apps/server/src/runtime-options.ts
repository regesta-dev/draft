export type RuntimeEnvironment = Record<string, string | undefined>

export interface RuntimeDeploymentStatisticsOptions {
  cacheTtlMs?: number
}

export interface RuntimeNpmUpstreamOptions {
  upstreamFallback?: boolean
  upstreamTimeoutMs?: number
}

export interface RuntimePublishUploadLimits {
  artifactBytes?: number
  sourceBytes?: number
}

export interface RuntimeReadinessOptions {
  timeoutMs?: number
}

export interface RuntimeRequestSizeLimitOptions {
  maxBytes?: number
}

export interface RuntimeTrustOptions {
  domainBindingFetchTimeoutMs?: number
}

export interface RuntimeOptions {
  deploymentStatistics?: RuntimeDeploymentStatisticsOptions
  npmArtifactProcessing?: boolean
  npmProjection?: boolean
  npmUpstream?: RuntimeNpmUpstreamOptions
  publishUploadLimits?: RuntimePublishUploadLimits
  readiness?: RuntimeReadinessOptions
  requestSizeLimit?: RuntimeRequestSizeLimitOptions
  trust?: RuntimeTrustOptions
}

const nonNegativeIntegerPattern = /^(?:0|[1-9]\d*)$/
const positiveIntegerPattern = /^[1-9]\d*$/

export function runtimeOptionsFromEnv(env: RuntimeEnvironment): RuntimeOptions {
  return {
    deploymentStatistics: readDeploymentStatisticsOptions(env),
    npmArtifactProcessing: readOptionalBoolean(
      env.REGESTA_NPM_ARTIFACT_PROCESSING,
      'REGESTA_NPM_ARTIFACT_PROCESSING',
    ),
    npmProjection: readOptionalBoolean(
      env.REGESTA_NPM_PROJECTION,
      'REGESTA_NPM_PROJECTION',
    ),
    npmUpstream: readNpmUpstreamOptions(env),
    publishUploadLimits: readPublishUploadLimits(env),
    readiness: readReadinessOptions(env),
    requestSizeLimit: readRequestSizeLimit(env),
    trust: readTrustOptions(env),
  }
}

function readTrustOptions(
  env: RuntimeEnvironment,
): RuntimeTrustOptions | undefined {
  const domainBindingFetchTimeoutMs = readOptionalNonNegativeInteger(
    env.REGESTA_DOMAIN_BINDING_TIMEOUT_MS,
    'REGESTA_DOMAIN_BINDING_TIMEOUT_MS',
  )

  return domainBindingFetchTimeoutMs === undefined
    ? undefined
    : { domainBindingFetchTimeoutMs }
}

function readPublishUploadLimits(
  env: RuntimeEnvironment,
): RuntimePublishUploadLimits | undefined {
  const limits = {
    artifactBytes: readOptionalNonNegativeInteger(
      env.REGESTA_MAX_PUBLISH_ARTIFACT_BYTES,
      'REGESTA_MAX_PUBLISH_ARTIFACT_BYTES',
    ),
    sourceBytes: readOptionalNonNegativeInteger(
      env.REGESTA_MAX_PUBLISH_SOURCE_BYTES,
      'REGESTA_MAX_PUBLISH_SOURCE_BYTES',
    ),
  }

  return limits.artifactBytes === undefined && limits.sourceBytes === undefined
    ? undefined
    : limits
}

function readRequestSizeLimit(
  env: RuntimeEnvironment,
): RuntimeRequestSizeLimitOptions | undefined {
  const maxBytes = readOptionalNonNegativeInteger(
    env.REGESTA_MAX_REQUEST_BYTES,
    'REGESTA_MAX_REQUEST_BYTES',
  )

  return maxBytes === undefined ? undefined : { maxBytes }
}

function readDeploymentStatisticsOptions(
  env: RuntimeEnvironment,
): RuntimeDeploymentStatisticsOptions | undefined {
  const cacheTtlMs = readOptionalNonNegativeInteger(
    env.REGESTA_STATISTICS_CACHE_TTL_MS,
    'REGESTA_STATISTICS_CACHE_TTL_MS',
  )

  return cacheTtlMs === undefined ? undefined : { cacheTtlMs }
}

function readNpmUpstreamOptions(
  env: RuntimeEnvironment,
): RuntimeNpmUpstreamOptions | undefined {
  const upstreamFallback = readOptionalBoolean(
    env.REGESTA_NPM_UPSTREAM_FALLBACK,
    'REGESTA_NPM_UPSTREAM_FALLBACK',
  )
  const upstreamTimeoutMs = readOptionalNonNegativeInteger(
    env.REGESTA_NPM_UPSTREAM_TIMEOUT_MS,
    'REGESTA_NPM_UPSTREAM_TIMEOUT_MS',
  )

  return upstreamFallback === undefined && upstreamTimeoutMs === undefined
    ? undefined
    : {
        ...(upstreamFallback === undefined ? {} : { upstreamFallback }),
        ...(upstreamTimeoutMs === undefined ? {} : { upstreamTimeoutMs }),
      }
}

function readReadinessOptions(
  env: RuntimeEnvironment,
): RuntimeReadinessOptions | undefined {
  const timeoutMs = readOptionalPositiveInteger(
    env.REGESTA_READINESS_TIMEOUT_MS,
    'REGESTA_READINESS_TIMEOUT_MS',
  )

  return timeoutMs === undefined ? undefined : { timeoutMs }
}

function readOptionalNonNegativeInteger(
  value: string | undefined,
  name: string,
): number | undefined {
  if (value === undefined || value.length === 0) {
    return undefined
  }

  if (!nonNegativeIntegerPattern.test(value)) {
    throw new TypeError(`${name} must be a non-negative safe integer`)
  }

  return safeIntegerFromDecimal(value, name, 'non-negative safe integer')
}

function readOptionalPositiveInteger(
  value: string | undefined,
  name: string,
): number | undefined {
  if (value === undefined || value.length === 0) {
    return undefined
  }

  if (!positiveIntegerPattern.test(value)) {
    throw new TypeError(`${name} must be a positive safe integer`)
  }

  return safeIntegerFromDecimal(value, name, 'positive safe integer')
}

function readOptionalBoolean(
  value: string | undefined,
  name: string,
): boolean | undefined {
  if (value === undefined || value.length === 0) {
    return undefined
  }

  if (value === 'true') {
    return true
  }

  if (value === 'false') {
    return false
  }

  throw new TypeError(`${name} must be a boolean value: true or false`)
}

function safeIntegerFromDecimal(
  value: string,
  name: string,
  expectation: string,
): number {
  const limit = Number(value)

  if (!Number.isSafeInteger(limit)) {
    throw new TypeError(`${name} must be a ${expectation}`)
  }

  return limit
}
