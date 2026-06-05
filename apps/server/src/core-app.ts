import {
  createChannelDeleteIntent,
  createChannelUpdateIntent,
  createReleasePublishIntent,
  readWriteAuthorization,
  verifyWriteAuthorization,
  type WriteAuthorization,
} from '@regesta/auth'
import {
  configDigest,
  deletePackageChannel,
  getPackageState,
  normalizeRegestaConfig,
  publishRelease,
  updatePackageChannel,
  verifyRelease,
  type PublishInput,
} from '@regesta/core'
import { extractNpmArtifactEcosystemMetadata } from '@regesta/npm'
import { assertSha256Digest, sha256 } from '@regesta/protocol'
import { Hono } from 'hono'
import * as v from 'valibot'
import { fetchDevDomainBinding } from './dev-keys.ts'
import { isDevLocalhostEnabled } from './dev-mode.ts'
import {
  nonEmptyStringSchema,
  parseRequestPackageId,
  readBinaryField,
  readJsonBody,
  readJsonField,
  readOptionalTextField,
  RequestValidationError,
  requiredParam,
  validateRequest,
} from './request.ts'
import type { RegistryAdapters } from '@regesta/adapters'

const domainBindingFetch: typeof fetch = (input, init) => {
  if (isDevLocalhostEnabled()) {
    return fetchDevDomainBinding(input, init)
  }

  return fetch(input, init)
}

const artifactPartSchema = v.object({
  filename: v.optional(nonEmptyStringSchema),
  format: v.optional(nonEmptyStringSchema),
  mediaType: v.optional(nonEmptyStringSchema),
  part: nonEmptyStringSchema,
  role: nonEmptyStringSchema,
})
const artifactsSchema = v.array(artifactPartSchema)
const channelBodySchema = v.object({
  authorization: v.looseObject({}),
  version: nonEmptyStringSchema,
})
const deleteChannelBodySchema = v.object({
  authorization: v.looseObject({}),
})
const configSchema = v.looseObject({})
const digestSchema = v.pipe(
  v.string(),
  v.regex(/^sha256:[a-f0-9]{64}$/u, 'Must be a sha256 digest'),
)
const digestPartsSchema = v.object({
  algorithm: v.literal('sha256', 'Only sha256 object digests are supported'),
  hex: v.pipe(
    v.string(),
    v.regex(/^[a-f0-9]{64}$/u, 'Must be a lowercase sha256 hex digest'),
  ),
})

