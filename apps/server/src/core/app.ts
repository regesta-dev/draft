import {
  configDigest,
  deletePackageChannel,
  getPackageChannelVersion,
  normalizeRegestaConfig,
  publishRelease,
  updatePackageChannel,
  verifyRelease,
  type ObjectDescriptorListOptions,
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
  parsePackageId,
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
  immutableBytesResponse,
  immutableDescriptorHeaders,
  immutableDescriptorResponse,
  matchesIfNoneMatch,
  parseSingleByteRange,
} from '../responses.ts'

export interface CoreRegistryServices {
  domainBindingFetchForRequest?: DomainBindingFetchForRequest
  processPublishArtifacts?: PublishArtifactProcessor
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

export type DomainBindingFetchForRequest = (requestUrl: string) => typeof fetch

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
  fetchBinding: typeof fetch
  packageId: PackageId
  source: Uint8Array
  version: string
}

export interface VerifyChannelUpdateAuthorizationInput {
  authorization: unknown
  channel: string
  fetchBinding: typeof fetch
  packageId: PackageId
  previousVersion?: string
  version: string
}

export interface VerifyChannelDeleteAuthorizationInput {
  authorization: unknown
  channel: string
  fetchBinding: typeof fetch
  packageId: PackageId
  previousVersion?: string
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
          requestUrl: context.req.url,
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
    const previousVersion = await getPackageChannelVersion(
      adapters,
      packageId,
      channel,
    )
    let result: Awaited<ReturnType<typeof updatePackageChannel>>

    try {
      const authorization = await services.verifyChannelUpdateAuthorization({
        authorization: body.authorization,
        channel,
        fetchBinding: bindingFetchForRequest(services, context.req.url),
        packageId,
        ...(previousVersion ? { previousVersion } : {}),
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
          ...(previousVersion ? { previousVersion } : {}),
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
      ...(result.previousVersion
        ? { previousVersion: result.previousVersion }
        : {}),
      ...auditRequestFields(context),
      timestamp: result.event.timestamp,
      version,
    })

    return context.json({
      channel,
      event: result.event,
      package: packageId,
      ...(result.previousVersion
        ? { previousVersion: result.previousVersion }
        : {}),
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
    const previousVersion = await getPackageChannelVersion(
      adapters,
      packageId,
      channel,
    )
    let result: Awaited<ReturnType<typeof deletePackageChannel>>

    try {
      const authorization = await services.verifyChannelDeleteAuthorization({
        authorization: body.authorization,
        channel,
        fetchBinding: bindingFetchForRequest(services, context.req.url),
        packageId,
        ...(previousVersion ? { previousVersion } : {}),
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
          ...(previousVersion ? { previousVersion } : {}),
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
      ...(result.previousVersion
        ? { previousVersion: result.previousVersion }
        : {}),
      ...auditRequestFields(context),
      timestamp: result.event.timestamp,
    })

    return context.json({
      channel,
      event: result.event,
      package: packageId,
      ...(result.previousVersion
        ? { previousVersion: result.previousVersion }
        : {}),
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

  if (after && !(await adapters.database.getEvent(after))) {
    return context.json(
      errorResponse('event_cursor_not_found', 'Event cursor not found'),
      404,
    )
  }

  const events = await adapters.database.listEvents({
    after,
    limit,
  })

  return serveEventLogPage(context, events, after)
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

  return serveEvent(context, event)
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

  if (
    options.after !== undefined &&
    !(await adapters.objects.getDescriptor(options.after))
  ) {
    return context.json(
      errorResponse('object_cursor_not_found', 'Object cursor not found'),
      404,
    )
  }

  const descriptors = await adapters.objects.listDescriptors(options)

  return serveObjectInventoryPage(context, descriptors, options.after)
}

async function servePackageStateRequest(
  context: Context,
  adapters: RegistryAdapters,
): Promise<Response> {
  const packageId = parseRequestPackageId(
    requiredParam(context.req.param('packageId'), 'packageId'),
  )
  const { lastEventId, state } =
    await adapters.database.getPackageEventState(packageId)
  if (state.releases.length === 0) {
    return context.json(
      errorResponse('package_not_found', 'Package not found'),
      404,
    )
  }

  return servePackageState(context, state, lastEventId)
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

  return serveReleaseEnvelope(context, release)
}

async function servePackageChannelRequest(
  context: Context,
  adapters: RegistryAdapters,
): Promise<Response> {
  const packageId = parseRequestPackageId(
    requiredParam(context.req.param('packageId'), 'packageId'),
  )
  const channel = parseRequestChannel(context.req.param('channel'))
  const channels = await adapters.database.getPackageChannels(packageId)
  const version = channels[channel]

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

  return serveMutableReleaseEnvelope(
    context,
    release,
    channelReleaseEnvelopeEtag(packageId, channel, version, release.event.id),
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
  lastEventId: Sha256Digest | undefined,
): Response {
  const headers: Record<string, string> = {
    'cache-control': 'no-cache',
    'content-type': 'application/json; charset=UTF-8',
  }

  if (lastEventId) {
    headers.etag = `W/"${lastEventId}"`
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

  return serveJson(context, state, headers)
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
  const descriptor = await adapters.objects.getDescriptor(digest)

  if (!descriptor) {
    return context.json(
      errorResponse('object_not_found', 'Object not found'),
      404,
    )
  }

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
    const processed = await processPublishArtifacts(services, {
      artifacts: input.artifacts,
      config: input.config,
    })
    const authorization = await services.verifyPublishAuthorization({
      artifacts: processed.artifacts,
      authorization: input.authorization,
      configDigest: configDigest(processed.config),
      fetchBinding: bindingFetchForRequest(services, input.requestUrl),
      packageId: processed.config.id,
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

function bindingFetchForRequest(
  services: CoreRegistryServices,
  requestUrl: string,
): typeof fetch {
  return services.domainBindingFetchForRequest
    ? services.domainBindingFetchForRequest(requestUrl)
    : fetch
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
