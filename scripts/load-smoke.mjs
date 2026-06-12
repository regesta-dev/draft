#!/usr/bin/env node
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { createRegestaApp } from '../apps/server/src/app.ts'
import { createLocalRegistryAdapters } from '../packages/adapters/src/index.ts'
import {
  createReleasePublishIntent,
  createWriteAuthorization,
  releasePublishArtifactDescriptorDigest,
} from '../packages/auth/src/index.ts'
import { prepareNpmPublish } from '../packages/cli/src/npm-publish.ts'
import { releasePublishArtifactDescriptors } from '../packages/cli/src/publish-intent.ts'
import { configDigest } from '../packages/core/src/index.ts'
import { sha256 } from '../packages/protocol/src/index.ts'
import {
  assertDurationBudget,
  assertOptionalDurationBudget,
  mapConcurrent,
  resolveLoadSmokeOptions,
  sortedUniqueCategories,
  summarizeDurations,
  summarizeSamplesByCategory,
} from './load-smoke-options.mjs'

process.env.NODE_ENV = process.env.NODE_ENV || 'development'

const {
  maxPublishDurationMs,
  maxPublishP95Ms,
  maxReadDurationMs,
  maxReadP95Ms,
  packageCount,
  profileName,
  publishConcurrency,
  readConcurrency,
  readIterations,
  resultFile,
} = resolveLoadSmokeOptions(process.env)
const runStartedAt = performance.now()
const startedAt = new Date().toISOString()
const temporaryRoot = await mkdtemp(join(tmpdir(), 'regesta-load-smoke-'))
const dataDir = join(temporaryRoot, 'data')
const keyFile = new URL(
  '../apps/server/src/dev/private-key.json',
  import.meta.url,
)

try {
  const adapters = createLocalRegistryAdapters(dataDir)
  const app = createRegestaApp(adapters)
  const key = JSON.parse(await readFile(keyFile, 'utf8'))
  const preparedPublishes = []

  for (let index = 0; index < packageCount; index += 1) {
    const name = `load-smoke-${index}`
    const projectDir = join(temporaryRoot, name)
    await createFixtureProject(projectDir, name)
    preparedPublishes.push(await prepareNpmPublish(projectDir))
  }

  const publishStartedAt = performance.now()
  const published = await mapConcurrent(
    preparedPublishes,
    publishConcurrency,
    (prepared) => publishPreparedRelease(app, prepared, key),
  )
  const publishDurationMs = elapsedMilliseconds(publishStartedAt)
  const publishPackagesPerSecond = ratePerSecond(
    packageCount,
    publishDurationMs,
  )
  const publishLatenciesMs = published.map((publishedRelease) => {
    return publishedRelease.durationMs
  })
  const publishLatencyMs = summarizeDurations(publishLatenciesMs)
  assertDurationBudget('publish', publishDurationMs, maxPublishDurationMs)
  assertOptionalDurationBudget(
    'publish p95',
    publishLatencyMs.p95,
    maxPublishP95Ms,
  )

  const readRequests = readLoadRequests(app, published)
  const readCategories = sortedUniqueCategories(readRequests)
  const readRequestsPerIteration = readRequests.length
  const maxReadRequestConcurrency = readConcurrency * readRequestsPerIteration
  const readStartedAt = performance.now()

  const readLatencySamples = await runReadLoad(
    app,
    readRequests,
    readIterations,
    readConcurrency,
  )
  const readDurationMs = elapsedMilliseconds(readStartedAt)
  const readRequestsTotal = readRequestsPerIteration * readIterations
  const readRequestsPerSecond = ratePerSecond(readRequestsTotal, readDurationMs)
  const readLatencyMs = summarizeDurations(
    readLatencySamples.map((sample) => sample.durationMs),
  )
  assertDurationBudget('read', readDurationMs, maxReadDurationMs)
  assertOptionalDurationBudget('read p95', readLatencyMs.p95, maxReadP95Ms)

  const result = {
    kind: 'regesta.load-smoke',
    startedAt,
    completedAt: new Date().toISOString(),
    totalDurationMs: elapsedMilliseconds(runStartedAt),
    maxPublishDurationMs,
    maxPublishP95Ms,
    maxReadDurationMs,
    maxReadP95Ms,
    packages: packageCount,
    profile: profileName,
    deploymentTarget: 'local-in-process',
    storage: {
      checkpoints: 'filesystem',
      database: 'sqlite',
      objects: 'filesystem',
      queue: 'filesystem-ndjson',
      signer: 'local',
    },
    durability: {
      root: 'temporary-filesystem',
    },
    cache: {
      state: 'warm-after-publish',
    },
    runtime: {
      name: 'node',
      version: process.versions.node,
    },
    publishConcurrency,
    publishDurationMs,
    publishLatencyMs,
    publishPackagesPerSecond,
    readDurationMs,
    readCategories,
    readLatencyMs,
    readLatencyByCategoryMs: summarizeSamplesByCategory(readLatencySamples),
    readRequestsPerSecond,
    readConcurrency,
    readIterations,
    readRequests: readRequestsTotal,
    readRequestsPerIteration,
    maxReadRequestConcurrency,
  }
  const resultJson = JSON.stringify(result, null, 2)

  if (resultFile) {
    await writeFile(resultFile, `${resultJson}\n`)
  }

  console.info(resultJson)
} finally {
  await rm(temporaryRoot, { force: true, recursive: true })
}

