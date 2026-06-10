import {
  assertRegistryEventIntegrity,
  replayPackageState,
  verifyRelease,
  type RegistryAdapters,
  type RegistryDatabase,
  type StoredObject,
  type StoredRelease,
  type VerificationResult,
} from '@regesta/core'
import {
  assertSha256Digest,
  canonicalJson,
  type ObjectDescriptor,
  type PackageId,
  type RegistryEvent,
  type Sha256Digest,
} from '@regesta/protocol'

export interface VerifyReleaseFromRegistryInput {
  fetch?: typeof fetch
  packageId: PackageId
  registry: string
  version: string
}

export interface VerifyEventLogFromRegistryInput {
  fetch?: typeof fetch
  limit?: number
  maxPages?: number
  registry: string
}

export interface EventLogVerificationResult {
  checkedEvents: number
  lastEventId?: Sha256Digest
  ok: boolean
  packages: number
  problems: string[]
}

interface PublicEventLogPage {
  events: RegistryEvent[]
  nextAfter?: Sha256Digest
  schema: 'regesta.event-log.v0'
}

const defaultEventLogPageLimit = 999
const defaultEventLogMaxPages = 1000

export async function verifyReleaseFromRegistry(
  input: VerifyReleaseFromRegistryInput,
): Promise<VerificationResult> {
  const fetchImpl = input.fetch ?? fetch
  const registry = normalizeRegistry(input.registry)
  const releaseFetch = await fetchPublicJson(
    fetchImpl,
    releaseUrl(registry, input.packageId, input.version),
    'Public release request',
  )
  if (!releaseFetch.ok) {
    return {
      ok: false,
      problems: [releaseFetch.problem],
    }
  }

  const releaseValue = releaseFetch.value
  if (!isPublicStoredReleaseEnvelope(releaseValue)) {
    return {
      ok: false,
      problems: publicStoredReleaseProblems(releaseValue),
    }
  }

  const release = releaseValue
  const releaseEtagProblem = publicEtagProblem(
    releaseFetch.headers,
    release.event.id,
    'Public release response',
  )
  if (releaseEtagProblem) {
    return {
      manifest: release.manifest,
      ok: false,
      problems: [releaseEtagProblem],
    }
  }

  const eventFetch = await fetchPublicJson(
    fetchImpl,
    eventUrl(registry, release.event.id),
    'Public event request',
  )
  if (!eventFetch.ok) {
    return {
      manifest: release.manifest,
      ok: false,
      problems: [eventFetch.problem],
    }
  }

  const event = eventFetch.value
  if (!isPublicRegistryEventEnvelope(event)) {
    return {
      manifest: release.manifest,
      ok: false,
      problems: ['Public event response must be an object'],
    }
  }
  const eventIntegrityProblem = publicRegistryEventIntegrityProblem(
    event,
    'Public event response',
  )
  if (eventIntegrityProblem) {
    return {
      manifest: release.manifest,
      ok: false,
      problems: [eventIntegrityProblem],
    }
  }

  if (event.id !== release.event.id) {
    return {
      manifest: release.manifest,
      ok: false,
      problems: ['Public event response id does not match release event id'],
    }
  }

  const eventEtagProblem = publicEtagProblem(
    eventFetch.headers,
    release.event.id,
    'Public event response',
  )
  if (eventEtagProblem) {
    return {
      manifest: release.manifest,
      ok: false,
      problems: [eventEtagProblem],
    }
  }

  const adapters = publicRegistryAdapters({
    event,
    fetch: fetchImpl,
    packageId: input.packageId,
    registry,
    release,
    version: input.version,
  })

  return verifyRelease(adapters, input.packageId, input.version)
}

