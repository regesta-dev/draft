import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  loadSmokeReadCategories,
  validateLoadSmokeResult,
  validateLoadSmokeResultFile,
} from './validate-load-smoke-result.mjs'

describe('validateLoadSmokeResult', () => {
  it('keeps top-level result fields aligned with the public operations schema', async () => {
    const schema = await readLoadSmokeResultSchema()
    const schemaProperties = Object.keys(schema.properties).toSorted()
    const required = schema.required.toSorted()
    const requiredSet = new Set(required)
    const optional = schemaProperties.filter((property) => {
      return !requiredSet.has(property)
    })

    expect(Object.keys(validLoadSmokeResult()).toSorted()).toEqual(
      schemaProperties,
    )
    expect(optional).toEqual(['maxPublishP95Ms', 'maxReadP95Ms'])
  })

  it('keeps read categories aligned with the public operations schema', async () => {
    await expect(readSchemaReadCategories()).resolves.toEqual(
      loadSmokeReadCategories,
    )
  })

  it('accepts a complete load smoke result', () => {
    const result = validLoadSmokeResult()

    expect(validateLoadSmokeResult(result)).toBe(result)
  })

  it('accepts results without optional p95 budgets', () => {
    const result = validLoadSmokeResult()
    delete result.maxPublishP95Ms
    delete result.maxReadP95Ms

    expect(validateLoadSmokeResult(result)).toBe(result)
  })

  it('rejects unknown top-level fields', () => {
    expect(() =>
      validateLoadSmokeResult({
        ...validLoadSmokeResult(),
        extra: true,
      }),
    ).toThrow('result must not include unknown field: extra')
  })

  it('rejects reordered read categories', () => {
    const result = validLoadSmokeResult()
    result.readCategories = loadSmokeReadCategories.toReversed()

    expect(() => validateLoadSmokeResult(result)).toThrow(
      'readCategories[0] must be "channel-release"',
    )
  })

  it('rejects missing per-category latency summaries', () => {
    const result = validLoadSmokeResult()
    delete result.readLatencyByCategoryMs.root

    expect(() => validateLoadSmokeResult(result)).toThrow(
      'readLatencyByCategoryMs must include field: root',
    )
  })

  it('rejects invalid latency summary values', () => {
    const result = validLoadSmokeResult()
    result.publishLatencyMs.count = 0

    expect(() => validateLoadSmokeResult(result)).toThrow(
      'publishLatencyMs.count must be a positive safe integer',
    )
  })
})

describe('validateLoadSmokeResultFile', () => {
  it('validates a JSON result file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'regesta-load-result-'))
    const resultFile = join(directory, 'result.json')
    const result = validLoadSmokeResult()

    await writeFile(resultFile, `${JSON.stringify(result, null, 2)}\n`)

    await expect(validateLoadSmokeResultFile(resultFile)).resolves.toEqual(
      result,
    )
  })
})

function validLoadSmokeResult() {
  return {
    cache: {
      state: 'warm-after-publish',
    },
    completedAt: '2026-06-12T00:00:01.000Z',
    deploymentTarget: 'local-in-process',
    durability: {
      root: 'temporary-filesystem',
    },
    kind: 'regesta.load-smoke',
    maxPublishDurationMs: 30_000,
    maxPublishP95Ms: 10_000,
    maxReadDurationMs: 30_000,
    maxReadP95Ms: 10_000,
    maxReadRequestConcurrency: 750,
    packages: 3,
    profile: 'smoke',
    publishConcurrency: 3,
    publishDurationMs: 50.5,
    publishLatencyMs: latencySummary(3),
    publishPackagesPerSecond: 59.4,
    readCategories: [...loadSmokeReadCategories],
    readConcurrency: 25,
    readDurationMs: 187.7,
    readIterations: 25,
    readLatencyByCategoryMs: Object.fromEntries(
      loadSmokeReadCategories.map((category) => [category, latencySummary(75)]),
    ),
    readLatencyMs: latencySummary(750),
    readRequests: 750,
    readRequestsPerIteration: 30,
    readRequestsPerSecond: 3995.74,
    runtime: {
      name: 'node',
      version: '24.16.0',
    },
    startedAt: '2026-06-12T00:00:00.000Z',
    storage: {
      checkpoints: 'filesystem',
      database: 'sqlite',
      objects: 'filesystem',
      queue: 'filesystem-ndjson',
      signer: 'local',
    },
    totalDurationMs: 3434.63,
  }
}

function latencySummary(count) {
  return {
    average: 1,
    count,
    max: 3,
    min: 0,
    p50: 1,
    p95: 2,
  }
}

async function readSchemaReadCategories() {
  const schema = await readLoadSmokeResultSchema()
  const prefixItems = schema.properties.readCategories.prefixItems

  return prefixItems.map((item) => item.const)
}

async function readLoadSmokeResultSchema() {
  const text = await readFile(
    new URL(
      '../docs/public/schema/regesta-load-smoke-result.schema.json',
      import.meta.url,
    ),
    'utf8',
  )

  return JSON.parse(text)
}