export function createCoreRegistryApp(adapters: RegistryAdapters): Hono {
  const app = new Hono()

  app.get('/health', (context) => {
    return context.json({ ok: true })
  })

  app.get('/favicon.ico', () => {
    return new Response(null, {
      headers: {
        'cache-control': 'public, max-age=86400',
      },
      status: 204,
    })
  })

  app.post('/api/v0/releases', async (context) => {
    const body = await context.req.parseBody()
    const config = await readJsonField(body.config, 'config', configSchema)
    const artifacts = await readArtifacts(body)
    const source = await readBinaryField(body.source, 'source')
    const authorization = await readJsonField(
      body.authorization,
      'authorization',
      configSchema,
    )
    const result = await publishFromRequest(
      {
        artifacts,
        authorization: await verifyPublishAuthorization({
          artifacts,
          authorization: readWriteAuthorization(authorization),
          config,
          source,
        }),
        config,
        createdAt: await readOptionalTextField(body.createdAt),
        source,
      },
      adapters,
    )

    return context.json(result, 201)
  })

  app.get('/api/v0/events', async (context) => {
    return context.json({
      events: await adapters.database.getEventLog(),
      schema: 'regesta.event-log.v0',
    })
  })

  app.get('/api/v0/objects/:digest', async (context) => {
    const digest = assertSha256Digest(
      validateRequest(
        digestSchema,
        context.req.param('digest'),
        'Invalid object digest',
      ),
    )
    const object = await adapters.objects.get(digest)

    if (!object) {
      return context.json({ error: 'Object not found' }, 404)
    }

    return new Response(object.bytes, {
      headers: {
        'content-length': String(object.descriptor.size),
        'content-type': object.descriptor.mediaType,
      },
    })
  })

  app.get('/api/v0/objects/:algorithm/:hex', async (context) => {
    const digestParts = validateRequest(
      digestPartsSchema,
      {
        algorithm: context.req.param('algorithm'),
        hex: context.req.param('hex'),
      },
      'Invalid object digest',
    )
    const digest = assertSha256Digest(
      `${digestParts.algorithm}:${digestParts.hex}`,
    )
    const object = await adapters.objects.get(digest)

    if (!object) {
      return context.json({ error: 'Object not found' }, 404)
    }

    return new Response(object.bytes, {
      headers: {
        'content-length': String(object.descriptor.size),
        'content-type': object.descriptor.mediaType,
      },
    })
  })

  app.get('/api/v0/packages/:packageId', async (context) => {
    const packageId = parseRequestPackageId(context.req.param('packageId'))
    const state = await getPackageState(adapters, packageId)
    if (state.releases.length === 0) {
      return context.json({ error: 'Package not found' }, 404)
    }

    return context.json(state)
  })

  app.get('/api/v0/packages/:packageId/releases/:version', async (context) => {
    const packageId = parseRequestPackageId(context.req.param('packageId'))
    const version = requiredParam(context.req.param('version'), 'version')
    const release = await adapters.database.getRelease(packageId, version)

    if (!release) {
      return context.json({ error: 'Release not found' }, 404)
    }

    return context.json(release)
  })

  app.get('/api/v0/packages/:packageId/channels/:channel', async (context) => {
    const packageId = parseRequestPackageId(context.req.param('packageId'))
    const channel = requiredParam(context.req.param('channel'), 'channel')
    const version = (await adapters.database.getPackageChannels(packageId))[
      channel
    ]

    if (!version) {
      return context.json({ error: 'Channel not found' }, 404)
    }

    const release = await adapters.database.getRelease(packageId, version)

    if (!release) {
      return context.json({ error: 'Release not found' }, 404)
    }

    return context.json(release)
  })

  app.get(
    '/api/v0/packages/:packageId/releases/:version/verification',
    async (context) => {
      const packageId = parseRequestPackageId(context.req.param('packageId'))
      const version = requiredParam(context.req.param('version'), 'version')
      const verification = await verifyRelease(adapters, packageId, version)

      return context.json(verification, verification.ok ? 200 : 422)
    },
  )

  app.put('/api/v0/packages/:packageId/channels/:channel', async (context) => {
    const packageId = parseRequestPackageId(context.req.param('packageId'))
    const channel = requiredParam(context.req.param('channel'), 'channel')
    const body = validateRequest(
      channelBodySchema,
      await readJsonBody(context.req.json()),
      'Invalid channel request body',
    )
    const previousVersion = (
      await adapters.database.getPackageChannels(packageId)
    )[channel]
    const requestAuthorization = readWriteAuthorization(body.authorization)
    const authorization = await verifyWriteAuthorization({
      authorization: requestAuthorization,
      expectedIntent: createChannelUpdateIntent({
        channel,
        nonce: requestAuthorization.payload.nonce,
        packageId,
        ...(previousVersion ? { previousVersion } : {}),
        timestamp: requestAuthorization.payload.timestamp,
        version: body.version,
      }),
      fetchBinding: domainBindingFetch,
    })

    const result = await updatePackageChannel(adapters, {
      authorization,
      channel,
      packageId,
      timestamp: authorization.signedAt,
      version: body.version,
    })

    return context.json({
      channel,
      event: result.event,
      package: packageId,
      ...(result.previousVersion
        ? { previousVersion: result.previousVersion }
        : {}),
      version: body.version,
    })
  })

  app.delete(
    '/api/v0/packages/:packageId/channels/:channel',
    async (context) => {
      const packageId = parseRequestPackageId(context.req.param('packageId'))
      const channel = requiredParam(context.req.param('channel'), 'channel')
      const body = validateRequest(
        deleteChannelBodySchema,
        await readJsonBody(context.req.json()),
        'Invalid channel request body',
      )
      const previousVersion = (
        await adapters.database.getPackageChannels(packageId)
      )[channel]
      const requestAuthorization = readWriteAuthorization(body.authorization)
      const authorization = await verifyWriteAuthorization({
        authorization: requestAuthorization,
        expectedIntent: createChannelDeleteIntent({
          channel,
          nonce: requestAuthorization.payload.nonce,
          packageId,
          ...(previousVersion ? { previousVersion } : {}),
          timestamp: requestAuthorization.payload.timestamp,
        }),
        fetchBinding: domainBindingFetch,
      })
      const result = await deletePackageChannel(adapters, {
        authorization,
        channel,
        packageId,
        timestamp: authorization.signedAt,
      })

      return context.json({
        channel,
        event: result.event,
        package: packageId,
        ...(result.previousVersion
          ? { previousVersion: result.previousVersion }
          : {}),
      })
    },
  )

  return app
}

async function readArtifacts(body: Record<string, File | string | undefined>) {
  const artifacts = await readJsonField(
    body.artifacts,
    'artifacts',
    artifactsSchema,
  )

  return Promise.all(
    artifacts.map(async (artifact) => ({
      bytes: await readBinaryField(body[artifact.part], artifact.part),
      ...(artifact.filename ? { filename: artifact.filename } : {}),
      ...(artifact.format ? { format: artifact.format } : {}),
      mediaType: artifact.mediaType ?? 'application/octet-stream',
      role: artifact.role,
    })),
  )
}

async function publishFromRequest(
  input: PublishInput,
  adapters: RegistryAdapters,
) {
  try {
    const config = normalizeRegestaConfig(input.config)
    const ecosystemMetadata = await extractNpmArtifactEcosystemMetadata(
      config,
      input.artifacts,
    )
    const artifacts = input.artifacts.map((artifact) => ({
      ...artifact,
      ...(artifact.role === 'install' && ecosystemMetadata
        ? { ecosystemMetadata }
        : {}),
    }))

    return await publishRelease(
      {
        ...input,
        artifacts,
        config,
      },
      adapters,
    )
  } catch (error) {
    if (error instanceof TypeError) {
      throw new RequestValidationError(error.message)
    }

    throw error
  }
}

function verifyPublishAuthorization(input: {
  artifacts: Array<{ bytes: Uint8Array }>
  authorization: WriteAuthorization
  config: unknown
  source: Uint8Array
}) {
  const config = normalizeRegestaConfig(input.config)

  return verifyWriteAuthorization({
    authorization: input.authorization,
    expectedIntent: createReleasePublishIntent({
      artifactDigests: input.artifacts.map((artifact) =>
        sha256(artifact.bytes),
      ),
      configDigest: configDigest(config),
      nonce: input.authorization.payload.nonce,
      packageId: config.id,
      sourceDigest: sha256(input.source),
      timestamp: input.authorization.payload.timestamp,
      version: config.version,
    }),
    fetchBinding: domainBindingFetch,
  })
}