async function createFixtureProject(projectDir, name) {
  await mkdir(join(projectDir, 'src'), { recursive: true })
  await writeFile(
    join(projectDir, 'package.json'),
    `${JSON.stringify(
      {
        description: 'Regesta load smoke package.',
        exports: {
          '.': './src/index.js',
        },
        name: `@dev.localhost/${name}`,
        packageManager: 'npm@11.5.0',
        version: '0.0.1',
      },
      null,
      2,
    )}\n`,
  )
  await writeFile(
    join(projectDir, 'regesta.json'),
    `${JSON.stringify(
      {
        description: 'Regesta load smoke package.',
        id: `npm:dev.localhost/${name}`,
        languages: ['javascript'],
        provenance: {
          level: 'source-attached',
        },
        source: {
          include: ['regesta.json', 'package.json', 'src'],
        },
      },
      null,
      2,
    )}\n`,
  )
  await writeFile(
    join(projectDir, 'src', 'index.js'),
    `export const value = ${JSON.stringify(name)}\n`,
  )
}

function createSignedPublishForm(prepared, key) {
  const form = new FormData()
  const timestamp = new Date().toISOString()

  form.set('config', JSON.stringify(prepared.config))
  form.set(
    'authorization',
    JSON.stringify(
      createWriteAuthorization(
        createReleasePublishIntent({
          artifactDescriptorDigest: releasePublishArtifactDescriptorDigest(
            releasePublishArtifactDescriptors(prepared.artifacts),
          ),
          artifactDigests: prepared.artifacts.map((artifact) =>
            sha256(artifact.bytes),
          ),
          configDigest: configDigest(prepared.config),
          nonce: randomUUID(),
          packageId: prepared.config.id,
          sourceDigest: sha256(prepared.source),
          timestamp,
          version: prepared.config.version,
        }),
        key,
      ),
    ),
  )
  form.set(
    'source',
    new Blob([toArrayBuffer(prepared.source)], {
      type: 'application/vnd.regesta.source-archive+tgz',
    }),
    'source.tgz',
  )
  form.set(
    'artifacts',
    JSON.stringify(
      prepared.artifacts.map((artifact, index) => ({
        filename: artifact.filename,
        format: artifact.format,
        mediaType: artifact.mediaType,
        part: `artifact.${index}`,
        role: artifact.role,
      })),
    ),
  )

  for (const [index, artifact] of prepared.artifacts.entries()) {
    form.set(
      `artifact.${index}`,
      new Blob([toArrayBuffer(artifact.bytes)], {
        type: artifact.mediaType,
      }),
      artifact.filename ?? `artifact-${index}.tgz`,
    )
  }

  return form
}

