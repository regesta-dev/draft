import { readFile } from 'node:fs/promises'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

export const loadSmokeReadCategories = [
  'channel-release',
  'event',
  'event-page',
  'npm-packument',
  'npm-tarball-redirect',
  'npm-version',
  'object',
  'object-inventory',
  'package-state',
  'readiness',
  'release',
  'root',
]

const requiredTopLevelKeys = [
  'cache',
  'completedAt',
  'deploymentTarget',
  'durability',
  'kind',
  'maxPublishDurationMs',
  'maxReadDurationMs',
  'maxReadRequestConcurrency',
  'packages',
  'profile',
  'publishConcurrency',
  'publishDurationMs',
  'publishLatencyMs',
  'publishPackagesPerSecond',
  'readCategories',
  'readConcurrency',
  'readDurationMs',
  'readIterations',
  'readLatencyByCategoryMs',
  'readLatencyMs',
  'readRequests',
  'readRequestsPerIteration',
  'readRequestsPerSecond',
  'runtime',
  'startedAt',
  'storage',
  'totalDurationMs',
]

const optionalTopLevelKeys = ['maxPublishP95Ms', 'maxReadP95Ms']
const latencySummaryKeys = ['average', 'count', 'max', 'min', 'p50', 'p95']

export function validateLoadSmokeResult(value) {
  const issues = []

  if (!isRecord(value)) {
    throwInvalidLoadSmokeResult(['result must be an object'])
  }

  requireOnlyKeys(
    value,
    new Set([...requiredTopLevelKeys, ...optionalTopLevelKeys]),
    'result',
    issues,
  )
  requireKeys(value, requiredTopLevelKeys, 'result', issues)

  requireConst(value.kind, 'regesta.load-smoke', 'kind', issues)
  requireDateTimeString(value.startedAt, 'startedAt', issues)
  requireDateTimeString(value.completedAt, 'completedAt', issues)
  requireNonNegativeNumber(value.totalDurationMs, 'totalDurationMs', issues)
  requirePositiveSafeInteger(
    value.maxPublishDurationMs,
    'maxPublishDurationMs',
    issues,
  )
  requireOptionalPositiveSafeInteger(
    value.maxPublishP95Ms,
    'maxPublishP95Ms',
    issues,
  )
  requirePositiveSafeInteger(
    value.maxReadDurationMs,
    'maxReadDurationMs',
    issues,
  )
  requireOptionalPositiveSafeInteger(value.maxReadP95Ms, 'maxReadP95Ms', issues)
  requirePositiveSafeInteger(value.packages, 'packages', issues)
  requireEnum(value.profile, ['local', 'smoke'], 'profile', issues)
  requireConst(
    value.deploymentTarget,
    'local-in-process',
    'deploymentTarget',
    issues,
  )
  requireStorage(value.storage, issues)
  requireConstObject(
    value.durability,
    {
      root: 'temporary-filesystem',
    },
    'durability',
    issues,
  )
  requireConstObject(
    value.cache,
    {
      state: 'warm-after-publish',
    },
    'cache',
    issues,
  )
  requireRuntime(value.runtime, issues)
  requirePositiveSafeInteger(
    value.publishConcurrency,
    'publishConcurrency',
    issues,
  )
  requireNonNegativeNumber(value.publishDurationMs, 'publishDurationMs', issues)
  requireLatencySummary(value.publishLatencyMs, 'publishLatencyMs', issues)
  requireNonNegativeNumber(
    value.publishPackagesPerSecond,
    'publishPackagesPerSecond',
    issues,
  )
  requireNonNegativeNumber(value.readDurationMs, 'readDurationMs', issues)
  requireReadCategories(value.readCategories, issues)
  requireLatencySummary(value.readLatencyMs, 'readLatencyMs', issues)
  requireLatencyByCategory(value.readLatencyByCategoryMs, issues)
  requireNonNegativeNumber(
    value.readRequestsPerSecond,
    'readRequestsPerSecond',
    issues,
  )
  requirePositiveSafeInteger(value.readConcurrency, 'readConcurrency', issues)
  requirePositiveSafeInteger(value.readIterations, 'readIterations', issues)
  requirePositiveSafeInteger(value.readRequests, 'readRequests', issues)
  requirePositiveSafeInteger(
    value.readRequestsPerIteration,
    'readRequestsPerIteration',
    issues,
  )
  requirePositiveSafeInteger(
    value.maxReadRequestConcurrency,
    'maxReadRequestConcurrency',
    issues,
  )

  if (issues.length > 0) {
    throwInvalidLoadSmokeResult(issues)
  }

  return value
}

export async function validateLoadSmokeResultFile(path) {
  const text = await readFile(path, 'utf8')
  const parsed = JSON.parse(text)

  return validateLoadSmokeResult(parsed)
}

