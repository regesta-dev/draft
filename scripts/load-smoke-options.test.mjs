import { describe, expect, it } from 'vitest'
import {
  assertDurationBudget,
  assertOptionalDurationBudget,
  mapConcurrent,
  readOptionalPositiveSafeIntegerEnv,
  readPositiveSafeIntegerEnv,
  resolveLoadSmokeOptions,
  sortedUniqueCategories,
  summarizeDurations,
  summarizeSamplesByCategory,
} from './load-smoke-options.mjs'

describe('resolveLoadSmokeOptions', () => {
  it('returns smoke profile defaults', () => {
    expect(resolveLoadSmokeOptions({})).toEqual({
      maxPublishDurationMs: 30_000,
      maxPublishP95Ms: undefined,
      maxReadDurationMs: 30_000,
      maxReadP95Ms: undefined,
      packageCount: 3,
      profileName: 'smoke',
      publishConcurrency: 3,
      readConcurrency: 1,
      readIterations: 25,
      resultFile: undefined,
    })
  })

  it('returns local profile defaults', () => {
    expect(
      resolveLoadSmokeOptions({
        REGESTA_LOAD_PROFILE: 'local',
      }),
    ).toEqual({
      maxPublishDurationMs: 120_000,
      maxPublishP95Ms: undefined,
      maxReadDurationMs: 120_000,
      maxReadP95Ms: undefined,
      packageCount: 10,
      profileName: 'local',
      publishConcurrency: 10,
      readConcurrency: 1,
      readIterations: 100,
      resultFile: undefined,
    })
  })

  it('caps configured concurrency to the effective work size', () => {
    expect(
      resolveLoadSmokeOptions({
        REGESTA_LOAD_CONCURRENCY: '99',
        REGESTA_LOAD_PACKAGES: '2',
        REGESTA_LOAD_MAX_PUBLISH_P95_MS: '500',
        REGESTA_LOAD_MAX_READ_P95_MS: '250',
        REGESTA_LOAD_PUBLISH_CONCURRENCY: '99',
        REGESTA_LOAD_READS: '4',
        REGESTA_LOAD_RESULT_FILE: 'load-result.json',
      }),
    ).toMatchObject({
      packageCount: 2,
      maxPublishP95Ms: 500,
      maxReadP95Ms: 250,
      publishConcurrency: 2,
      readConcurrency: 4,
      readIterations: 4,
      resultFile: 'load-result.json',
    })
  })

  it('rejects unknown profiles', () => {
    expect(() =>
      resolveLoadSmokeOptions({
        REGESTA_LOAD_PROFILE: 'production',
      }),
    ).toThrow('REGESTA_LOAD_PROFILE must be one of: local, smoke')
  })

  it('rejects profile names inherited from Object.prototype', () => {
    expect(() =>
      resolveLoadSmokeOptions({
        REGESTA_LOAD_PROFILE: 'toString',
      }),
    ).toThrow('REGESTA_LOAD_PROFILE must be one of: local, smoke')
  })
})

describe('readPositiveSafeIntegerEnv', () => {
  it('uses the default for unset or empty values', () => {
    expect(readPositiveSafeIntegerEnv({}, 'VALUE', 3)).toBe(3)
    expect(readPositiveSafeIntegerEnv({ VALUE: '' }, 'VALUE', 3)).toBe(3)
  })

  it('rejects non-positive, non-decimal, and unsafe values', () => {
    for (const value of ['0', '-1', '1.5', '01', 'Infinity']) {
      expect(() =>
        readPositiveSafeIntegerEnv({ VALUE: value }, 'VALUE', 3),
      ).toThrow('VALUE must be a positive integer')
    }

    expect(() =>
      readPositiveSafeIntegerEnv(
        { VALUE: String(Number.MAX_SAFE_INTEGER + 1) },
        'VALUE',
        3,
      ),
    ).toThrow('VALUE must be a positive safe integer')
  })
})