function readLoadRequests(app, published) {
  const commonRequests = [
    {
      assert: async (response) => {
        assertStatus(response, 200)
        assertObjectMatch(await response.json(), {
          object: 'regesta.deployment-info',
          statistics: {
            packages: published.length,
          },
        })
      },
      category: 'root',
      url: '/',
    },
    {
      assert: async (response) => {
        assertStatus(response, 200)
        assertObjectMatch(await response.json(), {
          checks: {
            checkpoints: true,
          },
          kind: 'regesta.readiness',
          ok: true,
        })
      },
      category: 'readiness',
      url: '/ready',
    },
    {
      assert: async (response) => {
        assertStatus(response, 200)
        const page = await response.json()
        if (page.object !== 'regesta.object-inventory') {
          throw new Error('Object inventory page did not include object marker')
        }
        if (!Array.isArray(page.objects) || page.objects.length === 0) {
          throw new Error('Object inventory page did not include objects')
        }
        if (typeof page.objects[0]?.digest !== 'string') {
          throw new TypeError(
            'Object inventory page object did not include a digest',
          )
        }
      },
      category: 'object-inventory',
      url: '/objects?limit=1',
    },
  ]

  return [
    ...commonRequests,
    ...published.flatMap(({ body, prepared }) => {
      const packageId = prepared.config.id
      const packagePath = encodeURIComponent(packageId)
      const version = prepared.config.version
      const name = packageId.split('/').at(-1)
      const eventId = body.event.id
      const eventPath = eventId.replace('sha256:', 'sha256/')
      const manifestDigest = body.manifestDescriptor.digest
      const installArtifact = prepared.artifacts.find((artifact) => {
        return artifact.role === 'install'
      })
      if (!installArtifact) {
        throw new Error(
          `Published package has no install artifact: ${packageId}`,
        )
      }
      const installArtifactDigest = sha256(installArtifact.bytes)
      const installArtifactObjectUrl = `http://registry.test/objects/${installArtifactDigest}`
      const npmBase = `http://npm.registry.test/@dev.localhost/${name}`
      const npmTarballUrl = `${npmBase}/-/${name}-${version}.tgz`

      return [
        {
          assert: async (response) => {
            assertStatus(response, 200)
            assertObjectMatch(await response.json(), {
              channels: {
                latest: version,
              },
              id: packageId,
            })
          },
          category: 'package-state',
          url: `/packages/${packagePath}`,
        },
        {
          assert: async (response) => {
            assertStatus(response, 200)
            assertObjectMatch(await response.json(), {
              event: {
                id: eventId,
              },
              manifest: {
                id: packageId,
                version,
              },
            })
          },
          category: 'channel-release',
          url: `/packages/${packagePath}/channels/latest`,
        },
        {
          assert: async (response) => {
            assertStatus(response, 200)
            assertObjectMatch(await response.json(), {
              event: {
                id: eventId,
              },
              manifest: {
                id: packageId,
                version,
              },
            })
          },
          category: 'release',
          url: `/packages/${packagePath}/releases/${version}`,
        },
        {
          assert: async (response) => {
            assertStatus(response, 200)
            assertObjectMatch(await response.json(), {
              eventType: 'release.published',
              id: eventId,
            })
          },
          category: 'event',
          url: `/events/${eventPath}`,
        },
        {
          assert: async (response) => {
            assertStatus(response, 200)
            const page = await response.json()
            if (!Array.isArray(page.events) || page.events.length === 0) {
              throw new Error('Event log page did not include events')
            }
            if (typeof page.events[0]?.id !== 'string') {
              throw new TypeError('Event log page event did not include an id')
            }
          },
          category: 'event-page',
          url: '/events?limit=1',
        },
        {
          assert: async (response) => {
            assertStatus(response, 200)
            if ((await response.arrayBuffer()).byteLength === 0) {
              throw new Error(`Object response was empty: ${manifestDigest}`)
            }
          },
          category: 'object',
          url: `/objects/${manifestDigest}`,
        },
        {
          assert: async (response) => {
            assertStatus(response, 200)
            assertObjectMatch(await response.json(), {
              'dist-tags': {
                latest: version,
              },
              name: `@dev.localhost/${name}`,
              versions: {
                [version]: {
                  dist: {
                    tarball: npmTarballUrl,
                  },
                },
              },
            })
          },
          category: 'npm-packument',
          url: npmBase,
        },
        {
          assert: async (response) => {
            assertStatus(response, 200)
            const manifest = await response.json()
            assertObjectMatch(manifest, {
              dist: {
                tarball: npmTarballUrl,
              },
              name: `@dev.localhost/${name}`,
              version,
            })

            const objectResponse = await app.request(installArtifactObjectUrl)
            assertStatus(objectResponse, 200)
            if ((await objectResponse.arrayBuffer()).byteLength === 0) {
              throw new Error(
                `npm install artifact object was empty: ${packageId}`,
              )
            }
          },
          category: 'npm-version',
          url: `${npmBase}/latest`,
        },
        {
          assert: (response) => {
            assertStatus(response, 302)
            const location = response.headers.get('location')

            if (location !== installArtifactObjectUrl) {
              throw new Error(
                `Expected npm tarball redirect to ${installArtifactObjectUrl}, got ${location}`,
              )
            }
          },
          category: 'npm-tarball-redirect',
          url: npmTarballUrl,
        },
      ]
    }),
  ]
}

