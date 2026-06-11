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

process.env.NODE_ENV = process.env.NODE_ENV || 'development'

const loadProfiles = {
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

const profileName = readLoadProfileEnv()
const profile = loadProfiles[profileName]
const packageCount = readPositiveIntegerEnv(
  'REGESTA_LOAD_PACKAGES',
  profile.packageCount,
)
const readIterations = readPositiveIntegerEnv(
  'REGESTA_LOAD_READS',
  profile.readIterations,
)
const maxPublishDurationMs = readPositiveIntegerEnv(
  'REGESTA_LOAD_MAX_PUBLISH_MS',
  profile.maxPublishDurationMs,
)
const maxReadDurationMs = readPositiveIntegerEnv(
  'REGESTA_LOAD_MAX_READ_MS',
  profile.maxReadDurationMs,
)
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
  const published = await Promise.all(
    preparedPublishes.map(async (prepared) => {
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
        prepared,
      }
    }),
  )
  const publishDurationMs = elapsedMilliseconds(publishStartedAt)
  assertDuration('publish', publishDurationMs, maxPublishDurationMs)

  const readRequests = readLoadRequests(app, published)
  const readStartedAt = performance.now()

  for (let index = 0; index < readIterations; index += 1) {
    await Promise.all(
      readRequests.map(async (readRequest) => {
        const response = await app.request(readRequest.url)
        await readRequest.assert(response)
      }),
    )
  }
  const readDurationMs = elapsedMilliseconds(readStartedAt)
  assertDuration('read', readDurationMs, maxReadDurationMs)

  console.info(
    JSON.stringify(
      {
        kind: 'regesta.load-smoke',
        maxPublishDurationMs,
        maxReadDurationMs,
        packages: packageCount,
        profile: profileName,
        publishDurationMs,
        readDurationMs,
        readIterations,
        readRequests: readRequests.length * readIterations,
      },
      null,
      2,
    ),
  )
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
          kind: 'regesta.readiness',
          ok: true,
        })
      },
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
      const npmBase = `http://npm.registry.test/@dev.localhost/${name}`

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
          url: '/events?limit=1',
        },
        {
          assert: async (response) => {
            assertStatus(response, 200)
            if ((await response.arrayBuffer()).byteLength === 0) {
              throw new Error(`Object response was empty: ${manifestDigest}`)
            }
          },
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
            })
          },
          url: npmBase,
        },
        {
          assert: async (response) => {
            assertStatus(response, 200)
            assertObjectMatch(await response.json(), {
              name: `@dev.localhost/${name}`,
              version,
            })
          },
          url: `${npmBase}/latest`,
        },
        {
          assert: async (response) => {
            assertStatus(response, 302)
            const location = response.headers.get('location')
            const expectedLocation = `http://registry.test/objects/${installArtifactDigest}`

            if (location !== expectedLocation) {
              throw new Error(
                `Expected npm tarball redirect to ${expectedLocation}, got ${location}`,
              )
            }

            const objectResponse = await app.request(location)
            assertStatus(objectResponse, 200)
            if ((await objectResponse.arrayBuffer()).byteLength === 0) {
              throw new Error(`npm tarball object was empty: ${packageId}`)
            }
          },
          url: `${npmBase}/-/${name}-${version}.tgz`,
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

function assertDuration(name, actualMs, maxMs) {
  if (actualMs > maxMs) {
    throw new Error(
      `Load smoke ${name} phase exceeded threshold: ${actualMs}ms > ${maxMs}ms`,
    )
  }
}

function readPositiveIntegerEnv(name, defaultValue) {
  const raw = process.env[name]

  if (raw === undefined || raw === '') {
    return defaultValue
  }

  if (!/^[1-9]\d*$/u.test(raw)) {
    throw new TypeError(`${name} must be a positive integer`)
  }

  return Number(raw)
}

function readLoadProfileEnv() {
  const raw = process.env.REGESTA_LOAD_PROFILE ?? 'smoke'

  if (raw in loadProfiles) {
    return raw
  }

  throw new TypeError(
    `REGESTA_LOAD_PROFILE must be one of: ${Object.keys(loadProfiles).join(
      ', ',
    )}`,
  )
}

function toArrayBuffer(bytes) {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy.buffer
}

function elapsedMilliseconds(startedAt) {
  return Math.round((performance.now() - startedAt) * 100) / 100
}
