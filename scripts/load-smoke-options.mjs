import process from 'node:process'

export const loadProfiles = {
  local: {
    maxPublishDurationMs: 120_000,
    maxReadDurationMs: 120_000,
    packageCount: 10,
    readIterations: 100,
  },
  smoke: {
    maxPublishDurationMs: 30_000,
    maxReadDurationMs: 30_000,
    packageCount: 3,
    readIterations: 25,
  },
}

export function resolveLoadSmokeOptions(env = process.env) {
  const profileName = readLoadProfileEnv(env)
  const profile = loadProfiles[profileName]
  const packageCount = readPositiveSafeIntegerEnv(
    env,
    'REGESTA_LOAD_PACKAGES',
    profile.packageCount,
  )
  const requestedPublishConcurrency = readPositiveSafeIntegerEnv(
    env,
    'REGESTA_LOAD_PUBLISH_CONCURRENCY',
    packageCount,
  )
  const readIterations = readPositiveSafeIntegerEnv(
    env,
    'REGESTA_LOAD_READS',
    profile.readIterations,
  )
  const requestedReadConcurrency = readPositiveSafeIntegerEnv(
    env,
    'REGESTA_LOAD_CONCURRENCY',
    1,
  )

  return {
    maxPublishDurationMs: readPositiveSafeIntegerEnv(
      env,
      'REGESTA_LOAD_MAX_PUBLISH_MS',
      profile.maxPublishDurationMs,
    ),
    maxPublishP95Ms: readOptionalPositiveSafeIntegerEnv(
      env,
      'REGESTA_LOAD_MAX_PUBLISH_P95_MS',
    ),
    maxReadDurationMs: readPositiveSafeIntegerEnv(
      env,
      'REGESTA_LOAD_MAX_READ_MS',
      profile.maxReadDurationMs,
    ),
    maxReadP95Ms: readOptionalPositiveSafeIntegerEnv(
      env,
      'REGESTA_LOAD_MAX_READ_P95_MS',
    ),
    packageCount,
    profileName,
    publishConcurrency: Math.min(requestedPublishConcurrency, packageCount),
    readConcurrency: Math.min(requestedReadConcurrency, readIterations),
    readIterations,
    resultFile: readOptionalStringEnv(env, 'REGESTA_LOAD_RESULT_FILE'),
  }
}

export async function mapConcurrent(items, concurrency, mapper) {
  assertPositiveSafeInteger(concurrency, 'concurrency')

  const results = Array.from({ length: items.length })
  let nextIndex = 0

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex
        nextIndex += 1
        results[index] = await mapper(items[index], index)
      }
    }),
  )

  return results
}

export function assertDurationBudget(name, actualMs, maxMs) {
  if (actualMs > maxMs) {
    throw new Error(
      `Load smoke ${name} phase exceeded threshold: ${actualMs}ms > ${maxMs}ms`,
    )
  }
}

export function assertOptionalDurationBudget(name, actualMs, maxMs) {
  if (maxMs === undefined) {
    return
  }

  assertDurationBudget(name, actualMs, maxMs)
}

export function readPositiveSafeIntegerEnv(env, name, defaultValue) {
  const raw = env[name]

  if (raw === undefined || raw === '') {
    return defaultValue
  }

  return parsePositiveSafeInteger(raw, name)
}

export function readOptionalPositiveSafeIntegerEnv(env, name) {
  const raw = env[name]

  if (raw === undefined || raw === '') {
    return
  }

  return parsePositiveSafeInteger(raw, name)
}

export function readOptionalStringEnv(env, name) {
  const raw = env[name]

  if (raw === undefined || raw === '') {
    return
  }

  return raw
}

export function summarizeDurations(durationsMs) {
  if (durationsMs.length === 0) {
    throw new Error('Cannot summarize empty duration samples')
  }

  const sortedDurationsMs = durationsMs.toSorted((left, right) => left - right)
  const totalMs = durationsMs.reduce((total, duration) => total + duration, 0)

  return {
    average: roundMilliseconds(totalMs / durationsMs.length),
    count: durationsMs.length,
    max: sortedDurationsMs.at(-1),
    min: sortedDurationsMs[0],
    p50: percentile(sortedDurationsMs, 0.5),
    p95: percentile(sortedDurationsMs, 0.95),
  }
}

export function summarizeSamplesByCategory(samples) {
  const durationsByCategory = new Map()

  for (const sample of samples) {
    const durationsMs = durationsByCategory.get(sample.category) ?? []
    durationsMs.push(sample.durationMs)
    durationsByCategory.set(sample.category, durationsMs)
  }

  return Object.fromEntries(
    [...durationsByCategory.entries()]
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([category, durationsMs]) => [
        category,
        summarizeDurations(durationsMs),
      ]),
  )
}

export function sortedUniqueCategories(items) {
  return [...new Set(items.map((item) => item.category))].toSorted(
    (left, right) => left.localeCompare(right),
  )
}

function assertPositiveSafeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive safe integer`)
  }
}

function parsePositiveSafeInteger(raw, name) {
  if (!/^[1-9]\d*$/u.test(raw)) {
    throw new TypeError(`${name} must be a positive integer`)
  }

  const value = Number(raw)

  assertPositiveSafeInteger(value, name)

  return value
}

function readLoadProfileEnv(env) {
  const raw = env.REGESTA_LOAD_PROFILE ?? 'smoke'

  if (Object.prototype.hasOwnProperty.call(loadProfiles, raw)) {
    return raw
  }

  throw new TypeError(
    `REGESTA_LOAD_PROFILE must be one of: ${Object.keys(loadProfiles).join(
      ', ',
    )}`,
  )
}

function percentile(sortedValues, percentileValue) {
  const index = Math.min(
    sortedValues.length - 1,
    Math.ceil(sortedValues.length * percentileValue) - 1,
  )
  return sortedValues[index]
}

function roundMilliseconds(value) {
  return Math.round(value * 100) / 100
}