export async function verifyEventLogFromRegistry(
  input: VerifyEventLogFromRegistryInput,
): Promise<EventLogVerificationResult> {
  const fetchImpl = input.fetch ?? fetch
  const registry = normalizeRegistry(input.registry)
  const limit = input.limit ?? defaultEventLogPageLimit
  const maxPages = input.maxPages ?? defaultEventLogMaxPages
  const problems: string[] = []
  const eventIds = new Set<Sha256Digest>()
  const events: RegistryEvent[] = []
  let after: Sha256Digest | undefined
  let reachedTail = false

  try {
    validateEventLogPageLimit(limit)
    validatePositiveInteger(maxPages, 'Event log max pages')
  } catch (error) {
    return {
      checkedEvents: 0,
      ok: false,
      packages: 0,
      problems: [errorMessage(error)],
    }
  }

  for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
    const pageFetch = await fetchPublicJson(
      fetchImpl,
      eventLogUrl(registry, { after, limit }),
      'Public event log request',
    )

    if (!pageFetch.ok) {
      problems.push(pageFetch.problem)
      break
    }

    if (!isPublicEventLogPage(pageFetch.value)) {
      problems.push(...publicEventLogPageProblems(pageFetch.value))
      break
    }

    const page = pageFetch.value
    if (page.events.length > limit) {
      problems.push('Public event log page returned more events than requested')
      break
    }

    if (page.events.length === 0) {
      if (page.nextAfter) {
        problems.push('Public event log empty page must not include nextAfter')
      }
      reachedTail = true
      break
    }

    const lastEventId = page.events.at(-1)?.id
    if (page.nextAfter !== lastEventId) {
      problems.push('Public event log nextAfter must match last event id')
      break
    }

    if (after && page.nextAfter === after) {
      problems.push('Public event log cursor did not advance')
      break
    }

    for (const event of page.events) {
      try {
        assertRegistryEventIntegrity(event)
      } catch (error) {
        problems.push(
          `Public event log event is invalid: ${errorMessage(error)}`,
        )
        continue
      }

      if (eventIds.has(event.id)) {
        problems.push(
          `Public event log contains duplicate event id: ${event.id}`,
        )
        continue
      }

      const endpointProblem = await publicEventEndpointProblem({
        event,
        fetch: fetchImpl,
        registry,
      })
      if (endpointProblem) {
        problems.push(endpointProblem)
        continue
      }

      eventIds.add(event.id)
      events.push(event)
    }

    if (problems.length > 0) {
      break
    }

    after = page.nextAfter
  }

  if (!reachedTail && problems.length === 0) {
    problems.push('Public event log verification stopped before reaching tail')
  }

  if (events.length > 0 && problems.length === 0) {
    problems.push(...verifyEventLogReplay(events))
  }

  const packageIds = new Set(
    events.map((event) => registryEventPackageId(event)),
  )

  return {
    checkedEvents: events.length,
    ...(after ? { lastEventId: after } : {}),
    ok: problems.length === 0,
    packages: packageIds.size,
    problems,
  }
}

type PublicJsonFetchResult =
  | {
      ok: false
      problem: string
    }
  | {
      headers: Headers
      ok: true
      value: unknown
    }