function assertStatus(response, expectedStatus) {
  if (response.status !== expectedStatus) {
    throw new Error(`Expected ${expectedStatus}, got ${response.status}`)
  }
}

async function publishPreparedRelease(app, prepared, key) {
  const startedAt = performance.now()
  const response = await app.request('/releases', {
    body: createSignedPublishForm(prepared, key),
    method: 'POST',
  })

  if (response.status !== 201) {
    throw new Error(
      `Publish returned ${response.status}: ${await response.text()}`,
    )
  }

  return {
    body: await response.json(),
    durationMs: elapsedMilliseconds(startedAt),
    prepared,
  }
}

async function runReadLoad(app, readRequests, readIterations, readConcurrency) {
  const latenciesMs = []

  for (let index = 0; index < readIterations; index += readConcurrency) {
    const batchSize = Math.min(readConcurrency, readIterations - index)
    const batchLatenciesMs = await Promise.all(
      Array.from({ length: batchSize }, () =>
        runReadIteration(app, readRequests),
      ),
    )
    latenciesMs.push(...batchLatenciesMs.flat())
  }

  return latenciesMs
}

function runReadIteration(app, readRequests) {
  return Promise.all(
    readRequests.map(async (readRequest) => {
      const startedAt = performance.now()
      const response = await app.request(readRequest.url)
      await readRequest.assert(response)
      return {
        category: readRequest.category,
        durationMs: elapsedMilliseconds(startedAt),
      }
    }),
  )
}

function assertObjectMatch(value, expected) {
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (
      expectedValue &&
      typeof expectedValue === 'object' &&
      !Array.isArray(expectedValue)
    ) {
      assertObjectMatch(value?.[key], expectedValue)
      continue
    }

    if (Array.isArray(expectedValue)) {
      if (!Array.isArray(value?.[key])) {
        throw new TypeError(`Expected ${key} to be an array`)
      }
      for (const [index, item] of expectedValue.entries()) {
        assertObjectMatch(value[key][index], item)
      }
      continue
    }

    if (value?.[key] !== expectedValue) {
      throw new Error(
        `Expected ${key} to be ${JSON.stringify(
          expectedValue,
        )}, got ${JSON.stringify(value?.[key])}`,
      )
    }
  }
}

function toArrayBuffer(bytes) {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy.buffer
}

function elapsedMilliseconds(startedAt) {
  return Math.round((performance.now() - startedAt) * 100) / 100
}

function ratePerSecond(count, durationMs) {
  if (durationMs <= 0) {
    return count
  }

  return roundMilliseconds((count / durationMs) * 1000)
}

function roundMilliseconds(value) {
  return Math.round(value * 100) / 100
}