describe('readOptionalPositiveSafeIntegerEnv', () => {
  it('returns undefined for unset or empty values', () => {
    expect(readOptionalPositiveSafeIntegerEnv({}, 'VALUE')).toBeUndefined()
    expect(
      readOptionalPositiveSafeIntegerEnv({ VALUE: '' }, 'VALUE'),
    ).toBeUndefined()
  })

  it('reads positive safe integer values', () => {
    expect(readOptionalPositiveSafeIntegerEnv({ VALUE: '42' }, 'VALUE')).toBe(
      42,
    )
  })

  it('rejects invalid optional values', () => {
    expect(() =>
      readOptionalPositiveSafeIntegerEnv({ VALUE: '0' }, 'VALUE'),
    ).toThrow('VALUE must be a positive integer')
  })
})

describe('mapConcurrent', () => {
  it('returns an empty result for empty input', async () => {
    await expect(
      mapConcurrent([], 1, () => {
        throw new Error('mapper must not be called')
      }),
    ).resolves.toEqual([])
  })

  it('preserves result order while mapping concurrently', async () => {
    const result = await mapConcurrent([30, 0, 10], 3, async (delay, index) => {
      await wait(delay)
      return `result:${index}`
    })

    expect(result).toEqual(['result:0', 'result:1', 'result:2'])
  })

  it('does not exceed the configured concurrency', async () => {
    let active = 0
    let maxActive = 0
    const result = await mapConcurrent([1, 2, 3, 4, 5], 2, async (value) => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await wait(0)
      active -= 1
      return value * 2
    })

    expect(result).toEqual([2, 4, 6, 8, 10])
    expect(maxActive).toBeLessThanOrEqual(2)
  })

  it('rejects invalid concurrency values', async () => {
    await expect(mapConcurrent([1], 0, (value) => value)).rejects.toThrow(
      'concurrency must be a positive safe integer',
    )
    await expect(
      mapConcurrent([1], Number.MAX_SAFE_INTEGER + 1, (value) => value),
    ).rejects.toThrow('concurrency must be a positive safe integer')
  })
})

describe('assertDurationBudget', () => {
  it('allows durations within the configured budget', () => {
    expect(() => assertDurationBudget('read', 10, 10)).not.toThrow()
  })

  it('rejects durations above the configured budget', () => {
    expect(() => assertDurationBudget('read p95', 11, 10)).toThrow(
      'Load smoke read p95 phase exceeded threshold: 11ms > 10ms',
    )
  })
})

describe('assertOptionalDurationBudget', () => {
  it('skips unset optional budgets', () => {
    expect(() =>
      assertOptionalDurationBudget('publish p95', 99, undefined),
    ).not.toThrow()
  })

  it('enforces configured optional budgets', () => {
    expect(() => assertOptionalDurationBudget('publish p95', 12, 10)).toThrow(
      'Load smoke publish p95 phase exceeded threshold: 12ms > 10ms',
    )
  })
})

describe('summarizeDurations', () => {
  it('summarizes duration samples deterministically', () => {
    expect(summarizeDurations([9, 1, 5, 3, 7])).toEqual({
      average: 5,
      count: 5,
      max: 9,
      min: 1,
      p50: 5,
      p95: 9,
    })
  })

  it('rounds average duration to two decimals', () => {
    expect(summarizeDurations([1, 2, 2])).toMatchObject({
      average: 1.67,
    })
  })

  it('rejects empty duration samples', () => {
    expect(() => summarizeDurations([])).toThrow(
      'Cannot summarize empty duration samples',
    )
  })
})

describe('summarizeSamplesByCategory', () => {
  it('summarizes duration samples by sorted category', () => {
    expect(
      summarizeSamplesByCategory([
        { category: 'readiness', durationMs: 8 },
        { category: 'root', durationMs: 1 },
        { category: 'readiness', durationMs: 4 },
        { category: 'root', durationMs: 3 },
      ]),
    ).toEqual({
      readiness: {
        average: 6,
        count: 2,
        max: 8,
        min: 4,
        p50: 4,
        p95: 8,
      },
      root: {
        average: 2,
        count: 2,
        max: 3,
        min: 1,
        p50: 1,
        p95: 3,
      },
    })
  })
})

describe('sortedUniqueCategories', () => {
  it('returns sorted unique categories', () => {
    expect(
      sortedUniqueCategories([
        { category: 'root' },
        { category: 'npm-packument' },
        { category: 'root' },
        { category: 'event' },
      ]),
    ).toEqual(['event', 'npm-packument', 'root'])
  })
})

function wait(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}
