import {
  configDigest,
  deletePackageChannel,
  getPackageChannelVersion,
  normalizeRegestaConfig,
  parseStoredRelease,
  publishRelease,
  updatePackageChannel,
  verifyRelease,
  type ObjectDescriptorListOptions,
  type PackageEventHead,
  type PublishInput,
  type RegistryAdapters,
  type StoredRelease,
} from '@regesta/core'
import {
  assertArtifactDescriptorString,
  assertObjectMediaType,
  assertPackageChannel,
  assertPackageVersion,
  assertSha256Digest,
  canonicalJson,
  defaultPackageChannel,
  parseObjectDescriptor,
  parsePackageId,
  parsePackageState,
  parseRegistryEvent,
  sha256,
  type ObjectDescriptor,
  type PackageId,
  type PackageState,
  type RegestaConfig,
  type RegistryEvent,
  type Sha256Digest,
  type WriteAuthorizationProof,
} from '@regesta/protocol'
import { Hono, type Context } from 'hono'
import * as v from 'valibot'
import { assertObjectResponseIntegrity } from '../object-integrity.ts'
import {
  nonEmptyStringSchema,
  publicRequestUrl,
  readBinaryField,
  readFormBody,
  readJsonBody,
  readJsonField,
  readOptionalTextField,
  RequestValidationError,
  requiredParam,
  validateRequest,
} from '../request.ts'
import {
  errorResponse,
  httpDate,
  immutableBytesResponse,
  immutableDescriptorHeaders,
  immutableDescriptorResponse,
  matchesIfModifiedSince,
  matchesIfNoneMatch,
  parseSingleByteRange,
} from '../responses.ts'

export interface CoreRegistryServices {
  processPublishArtifacts?: PublishArtifactProcessor
  readWriteAuthorization: ReadWriteAuthorization
  verifyChannelDeleteAuthorization: VerifyChannelDeleteAuthorization
  verifyChannelUpdateAuthorization: VerifyChannelUpdateAuthorization
  verifyPublishAuthorization: VerifyPublishAuthorization
}

export interface CoreRegistryOptions {
  auditLog?: CoreRegistryAuditSink
  publishUploadLimits?: PublishUploadLimits
}

export type CoreRegistryWriteAction =
  | 'channel.delete'
  | 'channel.update'
  | 'release.publish'

export type CoreRegistryAuditEntry =
  | CoreRegistryAcceptedAuditEntry
  | CoreRegistryRejectedAuditEntry

export interface CoreRegistryAcceptedAuditEntry {
  action: CoreRegistryWriteAction
  channel: string
  eventId: Sha256Digest
  eventType: RegistryEvent['eventType']
  kind: 'regesta.core-audit'
  outcome: 'accepted'
  package: PackageId
  previousVersion?: string
  requestId?: string
  timestamp: string
  version?: string
}

export interface CoreRegistryRejectedAuditEntry {
  action: CoreRegistryWriteAction
  channel?: string
  kind: 'regesta.core-audit'
  observedAt: string
  outcome: 'rejected'
  package: PackageId
  previousVersion?: string
  reason: string
  requestId?: string
  version?: string
}

export type CoreRegistryAuditSink = (
  entry: CoreRegistryAuditEntry,
) => Promise<void> | void

export interface PublishUploadLimits {
  artifactBytes?: number
  sourceBytes?: number
}

interface NormalizedPublishUploadLimits {
  artifactBytes: number | undefined
  sourceBytes: number | undefined
}

export interface ProcessPublishArtifactsInput {
  artifacts: PublishInput['artifacts']
  config: RegestaConfig
}

export interface ProcessPublishArtifactsOutput {
  artifacts: PublishInput['artifacts']
  config: RegestaConfig
}

export type PublishArtifactProcessor = (
  input: ProcessPublishArtifactsInput,
) => Promise<ProcessPublishArtifactsOutput> | ProcessPublishArtifactsOutput

export type ReadWriteAuthorization = (authorization: unknown) => unknown

export interface VerifyPublishAuthorizationInput {
  artifacts: Array<{
    bytes: Uint8Array
    compatibility?: PublishInput['artifacts'][number]['compatibility']
    filename?: string
    format?: string
    mediaType: string
    role: string
  }>
  authorization: unknown
  configDigest: Sha256Digest
  packageId: PackageId
  requestUrl: string
  source: Uint8Array
  version: string
}

export interface VerifyChannelUpdateAuthorizationInput {
  authorization: unknown
  channel: string
  packageId: PackageId
  previousVersion?: string
  requestUrl: string
  version: string
}

export interface VerifyChannelDeleteAuthorizationInput {
  authorization: unknown
  channel: string
  packageId: PackageId
  previousVersion?: string
  requestUrl: string
}