async function fetchPublicJson(
  fetchImpl: typeof fetch,
  url: string,
  label: string,
): Promise<PublicJsonFetchResult> {
  try {
    const response = await fetchJson(fetchImpl, url)

    return {
      headers: response.headers,
      ok: true,
      value: response.value,
    }
  } catch (error) {
    return {
      ok: false,
      problem: `${label} failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    }
  }
}

function publicEtagProblem(
  headers: Headers,
  expectedDigest: Sha256Digest,
  label: string,
): string | undefined {
  const etag = headers.get('etag')

  if (!etag) {
    return `${label} is missing ETag`
  }

  return etagMatchesDigest(etag, expectedDigest)
    ? undefined
    : `${label} ETag does not match event id`
}

function publicRegistryAdapters(input: {
  event: RegistryEvent
  fetch: typeof fetch
  packageId: PackageId
  registry: string
  release: StoredRelease
  version: string
}): RegistryAdapters {
  const objectDescriptors = new Map<Sha256Digest, ObjectDescriptor>()

  return {
    database: publicRegistryDatabase({
      event: input.event,
      packageId: input.packageId,
      release: input.release,
      version: input.version,
    }),
    objects: {
      get: (digest) => {
        return fetchObject(
          input.fetch,
          objectUrl(input.registry, digest),
          objectDescriptors.get(digest),
        )
      },
      getDescriptor: async (digest) => {
        const descriptor = await fetchObjectDescriptor(
          input.fetch,
          objectUrl(input.registry, digest),
        )
        objectDescriptors.set(digest, descriptor)
        return { ...descriptor }
      },
      put: unsupportedWrite('put object'),
    },
    queue: {
      enqueue: unsupportedWrite('enqueue queue item'),
    },
    signer: {
      sign: unsupportedWrite('sign bytes'),
    },
  }
}

function publicRegistryDatabase(input: {
  event: RegistryEvent
  packageId: PackageId
  release: StoredRelease
  version: string
}): RegistryDatabase {
  return {
    appendEvent: unsupportedWrite('append event'),
    commitPackageChannelDelete: unsupportedWrite('delete package channel'),
    commitPackageChannelUpdate: unsupportedWrite('update package channel'),
    commitPublishedRelease: unsupportedWrite('commit release'),
    getEvent: (id) =>
      Promise.resolve(id === input.release.event.id ? input.event : undefined),
    getEventLog: unsupportedRead('read full event log'),
    getPackageChannels: unsupportedRead('read package channels'),
    getRelease: (packageId, version) => {
      return Promise.resolve(
        packageId === input.packageId && version === input.version
          ? input.release
          : undefined,
      )
    },
    hasAuthorizationPayloadDigest: unsupportedRead(
      'read authorization payload digest',
    ),
    listEvents: unsupportedRead('list events'),
    listPackageEvents: unsupportedRead('list package events'),
    listPackageReleases: unsupportedRead('list package releases'),
  }
}

function isPublicStoredReleaseEnvelope(value: unknown): value is StoredRelease {
  return publicStoredReleaseProblems(value).length === 0
}

function publicStoredReleaseProblems(value: unknown): string[] {
  const problems: string[] = []

  if (!isRecord(value)) {
    return ['Public release response must be an object']
  }

  const unknownField = Object.keys(value).find(
    (key) => !['event', 'manifest', 'manifestDescriptor'].includes(key),
  )
  if (unknownField) {
    problems.push(
      `Public release response must not include unknown field: ${unknownField}`,
    )
  }

  if (isRecord(value.event)) {
    if (typeof value.event.id === 'string') {
      try {
        assertSha256Digest(value.event.id)
      } catch {
        problems.push(
          'Public release response event id must be a sha256 digest',
        )
      }
    } else {
      problems.push('Public release response event id must be a sha256 digest')
    }
  } else {
    problems.push('Public release response event must be an object')
  }

  if (!isRecord(value.manifest)) {
    problems.push('Public release response manifest must be an object')
  }

  if (!isRecord(value.manifestDescriptor)) {
    problems.push(
      'Public release response manifestDescriptor must be an object',
    )
  }

  return problems
}

function isPublicRegistryEventEnvelope(value: unknown): value is RegistryEvent {
  return isRecord(value)
}

function publicRegistryEventIntegrityProblem(
  event: RegistryEvent,
  label: string,
): string | undefined {
  try {
    assertRegistryEventIntegrity(event)
    return undefined
  } catch (error) {
    return `${label} is invalid: ${errorMessage(error)}`
  }
}

async function publicEventEndpointProblem(input: {
  event: RegistryEvent
  fetch: typeof fetch
  registry: string
}): Promise<string | undefined> {
  const eventFetch = await fetchPublicJson(
    input.fetch,
    eventUrl(input.registry, input.event.id),
    'Public event endpoint request',
  )

  if (!eventFetch.ok) {
    return eventFetch.problem
  }

  const event = eventFetch.value
  if (!isPublicRegistryEventEnvelope(event)) {
    return 'Public event endpoint response must be an object'
  }

  const integrityProblem = publicRegistryEventIntegrityProblem(
    event,
    'Public event endpoint response',
  )
  if (integrityProblem) {
    return integrityProblem
  }

  if (event.id !== input.event.id) {
    return 'Public event endpoint response id does not match event log entry id'
  }

  const etagProblem = publicEtagProblem(
    eventFetch.headers,
    input.event.id,
    'Public event endpoint response',
  )
  if (etagProblem) {
    return etagProblem
  }

  return canonicalJson(event) === canonicalJson(input.event)
    ? undefined
    : 'Public event endpoint response does not match event log page entry'
}

async function fetchJson(
  fetchImpl: typeof fetch,
  url: string,
): Promise<{ headers: Headers; value: unknown }> {
  const response = await fetchImpl(url, {
    headers: {
      accept: 'application/json',
    },
  })

  if (!response.ok) {
    throw new Error(`Registry request failed: ${response.status} ${url}`)
  }

  validateJsonContentType(response.headers.get('content-type'), url)

  return {
    headers: response.headers,
    value: await response.json(),
  }
}

function validateJsonContentType(value: string | null, url: string): void {
  if (!value) {
    throw new TypeError(`Missing JSON Content-Type header: ${url}`)
  }

  const mediaType = value.split(';', 1)[0]?.trim().toLowerCase()

  if (mediaType !== 'application/json' && !mediaType?.endsWith('+json')) {
    throw new TypeError(`Invalid JSON Content-Type header: ${url}`)
  }
}

async function fetchObject(
  fetchImpl: typeof fetch,
  url: string,
  descriptor?: ObjectDescriptor,
): Promise<StoredObject> {
  const expectedDescriptor =
    descriptor ?? (await fetchObjectDescriptor(fetchImpl, url))
  const response = await fetchImpl(url)

  if (!response.ok) {
    throw new Error(`Registry object request failed: ${response.status} ${url}`)
  }

  const bytes = new Uint8Array(await response.arrayBuffer())
  validateObjectGetResponse(url, response, bytes, expectedDescriptor)

  return {
    bytes,
    descriptor: expectedDescriptor,
  }
}

async function fetchObjectDescriptor(
  fetchImpl: typeof fetch,
  url: string,
): Promise<ObjectDescriptor> {
  const headResponse = await fetchImpl(url, {
    method: 'HEAD',
  })

  if (!headResponse.ok) {
    throw new Error(
      `Registry object HEAD failed: ${headResponse.status} ${url}`,
    )
  }

  return objectDescriptorFromHeadResponse(url, headResponse)
}

function objectDescriptorFromHeadResponse(
  url: string,
  response: Response,
): ObjectDescriptor {
  const digest = digestFromObjectUrl(url)
  const sizeHeader = response.headers.get('content-length')
  const mediaType = response.headers.get('content-type')
  const etag = response.headers.get('etag')

  if (!etag) {
    throw new TypeError(`Missing object ETag header: ${url}`)
  }

  if (!etagMatchesDigest(etag, digest)) {
    throw new TypeError(`Public object ETag does not match digest: ${url}`)
  }

  if (!sizeHeader) {
    throw new TypeError(`Missing object Content-Length header: ${url}`)
  }

  if (!mediaType) {
    throw new TypeError(`Missing object Content-Type header: ${url}`)
  }

  return {
    digest,
    mediaType,
    size: parseContentLength(sizeHeader, url),
  }
}

function validateObjectGetResponse(
  url: string,
  response: Response,
  bytes: Uint8Array,
  descriptor: ObjectDescriptor,
): void {
  const digest = digestFromObjectUrl(url)
  const etag = response.headers.get('etag')
  const sizeHeader = response.headers.get('content-length')
  const mediaType = response.headers.get('content-type')

  if (!etag) {
    throw new TypeError(`Missing object ETag header: ${url}`)
  }

  if (!etagMatchesDigest(etag, digest)) {
    throw new TypeError(`Public object ETag does not match digest: ${url}`)
  }

  if (!sizeHeader) {
    throw new TypeError(`Missing object Content-Length header: ${url}`)
  }

  if (parseContentLength(sizeHeader, url) !== bytes.byteLength) {
    throw new TypeError(
      `Public object Content-Length does not match body: ${url}`,
    )
  }

  if (!mediaType) {
    throw new TypeError(`Missing object Content-Type header: ${url}`)
  }

  if (mediaType !== descriptor.mediaType) {
    throw new TypeError(`Public object Content-Type mismatch: ${url}`)
  }
}

function parseContentLength(value: string, url: string): number {
  if (!/^(?:0|[1-9]\d*)$/u.test(value)) {
    throw new TypeError(`Invalid object Content-Length header: ${url}`)
  }

  const size = Number(value)

  if (!Number.isSafeInteger(size)) {
    throw new TypeError(`Invalid object Content-Length header: ${url}`)
  }

  return size
}

function etagMatchesDigest(etag: string, digest: Sha256Digest): boolean {
  return stripWeakEtag(etag.trim()) === `"${digest}"`
}

function stripWeakEtag(etag: string): string {
  return etag.startsWith('W/') ? etag.slice(2) : etag
}

function releaseUrl(
  registry: string,
  packageId: PackageId,
  version: string,
): string {
  return `${registry}/packages/${encodeURIComponent(
    packageId,
  )}/releases/${encodeURIComponent(version)}`
}

function eventUrl(registry: string, digest: Sha256Digest): string {
  const { algorithm, hex } = digestParts(digest)
  return `${registry}/events/${algorithm}/${hex}`
}

function eventLogUrl(
  registry: string,
  options: {
    after: Sha256Digest | undefined
    limit: number
  },
): string {
  const url = new URL(`${registry}/events`)
  if (options.after) {
    url.searchParams.set('after', options.after)
  }
  url.searchParams.set('limit', String(options.limit))
  return url.href
}

function objectUrl(registry: string, digest: Sha256Digest): string {
  const { algorithm, hex } = digestParts(digest)
  return `${registry}/objects/${algorithm}/${hex}`
}

function digestFromObjectUrl(url: string): Sha256Digest {
  const parsed = new URL(url)
  const parts = parsed.pathname.split('/')
  const hex = parts.pop()
  const algorithm = parts.pop()

  return assertSha256Digest(`${algorithm}:${hex}`)
}

function digestParts(digest: Sha256Digest): {
  algorithm: string
  hex: string
} {
  const [algorithm, hex] = digest.split(':')

  return {
    algorithm: algorithm!,
    hex: hex!,
  }
}

function normalizeRegistry(registry: string): string {
  return registry.replace(/\/$/, '')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isPublicEventLogPage(value: unknown): value is PublicEventLogPage {
  return publicEventLogPageProblems(value).length === 0
}

function publicEventLogPageProblems(value: unknown): string[] {
  const problems: string[] = []

  if (!isRecord(value)) {
    return ['Public event log response must be an object']
  }

  const unknownField = Object.keys(value).find(
    (key) => !['events', 'nextAfter', 'schema'].includes(key),
  )
  if (unknownField) {
    problems.push(
      `Public event log response must not include unknown field: ${unknownField}`,
    )
  }

  if (value.schema !== 'regesta.event-log.v0') {
    problems.push('Public event log schema must be regesta.event-log.v0')
  }

  if (!Array.isArray(value.events)) {
    problems.push('Public event log events must be an array')
  } else if (!value.events.every((event) => isRecord(event))) {
    problems.push('Public event log events must contain objects')
  }

  if (typeof value.nextAfter === 'string') {
    try {
      assertSha256Digest(value.nextAfter)
    } catch {
      problems.push('Public event log nextAfter must be a sha256 digest')
    }
  } else if (value.nextAfter !== undefined) {
    problems.push('Public event log nextAfter must be a sha256 digest')
  }

  return problems
}

function verifyEventLogReplay(events: RegistryEvent[]): string[] {
  const problems: string[] = []
  const packageEvents = new Map<PackageId, RegistryEvent[]>()

  for (const event of events) {
    const packageId = registryEventPackageId(event)
    packageEvents.set(packageId, [
      ...(packageEvents.get(packageId) ?? []),
      event,
    ])
  }

  for (const [packageId, eventsForPackage] of packageEvents) {
    try {
      replayPackageState(eventsForPackage, packageId)
    } catch (error) {
      problems.push(
        `Public event log package replay failed for ${packageId}: ${errorMessage(error)}`,
      )
    }
  }

  return problems
}

function registryEventPackageId(event: RegistryEvent): PackageId {
  return event.eventType === 'release.published'
    ? event.release.id
    : event.package
}

function validatePositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${label} must be a positive safe integer`)
  }
}

function validateEventLogPageLimit(value: number): void {
  validatePositiveInteger(value, 'Event log page limit')

  if (value > defaultEventLogPageLimit) {
    throw new TypeError(
      `Event log page limit must be at most ${defaultEventLogPageLimit}`,
    )
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function unsupportedRead(operation: string): () => Promise<never> {
  return () =>
    Promise.reject(
      new Error(`Public registry verification cannot ${operation}`),
    )
}

function unsupportedWrite<TArgs extends unknown[]>(
  operation: string,
): (...args: TArgs) => Promise<never> {
  return () =>
    Promise.reject(
      new Error(`Public registry verification cannot ${operation}`),
    )
}