function requireStorage(value, issues) {
  requireConstObject(
    value,
    {
      checkpoints: 'filesystem',
      database: 'sqlite',
      objects: 'filesystem',
      queue: 'filesystem-ndjson',
      signer: 'local',
    },
    'storage',
    issues,
  )
}

function requireRuntime(value, issues) {
  if (!isRecord(value)) {
    issues.push('runtime must be an object')
    return
  }

  requireOnlyKeys(value, new Set(['name', 'version']), 'runtime', issues)
  requireKeys(value, ['name', 'version'], 'runtime', issues)
  requireConst(value.name, 'node', 'runtime.name', issues)
  requireNonEmptyString(value.version, 'runtime.version', issues)
}

function requireLatencySummary(value, label, issues) {
  if (!isRecord(value)) {
    issues.push(`${label} must be an object`)
    return
  }

  requireOnlyKeys(value, new Set(latencySummaryKeys), label, issues)
  requireKeys(value, latencySummaryKeys, label, issues)

  for (const key of latencySummaryKeys) {
    if (key === 'count') {
      requirePositiveSafeInteger(value[key], `${label}.${key}`, issues)
    } else {
      requireNonNegativeNumber(value[key], `${label}.${key}`, issues)
    }
  }
}

function requireLatencyByCategory(value, issues) {
  if (!isRecord(value)) {
    issues.push('readLatencyByCategoryMs must be an object')
    return
  }

  requireOnlyKeys(
    value,
    new Set(loadSmokeReadCategories),
    'readLatencyByCategoryMs',
    issues,
  )
  requireKeys(value, loadSmokeReadCategories, 'readLatencyByCategoryMs', issues)

  for (const category of loadSmokeReadCategories) {
    requireLatencySummary(
      value[category],
      `readLatencyByCategoryMs.${category}`,
      issues,
    )
  }
}

function requireReadCategories(value, issues) {
  if (!Array.isArray(value)) {
    issues.push('readCategories must be an array')
    return
  }

  if (value.length !== loadSmokeReadCategories.length) {
    issues.push(
      `readCategories must contain ${loadSmokeReadCategories.length} categories`,
    )
    return
  }

  for (const [index, category] of loadSmokeReadCategories.entries()) {
    requireConst(value[index], category, `readCategories[${index}]`, issues)
  }
}

function requireConstObject(value, expected, label, issues) {
  if (!isRecord(value)) {
    issues.push(`${label} must be an object`)
    return
  }

  requireOnlyKeys(value, new Set(Object.keys(expected)), label, issues)
  requireKeys(value, Object.keys(expected), label, issues)

  for (const [key, expectedValue] of Object.entries(expected)) {
    requireConst(value[key], expectedValue, `${label}.${key}`, issues)
  }
}

function requireOnlyKeys(value, allowedKeys, label, issues) {
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      issues.push(`${label} must not include unknown field: ${key}`)
    }
  }
}

function requireKeys(value, keys, label, issues) {
  for (const key of keys) {
    if (!(key in value)) {
      issues.push(`${label} must include field: ${key}`)
    }
  }
}

function requireConst(value, expected, label, issues) {
  if (value !== expected) {
    issues.push(`${label} must be ${JSON.stringify(expected)}`)
  }
}

function requireEnum(value, allowedValues, label, issues) {
  if (!allowedValues.includes(value)) {
    issues.push(`${label} must be one of: ${allowedValues.join(', ')}`)
  }
}

function requireDateTimeString(value, label, issues) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    issues.push(`${label} must be an ISO date-time string`)
  }
}

function requireNonEmptyString(value, label, issues) {
  if (typeof value !== 'string' || value.length === 0) {
    issues.push(`${label} must be a non-empty string`)
  }
}

function requireNonNegativeNumber(value, label, issues) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    issues.push(`${label} must be a non-negative number`)
  }
}

function requirePositiveSafeInteger(value, label, issues) {
  if (!Number.isSafeInteger(value) || value < 1) {
    issues.push(`${label} must be a positive safe integer`)
  }
}

function requireOptionalPositiveSafeInteger(value, label, issues) {
  if (value === undefined) {
    return
  }

  requirePositiveSafeInteger(value, label, issues)
}

function throwInvalidLoadSmokeResult(issues) {
  throw new TypeError(
    ['Invalid load smoke result:', ...issues.map((issue) => `- ${issue}`)].join(
      '\n',
    ),
  )
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

if (isMain()) {
  const [, , resultFile] = process.argv

  if (resultFile) {
    try {
      await validateLoadSmokeResultFile(resultFile)
      console.info(`Valid load smoke result: ${resultFile}`)
    } catch (error) {
      console.error(error instanceof Error ? error.message : error)
      process.exitCode = 1
    }
  } else {
    console.error(
      'Usage: node scripts/validate-load-smoke-result.mjs <result-file>',
    )
    process.exitCode = 2
  }
}

function isMain() {
  return import.meta.url === pathToFileURL(process.argv[1] ?? '').href
}