export type VerifyPublishAuthorization = (
  input: VerifyPublishAuthorizationInput,
) => Promise<WriteAuthorizationProof>

export type VerifyChannelUpdateAuthorization = (
  input: VerifyChannelUpdateAuthorizationInput,
) => Promise<WriteAuthorizationProof>

export type VerifyChannelDeleteAuthorization = (
  input: VerifyChannelDeleteAuthorizationInput,
) => Promise<WriteAuthorizationProof>

const stringArraySchema = v.array(nonEmptyStringSchema)
const abiCompatibilitySchema = v.strictObject({
  name: nonEmptyStringSchema,
  versions: v.optional(stringArraySchema),
})
const platformCompatibilitySchema = v.strictObject({
  arch: v.optional(stringArraySchema),
  libc: v.optional(stringArraySchema),
  os: v.optional(stringArraySchema),
})
const runtimeCompatibilitySchema = v.union([
  nonEmptyStringSchema,
  v.strictObject({
    conditions: v.optional(stringArraySchema),
    name: nonEmptyStringSchema,
    versions: v.optional(nonEmptyStringSchema),
  }),
])
const compatibilitySchema = v.strictObject({
  abi: v.optional(v.array(abiCompatibilitySchema)),
  modules: v.optional(stringArraySchema),
  platforms: v.optional(v.array(platformCompatibilitySchema)),
  runtimes: v.optional(v.array(runtimeCompatibilitySchema)),
})
const artifactPartSchema = v.strictObject({
  compatibility: v.optional(compatibilitySchema),
  filename: v.optional(nonEmptyStringSchema),
  format: v.optional(nonEmptyStringSchema),
  mediaType: nonEmptyStringSchema,
  part: nonEmptyStringSchema,
  role: nonEmptyStringSchema,
})
const artifactsSchema = v.array(artifactPartSchema)
const authorizationSchema = v.looseObject({})
const channelBodySchema = v.strictObject({
  authorization: authorizationSchema,
  version: nonEmptyStringSchema,
})
const deleteChannelBodySchema = v.strictObject({
  authorization: authorizationSchema,
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
const eventListQuerySchema = v.object({
  after: v.optional(digestSchema),
  limit: v.optional(
    v.pipe(
      v.string(),
      v.regex(/^[1-9]\d{0,2}$/u, 'Must be an integer from 1 to 999'),
    ),
  ),
})
const defaultEventLogPageLimit = 999
const defaultObjectInventoryPageLimit = 999

export function createCoreRegistryApp(
  adapters: RegistryAdapters,
  services: CoreRegistryServices,
  options: CoreRegistryOptions = {},
): Hono {
  const app = new Hono()
  const uploadLimits = normalizePublishUploadLimits(options.publishUploadLimits)

  app.post('/releases', async (context) => {
    const body = await readFormBody(context.req.parseBody())
    const config = await readJsonField(body.config, 'config', configSchema)
    const artifacts = await readArtifacts(body, uploadLimits)
    const source = await readBinaryField(body.source, 'source', {
      maxBytes: uploadLimits.sourceBytes,
    })
    const authorization = await readJsonField(
      body.authorization,
      'authorization',
      authorizationSchema,
    )
    const normalizedConfig = normalizeRegestaConfig(config)
    const createdAt = await readOptionalTextField(body.createdAt)
    let result: Awaited<ReturnType<typeof publishFromRequest>>

    try {
      result = await publishFromRequest(
        {
          artifacts,
          authorization,
          config: normalizedConfig,
          createdAt,
          requestUrl: publicRequestUrl(
            context.req.url,
            context.req.header('host'),
          ).href,
          source,
        },
        adapters,
        services,
      )
    } catch (error) {
      writeCoreAuditLog(
        options.auditLog,
        rejectedCoreWriteAuditEntry(error, {
          action: 'release.publish',
          channel: defaultPackageChannel,
          package: normalizedConfig.id,
          ...auditRequestFields(context),
          version: normalizedConfig.version,
        }),
      )
      throw error
    }

    writeCoreAuditLog(options.auditLog, {
      action: 'release.publish',
      channel: result.channel,
      eventId: result.event.id,
      eventType: result.event.eventType,
      kind: 'regesta.core-audit',
      outcome: 'accepted',
      package: result.manifest.id,
      ...auditRequestFields(context),
      timestamp: result.event.timestamp,
      version: result.manifest.version,
    })

    return context.json(result, 201)
  })

  app.get('/events', (context) => {
    return serveEventLogRequest(context, adapters)
  })

  app.on('HEAD', '/events', (context) => {
    return serveEventLogRequest(context, adapters)
  })

  app.get('/events/:algorithm/:hex', (context) => {
    return serveEventRequest(context, adapters)
  })

  app.on('HEAD', '/events/:algorithm/:hex', (context) => {
    return serveEventRequest(context, adapters)
  })

  app.get('/objects', (context) => {
    return serveObjectInventoryRequest(context, adapters)
  })

  app.on('HEAD', '/objects', (context) => {
    return serveObjectInventoryRequest(context, adapters)
  })

  app.get('/objects/:digest', (context) => {
    const digest = assertSha256Digest(
      validateRequest(
        digestSchema,
        context.req.param('digest'),
        'Invalid object digest',
      ),
    )
    return serveObject(context, adapters, digest, true)
  })

  app.on('HEAD', '/objects/:digest', (context) => {
    const digest = assertSha256Digest(
      validateRequest(
        digestSchema,
        context.req.param('digest'),
        'Invalid object digest',
      ),
    )

    return serveObject(context, adapters, digest, false)
  })

  app.get('/objects/:algorithm/:hex', (context) => {
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
    return serveObject(context, adapters, digest, true)
  })

  app.on('HEAD', '/objects/:algorithm/:hex', (context) => {
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

    return serveObject(context, adapters, digest, false)
  })

  app.get('/packages/:packageId', (context) => {
    return servePackageStateRequest(context, adapters)
  })

  app.on('HEAD', '/packages/:packageId', (context) => {
    return servePackageStateRequest(context, adapters)
  })

  app.get('/packages/:packageId/releases/:version', (context) => {
    return serveReleaseEnvelopeRequest(context, adapters)
  })

  app.on('HEAD', '/packages/:packageId/releases/:version', (context) => {
    return serveReleaseEnvelopeRequest(context, adapters)
  })

  app.get('/packages/:packageId/channels/:channel', (context) => {
    return servePackageChannelRequest(context, adapters)
  })

  app.on('HEAD', '/packages/:packageId/channels/:channel', (context) => {
    return servePackageChannelRequest(context, adapters)
  })

  app.get(
    '/packages/:packageId/releases/:version/verification',
    async (context) => {
      const packageId = parseRequestPackageId(context.req.param('packageId'))
      const version = parseRequestVersion(context.req.param('version'))
      const verification = await verifyRelease(adapters, packageId, version)

      return serveJson(
        context,
        verification,
        {
          'cache-control': 'no-cache',
          'content-type': 'application/json; charset=UTF-8',
        },
        {
          status: verification.ok ? 200 : 422,
        },
      )
    },
  )

  app.put('/packages/:packageId/channels/:channel', async (context) => {
    const packageId = parseRequestPackageId(context.req.param('packageId'))
    const channel = parseRequestChannel(context.req.param('channel'))
    const body = validateRequest(
      channelBodySchema,
      await readJsonBody(context.req.json()),
      'Invalid channel request body',
    )
    const version = parseRequestVersion(body.version)
    let previousVersion: string | undefined
    let result: Awaited<ReturnType<typeof updatePackageChannel>>

    try {
      services.readWriteAuthorization(body.authorization)
      previousVersion = await getPackageChannelVersion(
        adapters,
        packageId,
        channel,
      )
      const authorization = await services.verifyChannelUpdateAuthorization({
        authorization: body.authorization,
        channel,
        packageId,
        ...(previousVersion === undefined ? {} : { previousVersion }),
        requestUrl: publicRequestUrl(
          context.req.url,
          context.req.header('host'),
        ).href,
        version,
      })

      result = await updatePackageChannel(adapters, {
        authorization,
        channel,
        packageId,
        previousVersion,
        timestamp: authorization.signedAt,
        version,
      })
    } catch (error) {
      writeCoreAuditLog(
        options.auditLog,
        rejectedCoreWriteAuditEntry(error, {
          action: 'channel.update',
          channel,
          package: packageId,
          ...(previousVersion === undefined ? {} : { previousVersion }),
          ...auditRequestFields(context),
          version,
        }),
      )
      throw error
    }

    writeCoreAuditLog(options.auditLog, {
      action: 'channel.update',
      channel,
      eventId: result.event.id,
      eventType: result.event.eventType,
      kind: 'regesta.core-audit',
      outcome: 'accepted',
      package: packageId,
      ...(result.previousVersion === undefined
        ? {}
        : { previousVersion: result.previousVersion }),
      ...auditRequestFields(context),
      timestamp: result.event.timestamp,
      version,
    })

    return context.json({
      channel,
      event: result.event,
      package: packageId,
      ...(result.previousVersion === undefined
        ? {}
        : { previousVersion: result.previousVersion }),
      version,
    })
  })

  app.delete('/packages/:packageId/channels/:channel', async (context) => {
    const packageId = parseRequestPackageId(context.req.param('packageId'))
    const channel = parseRequestChannel(context.req.param('channel'))
    const body = validateRequest(
      deleteChannelBodySchema,
      await readJsonBody(context.req.json()),
      'Invalid channel request body',
    )
    let previousVersion: string | undefined
    let result: Awaited<ReturnType<typeof deletePackageChannel>>

    try {
      services.readWriteAuthorization(body.authorization)
      previousVersion = await getPackageChannelVersion(
        adapters,
        packageId,
        channel,
      )
      const authorization = await services.verifyChannelDeleteAuthorization({
        authorization: body.authorization,
        channel,
        packageId,
        ...(previousVersion === undefined ? {} : { previousVersion }),
        requestUrl: publicRequestUrl(
          context.req.url,
          context.req.header('host'),
        ).href,
      })
      result = await deletePackageChannel(adapters, {
        authorization,
        channel,
        packageId,
        previousVersion,
        timestamp: authorization.signedAt,
      })
    } catch (error) {
      writeCoreAuditLog(
        options.auditLog,
        rejectedCoreWriteAuditEntry(error, {
          action: 'channel.delete',
          channel,
          package: packageId,
          ...(previousVersion === undefined ? {} : { previousVersion }),
          ...auditRequestFields(context),
        }),
      )
      throw error
    }

    writeCoreAuditLog(options.auditLog, {
      action: 'channel.delete',
      channel,
      eventId: result.event.id,
      eventType: result.event.eventType,
      kind: 'regesta.core-audit',
      outcome: 'accepted',
      package: packageId,
      ...(result.previousVersion === undefined
        ? {}
        : { previousVersion: result.previousVersion }),
      ...auditRequestFields(context),
      timestamp: result.event.timestamp,
    })

    return context.json({
      channel,
      event: result.event,
      package: packageId,
      ...(result.previousVersion === undefined
        ? {}
        : { previousVersion: result.previousVersion }),
    })
  })

  return app
}

async function serveEventLogRequest(
  context: Context,
  adapters: RegistryAdapters,
): Promise<Response> {
  const query = validateRequest(
    eventListQuerySchema,
    {
      after: context.req.query('after'),
      limit: context.req.query('limit'),
    },
    'Invalid event log query',
  )
  const limit = query.limit ? Number(query.limit) : defaultEventLogPageLimit
  const after = query.after ? assertSha256Digest(query.after) : undefined

  const events = await adapters.database.listEvents({
    after,
    limit,
  })

  return serveEventLogPage(
    context,
    events.map((event, index) => {
      return parseAdapterRegistryEvent(
        event,
        `Adapter event log events[${index}]`,
      )
    }),
    after,
  )
}

async function serveEventRequest(
  context: Context,
  adapters: RegistryAdapters,
): Promise<Response> {
  const digestParts = validateRequest(
    digestPartsSchema,
    {
      algorithm: context.req.param('algorithm'),
      hex: context.req.param('hex'),
    },
    'Invalid event digest',
  )
  const digest = assertSha256Digest(
    `${digestParts.algorithm}:${digestParts.hex}`,
  )
  const event = await adapters.database.getEvent(digest)

  if (!event) {
    return context.json(
      errorResponse('event_not_found', 'Event not found'),
      404,
    )
  }

  return serveEvent(
    context,
    parseAdapterRegistryEvent(event, 'Adapter registry event', digest),
  )
}

async function serveObjectInventoryRequest(
  context: Context,
  adapters: RegistryAdapters,
): Promise<Response> {
  const query = validateRequest(
    eventListQuerySchema,
    {
      after: context.req.query('after'),
      limit: context.req.query('limit'),
    },
    'Invalid object inventory query',
  )
  const options: ObjectDescriptorListOptions = {
    ...(query.after === undefined
      ? {}
      : { after: assertSha256Digest(query.after) }),
    limit:
      query.limit === undefined
        ? defaultObjectInventoryPageLimit
        : Number(query.limit),
  }

  const descriptors = (await adapters.objects.listDescriptors(options)).map(
    (descriptor, index) => {
      return parseAdapterObjectDescriptor(
        descriptor,
        `Adapter object inventory objects[${index}]`,
      )
    },
  )

  return serveObjectInventoryPage(context, descriptors, options.after)
}

async function servePackageStateRequest(
  context: Context,
  adapters: RegistryAdapters,
): Promise<Response> {
  const packageId = parseRequestPackageId(
    requiredParam(context.req.param('packageId'), 'packageId'),
  )

  if (context.req.method === 'HEAD') {
    return servePackageStateHeadRequest(context, adapters, packageId)
  }

  const conditionalResponse = await serveConditionalPackageState(
    context,
    adapters,
    packageId,
  )

  if (conditionalResponse) {
    return conditionalResponse
  }

  const { lastEventId, lastEventTimestamp, state } =
    await adapters.database.getPackageEventState(packageId)
  const parsedState = parseAdapterPackageState(state, packageId)
  if (parsedState.releases.length === 0) {
    return context.json(
      errorResponse('package_not_found', 'Package not found'),
      404,
    )
  }

  return servePackageState(context, parsedState, {
    lastEventId,
    lastModified: lastEventTimestamp,
  })
}

async function servePackageStateHeadRequest(
  context: Context,
  adapters: RegistryAdapters,
  packageId: PackageId,
): Promise<Response> {
  const head = await adapters.database.getPackageEventHead(packageId)
  const lastEventId = head.lastEventId

  if (!lastEventId || head.releaseCount === 0) {
    return serveJson(
      context,
      errorResponse('package_not_found', 'Package not found'),
      {
        'cache-control': 'no-cache',
        'content-type': 'application/json; charset=UTF-8',
      },
      {
        status: 404,
      },
    )
  }

  const responseHead = {
    ...head,
    lastEventId,
  }
  const conditionalResponse = serveConditionalPackageStateHead(
    context,
    responseHead,
  )

  if (conditionalResponse) {
    return conditionalResponse
  }

  return new Response(null, {
    headers: packageStateHeaders({
      lastEventId,
      lastModified: head.modifiedAt ?? head.lastEventTimestamp,
    }),
  })
}

async function serveConditionalPackageState(
  context: Context,
  adapters: RegistryAdapters,
  packageId: PackageId,
): Promise<Response | undefined> {
  const ifNoneMatch = context.req.header('if-none-match')
  const ifModifiedSince = context.req.header('if-modified-since')

  if (!ifNoneMatch && !ifModifiedSince) {
    return undefined
  }

  const head = await adapters.database.getPackageEventHead(packageId)

  if (!head.lastEventId || head.releaseCount === 0) {
    return undefined
  }

  return serveConditionalPackageStateHead(context, {
    ...head,
    lastEventId: head.lastEventId,
  })
}

function serveConditionalPackageStateHead(
  context: Context,
  head: PackageEventHead & { lastEventId: Sha256Digest },
): Response | undefined {
  const ifNoneMatch = context.req.header('if-none-match')
  const ifModifiedSince = context.req.header('if-modified-since')
  const etag = packageStateEtag(head.lastEventId)

  if (ifNoneMatch) {
    return matchesIfNoneMatch(ifNoneMatch, etag)
      ? packageStateNotModified(head)
      : undefined
  }

  const modifiedAt = head.modifiedAt ?? head.lastEventTimestamp
  const lastModified = modifiedAt ? httpDate(modifiedAt) : undefined

  return matchesIfModifiedSince(ifModifiedSince, lastModified)
    ? packageStateNotModified(head)
    : undefined
}

async function serveReleaseEnvelopeRequest(
  context: Context,
  adapters: RegistryAdapters,
): Promise<Response> {
  const packageId = parseRequestPackageId(
    requiredParam(context.req.param('packageId'), 'packageId'),
  )
  const version = parseRequestVersion(context.req.param('version'))
  const release = await adapters.database.getRelease(packageId, version)

  if (!release) {
    return context.json(
      errorResponse('release_not_found', 'Release not found'),
      404,
    )
  }

  return serveReleaseEnvelope(
    context,
    parseAdapterStoredRelease(release, packageId, version),
  )
}

async function servePackageChannelRequest(
  context: Context,
  adapters: RegistryAdapters,
): Promise<Response> {
  const packageId = parseRequestPackageId(
    requiredParam(context.req.param('packageId'), 'packageId'),
  )
  const channel = parseRequestChannel(context.req.param('channel'))
  const version = await adapters.database.getPackageChannelVersion(
    packageId,
    channel,
  )

  if (!version) {
    return context.json(
      errorResponse('channel_not_found', 'Channel not found'),
      404,
    )
  }

  const release = await adapters.database.getRelease(packageId, version)

  if (!release) {
    return context.json(
      errorResponse('release_not_found', 'Release not found'),
      404,
    )
  }

  const parsedRelease = parseAdapterStoredRelease(release, packageId, version)

  return serveMutableReleaseEnvelope(
    context,
    parsedRelease,
    channelReleaseEnvelopeEtag(
      packageId,
      channel,
      version,
      parsedRelease.event.id,
    ),
  )
}

function eventLogResponse(events: RegistryEvent[]) {
  const lastEvent = events.at(-1)

  return {
    events,
    ...(lastEvent ? { nextAfter: lastEvent.id } : {}),
  }
}

function serveEventLogPage(
  context: Context,
  events: RegistryEvent[],
  after: Sha256Digest | undefined,
): Response {
  const response = eventLogResponse(events)
  const validator = response.nextAfter ?? after ?? 'head'
  const etag = `W/"regesta.event-log:${validator}:${events.length}"`
  const headers = {
    'cache-control': 'no-cache',
    'content-type': 'application/json; charset=UTF-8',
    etag,
  }

  if (matchesIfNoneMatch(context.req.header('if-none-match'), etag)) {
    return new Response(null, {
      headers,
      status: 304,
    })
  }

  return serveJson(context, response, headers)
}

function serveObjectInventoryPage(
  context: Context,
  descriptors: ObjectDescriptor[],
  after: Sha256Digest | undefined,
): Response {
  const lastDescriptor = descriptors.at(-1)
  const nextAfter =
    lastDescriptor === undefined ? {} : { nextAfter: lastDescriptor.digest }
  const validator = lastDescriptor?.digest ?? after ?? 'head'
  const etag = `W/"regesta.object-inventory:${validator}:${descriptors.length}"`
  const headers = {
    'cache-control': 'no-cache',
    'content-type': 'application/json; charset=UTF-8',
    etag,
  }

  if (matchesIfNoneMatch(context.req.header('if-none-match'), etag)) {
    return new Response(null, {
      headers,
      status: 304,
    })
  }

  return serveJson(
    context,
    {
      object: 'regesta.object-inventory',
      objects: descriptors,
      ...nextAfter,
    },
    headers,
  )
}

function serveEvent(context: Context, event: RegistryEvent): Response {
  return serveImmutableCanonicalJson(context, {
    etag: `W/"${event.id}"`,
    value: event,
  })
}

function serveReleaseEnvelope(
  context: Context,
  release: StoredRelease,
): Response {
  return serveImmutableCanonicalJson(context, {
    etag: `W/"${release.event.id}"`,
    value: release,
  })
}

function serveImmutableCanonicalJson(
  context: Context,
  input: {
    etag: string
    value: unknown
  },
): Response {
  const bytes = new TextEncoder().encode(`${canonicalJson(input.value)}\n`)
  const headers = {
    'cache-control': 'public, max-age=31536000, immutable',
    'content-length': String(bytes.byteLength),
    'content-type': 'application/json; charset=utf-8',
    etag: input.etag,
  }

  if (matchesIfNoneMatch(context.req.header('if-none-match'), input.etag)) {
    const conditionalHeaders = new Headers(headers)
    conditionalHeaders.delete('content-length')

    return new Response(null, {
      headers: conditionalHeaders,
      status: 304,
    })
  }

  return new Response(context.req.method === 'HEAD' ? null : bytes, {
    headers,
  })
}

function servePackageState(
  context: Context,
  state: PackageState,
  options: {
    lastEventId?: Sha256Digest
    lastModified?: string
  },
): Response {
  const headers = packageStateHeaders(options)

  if (
    headers.etag &&
    matchesIfNoneMatch(context.req.header('if-none-match'), headers.etag)
  ) {
    return new Response(null, {
      headers,
      status: 304,
    })
  }

  return serveJson(context, state, headers)
}

function parseAdapterPackageState(
  value: PackageState,
  packageId: PackageId,
): PackageState {
  const state = parsePackageState(value, 'Adapter package state')

  if (state.id !== packageId) {
    throw new TypeError(
      `Adapter package state id must match requested package id: ${packageId}`,
    )
  }

  return state
}

function parseAdapterRegistryEvent(
  value: RegistryEvent,
  label: string,
  expectedId?: Sha256Digest,
): RegistryEvent {
  const event = parseRegistryEvent(value, label)

  if (expectedId && event.id !== expectedId) {
    throw new TypeError(
      `${label} id must match requested event id: ${expectedId}`,
    )
  }

  return event
}

function parseAdapterObjectDescriptor(
  value: ObjectDescriptor,
  label: string,
  expectedDigest?: Sha256Digest,
): ObjectDescriptor {
  const descriptor = parseObjectDescriptor(value, label)

  if (expectedDigest && descriptor.digest !== expectedDigest) {
    throw new TypeError(
      `${label} digest must match requested object digest: ${expectedDigest}`,
    )
  }

  return descriptor
}

function parseAdapterStoredRelease(
  value: StoredRelease,
  packageId: PackageId,
  version: string,
): StoredRelease {
  return parseStoredRelease(value, {
    label: 'Adapter release',
    packageId,
    version,
  })
}

function packageStateNotModified(head: PackageEventHead): Response {
  return new Response(null, {
    headers: packageStateHeaders({
      lastEventId: head.lastEventId,
      lastModified: head.modifiedAt ?? head.lastEventTimestamp,
    }),
    status: 304,
  })
}

function packageStateHeaders(options: {
  lastEventId?: Sha256Digest
  lastModified?: string
}): Record<string, string> {
  return {
    'cache-control': 'no-cache',
    'content-type': 'application/json; charset=UTF-8',
    ...(options.lastEventId
      ? { etag: packageStateEtag(options.lastEventId) }
      : {}),
    ...(options.lastModified
      ? { 'last-modified': httpDate(options.lastModified) }
      : {}),
  }
}

function packageStateEtag(lastEventId: Sha256Digest): string {
  return `W/"${lastEventId}"`
}

function serveMutableReleaseEnvelope(
  context: Context,
  release: StoredRelease,
  etag: string | undefined,
): Response {
  const headers: Record<string, string> = {
    'cache-control': 'no-cache',
    'content-type': 'application/json; charset=UTF-8',
  }

  if (etag) {
    headers.etag = etag
  }

  if (
    headers.etag &&
    matchesIfNoneMatch(context.req.header('if-none-match'), headers.etag)
  ) {
    return new Response(null, {
      headers,
      status: 304,
    })
  }

  return serveJson(context, release, headers)
}

function channelReleaseEnvelopeEtag(
  packageId: PackageId,
  channel: string,
  version: string,
  releaseEventId: Sha256Digest,
): string {
  return `W/"regesta.channel:${sha256(
    canonicalJson({
      channel,
      package: packageId,
      releaseEvent: releaseEventId,
      version,
    }),
  )}"`
}

function serveJson(
  context: Context,
  body: unknown,
  headers: Record<string, string>,
  init: { status?: number; statusText?: string } = {},
): Response {
  const bytes = new TextEncoder().encode(JSON.stringify(body))
  const responseHeaders = {
    ...headers,
    'content-length': String(bytes.byteLength),
  }

  return context.req.method === 'HEAD'
    ? new Response(null, { ...init, headers: responseHeaders })
    : new Response(bytes, { ...init, headers: responseHeaders })
}

async function serveObject(
  context: Context,
  adapters: RegistryAdapters,
  digest: Sha256Digest,
  includeBody: boolean,
): Promise<Response> {
  const storedDescriptor = await adapters.objects.getDescriptor(digest)

  if (!storedDescriptor) {
    return context.json(
      errorResponse('object_not_found', 'Object not found'),
      404,
    )
  }

  const descriptor = parseAdapterObjectDescriptor(
    storedDescriptor,
    'Adapter object descriptor',
    digest,
  )
  const etag = `"${descriptor.digest}"`
  const headers = objectDescriptorHeaders(descriptor, etag)

  if (matchesIfNoneMatch(context.req.header('if-none-match'), etag)) {
    headers.delete('content-length')

    return new Response(null, {
      headers,
      status: 304,
    })
  }

  const includeBytes = includeBody && context.req.method !== 'HEAD'

  if (!includeBytes) {
    return objectDescriptorResponse(
      descriptor,
      etag,
      context.req.header('range'),
    )
  }

  const rangeHeader = context.req.header('range')
  if (rangeHeader && !parseSingleByteRange(rangeHeader, descriptor.size)) {
    return objectDescriptorResponse(descriptor, etag, rangeHeader)
  }

  const object = await adapters.objects.get(digest)

  if (!object) {
    return context.json(
      errorResponse('object_not_found', 'Object not found'),
      404,
    )
  }

  assertObjectResponseIntegrity({
    actual: object,
    digest,
    expected: descriptor,
    label: 'Object',
  })

  return immutableBytesResponse({
    bytes: object.bytes,
    cacheControl: 'public, max-age=31536000, immutable',
    contentType: object.descriptor.mediaType,
    etag,
    includeBody: includeBytes,
    rangeHeader,
  })
}

function objectDescriptorHeaders(
  descriptor: ObjectDescriptor,
  etag: string,
): Headers {
  return immutableDescriptorHeaders({
    cacheControl: 'public, max-age=31536000, immutable',
    contentLength: descriptor.size,
    contentType: descriptor.mediaType,
    etag,
  })
}

function objectDescriptorResponse(
  descriptor: ObjectDescriptor,
  etag: string,
  rangeHeader: string | undefined,
): Response {
  return immutableDescriptorResponse({
    cacheControl: 'public, max-age=31536000, immutable',
    contentLength: descriptor.size,
    contentType: descriptor.mediaType,
    etag,
    rangeHeader,
  })
}

async function readArtifacts(
  body: Record<string, File | string | undefined>,
  limits: NormalizedPublishUploadLimits,
) {
  const artifacts = await readJsonField(
    body.artifacts,
    'artifacts',
    artifactsSchema,
  )

  return Promise.all(
    artifacts.map(async (artifact) => {
      const role = validateArtifactDescriptorString(
        artifact.role,
        'artifact role',
      )
      const mediaType = validateObjectMediaType(artifact.mediaType)

      return {
        bytes: await readBinaryField(body[artifact.part], artifact.part, {
          maxBytes: limits.artifactBytes,
        }),
        ...(artifact.compatibility
          ? { compatibility: artifact.compatibility }
          : {}),
        ...(artifact.filename
          ? {
              filename: validateArtifactDescriptorString(
                artifact.filename,
                'artifact filename',
              ),
            }
          : {}),
        ...(artifact.format
          ? {
              format: validateArtifactDescriptorString(
                artifact.format,
                'artifact format',
              ),
            }
          : {}),
        mediaType,
        role,
      }
    }),
  )
}

function validateArtifactDescriptorString(
  value: string,
  label: string,
): string {
  try {
    return assertArtifactDescriptorString(value, label)
  } catch (error) {
    throw new RequestValidationError('Invalid artifacts', [
      error instanceof Error ? error.message : String(error),
    ])
  }
}

function validateObjectMediaType(value: string): string {
  try {
    return assertObjectMediaType(value, 'artifact mediaType')
  } catch (error) {
    throw new RequestValidationError('Invalid artifacts', [
      error instanceof Error ? error.message : String(error),
    ])
  }
}

interface PublishFromRequestInput {
  artifacts: PublishInput['artifacts']
  authorization: unknown
  config: RegestaConfig
  createdAt?: string
  requestUrl: string
  source: Uint8Array
}

async function publishFromRequest(
  input: PublishFromRequestInput,
  adapters: RegistryAdapters,
  services: CoreRegistryServices,
) {
  try {
    services.readWriteAuthorization(input.authorization)
    const processed = await processPublishArtifacts(services, {
      artifacts: input.artifacts,
      config: input.config,
    })
    const authorization = await services.verifyPublishAuthorization({
      artifacts: processed.artifacts,
      authorization: input.authorization,
      configDigest: configDigest(processed.config),
      packageId: processed.config.id,
      requestUrl: input.requestUrl,
      source: input.source,
      version: processed.config.version,
    })

    return await publishRelease(
      {
        artifacts: processed.artifacts,
        authorization,
        config: processed.config,
        ...(input.createdAt ? { createdAt: input.createdAt } : {}),
        source: input.source,
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

function processPublishArtifacts(
  services: CoreRegistryServices,
  input: ProcessPublishArtifactsInput,
): Promise<ProcessPublishArtifactsOutput> | ProcessPublishArtifactsOutput {
  return services.processPublishArtifacts
    ? services.processPublishArtifacts(input)
    : input
}

function parseRequestPackageId(value: string): PackageId {
  try {
    return parsePackageId(value).id
  } catch (error) {
    throw new RequestValidationError('Invalid package id', [
      error instanceof Error ? error.message : 'Invalid package id',
    ])
  }
}

function parseRequestChannel(value: string | undefined): string {
  try {
    return assertPackageChannel(requiredParam(value, 'channel'))
  } catch (error) {
    throw new RequestValidationError('Invalid channel', [
      error instanceof Error ? error.message : 'Invalid channel',
    ])
  }
}

function parseRequestVersion(value: string | undefined): string {
  try {
    return assertPackageVersion(requiredParam(value, 'version'))
  } catch (error) {
    throw new RequestValidationError('Invalid version', [
      error instanceof Error ? error.message : 'Invalid version',
    ])
  }
}

function normalizePublishUploadLimits(
  limits: PublishUploadLimits | undefined,
): NormalizedPublishUploadLimits {
  return {
    artifactBytes: normalizeByteLimit(limits?.artifactBytes),
    sourceBytes: normalizeByteLimit(limits?.sourceBytes),
  }
}

function normalizeByteLimit(value: number | undefined): number | undefined {
  if (value === undefined) {
    return undefined
  }

  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError('Upload byte limits must be non-negative safe integers')
  }

  return value
}

function writeCoreAuditLog(
  auditLog: CoreRegistryAuditSink | undefined,
  entry: CoreRegistryAuditEntry,
): void {
  if (!auditLog) {
    return
  }

  try {
    Promise.resolve(auditLog(entry)).catch((error: unknown) => {
      reportCoreAuditLogError(entry, error)
    })
  } catch (error) {
    reportCoreAuditLogError(entry, error)
  }
}

function reportCoreAuditLogError(
  entry: CoreRegistryAuditEntry,
  error: unknown,
): void {
  console.error('Core registry audit log sink failed', {
    action: entry.action,
    error,
    ...(entry.outcome === 'accepted' ? { eventId: entry.eventId } : {}),
    package: entry.package,
  })
}

function rejectedCoreWriteAuditEntry(
  error: unknown,
  entry: Omit<
    CoreRegistryRejectedAuditEntry,
    'kind' | 'observedAt' | 'outcome' | 'reason'
  >,
): CoreRegistryRejectedAuditEntry {
  return {
    ...entry,
    kind: 'regesta.core-audit',
    observedAt: new Date().toISOString(),
    outcome: 'rejected',
    reason: error instanceof Error ? error.message : String(error),
  }
}

function auditRequestFields(context: Context): { requestId?: string } {
  const requestId =
    context.res.headers.get('x-request-id') ??
    context.req.header('x-request-id')

  return requestId ? { requestId } : {}
}
