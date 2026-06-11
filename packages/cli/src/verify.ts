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
import { processNpmPublishArtifacts } from '@regesta/npm'
import {
  assertSha256Digest,
  canonicalJson,
  parseObjectDescriptor,
  parsePackageId,
  parsePackageState,
  parseRegistryEvent,
  parseReleaseManifest,
  sha256,
  type ObjectDescriptor,
  type PackageId,
  type PackageState,
  type RegistryEvent,
  type ReleaseManifest,
  type Sha256Digest,
} from '@regesta/protocol'
import { normalizeRegistryUrl } from './registry-url.ts'

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

export interface CompareEventLogsFromRegistriesInput {
  fetch?: typeof fetch
  leftRegistry: string
  limit?: number
  maxPages?: number
  rightRegistry: string
}

export interface VerifyPackageStateFromRegistryInput {
  fetch?: typeof fetch
  limit?: number
  maxPages?: number
  packageId: PackageId
  registry: string
}

export interface EventLogVerificationResult {
  checkedEvents: number
  lastEventId?: Sha256Digest
  ok: boolean
  packages: number
  problems: string[]
}

export interface EventLogComparisonSide {
  checkedEvents: number
  lastEventId?: Sha256Digest
  packages: number
  registry: string
}

export interface EventLogComparisonResult {
  checkedEvents: number
  left: EventLogComparisonSide
  ok: boolean
  problems: string[]
  right: EventLogComparisonSide
}

export interface PackageStateVerificationResult {
  checkedEvents: number
  lastEventId?: Sha256Digest
  ok: boolean
  problems: string[]
  state?: PackageState
}

interface PublicEventLogPage {
  events: RegistryEvent[]
  nextAfter?: Sha256Digest
}

interface PublicEventLogReadResult {
  events: RegistryEvent[]
  lastEventId?: Sha256Digest
  problems: string[]
  reachedTail: boolean
}

const defaultEventLogPageLimit = 999
const defaultEventLogMaxPages = 1000

export async function verifyReleaseFromRegistry(
  input: VerifyReleaseFromRegistryInput,
): Promise<VerificationResult> {
  const fetchImpl = input.fetch ?? fetch
  const registry = normalizeRegistryUrl(input.registry)
  const releaseFetch = await fetchPublicCanonicalJson(
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

  const releaseRead = parsePublicStoredReleaseEnvelope(releaseFetch.value)
  if (!releaseRead.release) {
    return {
      ok: false,
      problems: releaseRead.problems,
    }
  }

  const release = releaseRead.release
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

  const eventFetch = await fetchPublicCanonicalJson(
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

  const eventRead = parsePublicRegistryEvent(
    eventFetch.value,
    'Public event response',
  )
  if (!eventRead.event) {
    return {
      manifest: release.manifest,
      ok: false,
      problems: [eventRead.problem],
    }
  }
  const { event } = eventRead

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

  if (canonicalJson(event) !== canonicalJson(release.event)) {
    return {
      manifest: release.manifest,
      ok: false,
      problems: ['Public release event does not match public event response'],
    }
  }

  const fetchedObjects = new Map<Sha256Digest, StoredObject>()
  const adapters = publicRegistryAdapters({
    event,
    fetch: fetchImpl,
    fetchedObjects,
    packageId: input.packageId,
    registry,
    release,
    version: input.version,
  })

  const result = await verifyRelease(adapters, input.packageId, input.version)
  if (!result.ok || !result.manifest) {
    return result
  }

  const ecosystemProblems = await verifyEcosystemMetadataFromArtifacts(
    result.manifest,
    fetchedObjects,
  )

  return {
    manifest: result.manifest,
    ok: ecosystemProblems.length === 0,
    problems: [...result.problems, ...ecosystemProblems],
  }
}

async function verifyEcosystemMetadataFromArtifacts(
  manifest: ReleaseManifest,
  fetchedObjects: ReadonlyMap<Sha256Digest, StoredObject>,
): Promise<string[]> {
  if (manifest.ecosystem !== 'npm') {
    return []
  }

  const installArtifact = manifest.artifacts.find((artifact) => {
    return artifact.role === 'install'
  })

  if (!installArtifact) {
    return []
  }

  const object = fetchedObjects.get(installArtifact.digest)
  if (!object) {
    return [
      `npm install artifact bytes were not fetched: ${installArtifact.digest}`,
    ]
  }

  try {
    const processed = await processNpmPublishArtifacts(
      {
        id: manifest.id,
        provenance: {
          level: 'source-attached',
        },
        source: {
          include: ['regesta.json'],
        },
        version: manifest.version,
      },
      [
        {
          bytes: object.bytes,
          role: installArtifact.role,
        },
      ],
    )
    const actualNpmMetadata = installArtifact.ecosystemMetadata?.npm
    const expectedNpmMetadata = processed?.ecosystemMetadata?.npm

    return sameCanonicalJson(
      actualNpmMetadata ?? null,
      expectedNpmMetadata ?? null,
    )
      ? []
      : ['npm artifact ecosystemMetadata does not match install artifact']
  } catch (error) {
    return [`npm install artifact verification failed: ${errorMessage(error)}`]
  }
}

export async function verifyEventLogFromRegistry(
  input: VerifyEventLogFromRegistryInput,
): Promise<EventLogVerificationResult> {
  const fetchImpl = input.fetch ?? fetch
  const registry = normalizeRegistryUrl(input.registry)
  const limit = input.limit ?? defaultEventLogPageLimit
  const maxPages = input.maxPages ?? defaultEventLogMaxPages

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

  const read = await readPublicEventLog({
    fetch: fetchImpl,
    limit,
    maxPages,
    registry,
  })
  const events = read.events
  const problems = [...read.problems]

  if (!read.reachedTail && problems.length === 0) {
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
    ...(read.lastEventId ? { lastEventId: read.lastEventId } : {}),
    ok: problems.length === 0,
    packages: packageIds.size,
    problems,
  }
}

export async function compareEventLogsFromRegistries(
  input: CompareEventLogsFromRegistriesInput,
): Promise<EventLogComparisonResult> {
  const fetchImpl = input.fetch ?? fetch
  const leftRegistry = normalizeRegistryUrl(input.leftRegistry)
  const rightRegistry = normalizeRegistryUrl(input.rightRegistry)
  const limit = input.limit ?? defaultEventLogPageLimit
  const maxPages = input.maxPages ?? defaultEventLogMaxPages

  try {
    validateEventLogPageLimit(limit)
    validatePositiveInteger(maxPages, 'Event log max pages')
  } catch (error) {
    return {
      checkedEvents: 0,
      left: eventLogComparisonSide(leftRegistry, []),
      ok: false,
      problems: [errorMessage(error)],
      right: eventLogComparisonSide(rightRegistry, []),
    }
  }

  const [leftRead, rightRead] = await Promise.all([
    readPublicEventLog({
      fetch: fetchImpl,
      limit,
      maxPages,
      registry: leftRegistry,
    }),
    readPublicEventLog({
      fetch: fetchImpl,
      limit,
      maxPages,
      registry: rightRegistry,
    }),
  ])
  const leftProblems = eventLogReadVerificationProblems(leftRead)
  const rightProblems = eventLogReadVerificationProblems(rightRead)
  const problems = [
    ...leftProblems.map(
      (problem) => `Left registry event log failed: ${problem}`,
    ),
    ...rightProblems.map(
      (problem) => `Right registry event log failed: ${problem}`,
    ),
  ]

  if (problems.length === 0) {
    problems.push(
      ...compareRegistryEventSequences(leftRead.events, rightRead.events),
    )
  }

  return {
    checkedEvents: Math.min(leftRead.events.length, rightRead.events.length),
    left: eventLogComparisonSide(leftRegistry, leftRead.events),
    ok: problems.length === 0,
    problems,
    right: eventLogComparisonSide(rightRegistry, rightRead.events),
  }
}

export async function verifyPackageStateFromRegistry(
  input: VerifyPackageStateFromRegistryInput,
): Promise<PackageStateVerificationResult> {
  const fetchImpl = input.fetch ?? fetch
  const registry = normalizeRegistryUrl(input.registry)
  const limit = input.limit ?? defaultEventLogPageLimit
  const maxPages = input.maxPages ?? defaultEventLogMaxPages

  try {
    validateEventLogPageLimit(limit)
    validatePositiveInteger(maxPages, 'Event log max pages')
  } catch (error) {
    return {
      checkedEvents: 0,
      ok: false,
      problems: [errorMessage(error)],
    }
  }

  const stateFetch = await fetchPublicJson(
    fetchImpl,
    packageStateUrl(registry, input.packageId),
    'Public package state request',
  )
  if (!stateFetch.ok) {
    return {
      checkedEvents: 0,
      ok: false,
      problems: [stateFetch.problem],
    }
  }

  const stateRead = parsePublicPackageState(stateFetch.value, input.packageId)
  if (!stateRead.state) {
    return {
      checkedEvents: 0,
      ok: false,
      problems: stateRead.problems,
    }
  }

  const state = stateRead.state
  const problems: string[] = []
  const cacheControlProblem = publicMutableJsonCacheControlProblem(
    stateFetch.headers,
    'Public package state response',
  )
  if (cacheControlProblem) {
    problems.push(cacheControlProblem)
  }

  const read = await readPublicEventLog({
    fetch: fetchImpl,
    limit,
    maxPages,
    registry,
  })
  problems.push(...read.problems)

  if (!read.reachedTail && problems.length === 0) {
    problems.push('Public event log verification stopped before reaching tail')
  }

  const packageEvents = read.events.filter((event) => {
    return registryEventPackageId(event) === input.packageId
  })

  if (problems.length === 0) {
    let expectedState: PackageState | undefined
    try {
      expectedState = replayPackageState(packageEvents, input.packageId)
    } catch (error) {
      problems.push(
        `Public package state replay failed: ${errorMessage(error)}`,
      )
    }

    if (expectedState && !sameCanonicalJson(state, expectedState)) {
      problems.push(
        'Public package state does not match public event log replay',
      )
    }

    const etagProblem = publicPackageStateEtagProblem(
      stateFetch.headers,
      packageEvents,
    )
    if (etagProblem) {
      problems.push(etagProblem)
    }
  }

  return {
    checkedEvents: read.events.length,
    ...(read.lastEventId ? { lastEventId: read.lastEventId } : {}),
    ok: problems.length === 0,
    problems,
    state,
  }
}

function eventLogReadVerificationProblems(
  read: PublicEventLogReadResult,
): string[] {
  const problems = [...read.problems]

  if (!read.reachedTail && problems.length === 0) {
    problems.push('Public event log verification stopped before reaching tail')
  }

  if (read.events.length > 0 && problems.length === 0) {
    problems.push(...verifyEventLogReplay(read.events))
  }

  return problems
}

function compareRegistryEventSequences(
  leftEvents: RegistryEvent[],
  rightEvents: RegistryEvent[],
): string[] {
  const checkedEvents = Math.min(leftEvents.length, rightEvents.length)

  for (let index = 0; index < checkedEvents; index += 1) {
    const leftEvent = leftEvents[index]!
    const rightEvent = rightEvents[index]!

    if (leftEvent.id !== rightEvent.id) {
      return [
        `Registry event logs diverge at index ${index}: left ${leftEvent.id}, right ${rightEvent.id}`,
      ]
    }

    if (canonicalJson(leftEvent) !== canonicalJson(rightEvent)) {
      return [
        `Registry event log event bytes differ at index ${index}: ${leftEvent.id}`,
      ]
    }
  }

  if (leftEvents.length !== rightEvents.length) {
    return [
      `Registry event log lengths differ: left has ${leftEvents.length} events, right has ${rightEvents.length} events`,
    ]
  }

  return []
}

function eventLogComparisonSide(
  registry: string,
  events: RegistryEvent[],
): EventLogComparisonSide {
  const packageIds = new Set(
    events.map((event) => registryEventPackageId(event)),
  )
  const lastEventId = events.at(-1)?.id

  return {
    checkedEvents: events.length,
    ...(lastEventId ? { lastEventId } : {}),
    packages: packageIds.size,
    registry,
  }
}

async function readPublicEventLog(input: {
  fetch: typeof fetch
  limit: number
  maxPages: number
  registry: string
}): Promise<PublicEventLogReadResult> {
  const eventIds = new Set<Sha256Digest>()
  const events: RegistryEvent[] = []
  const problems: string[] = []
  let after: Sha256Digest | undefined
  let reachedTail = false

  for (let pageIndex = 0; pageIndex < input.maxPages; pageIndex += 1) {
    const pageFetch = await fetchPublicJson(
      input.fetch,
      eventLogUrl(input.registry, { after, limit: input.limit }),
      'Public event log request',
    )

    if (!pageFetch.ok) {
      problems.push(pageFetch.problem)
      break
    }

    const pageRead = parsePublicEventLogPage(pageFetch.value)
    if (!pageRead.page) {
      problems.push(...pageRead.problems)
      break
    }

    const page = pageRead.page
    if (page.events.length > input.limit) {
      problems.push('Public event log page returned more events than requested')
      break
    }

    const cacheControlProblem = publicEventLogPageCacheControlProblem(
      pageFetch.headers,
    )
    if (cacheControlProblem) {
      problems.push(cacheControlProblem)
      break
    }

    if (page.events.length === 0) {
      if (page.nextAfter) {
        problems.push('Public event log empty page must not include nextAfter')
        break
      }
      const etagProblem = publicEventLogPageEtagProblem(
        pageFetch.headers,
        page,
        after,
      )
      if (etagProblem) {
        problems.push(etagProblem)
        break
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

    const etagProblem = publicEventLogPageEtagProblem(
      pageFetch.headers,
      page,
      after,
    )
    if (etagProblem) {
      problems.push(etagProblem)
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
        fetch: input.fetch,
        registry: input.registry,
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

  return {
    events,
    ...(after ? { lastEventId: after } : {}),
    problems,
    reachedTail,
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

async function fetchPublicCanonicalJson(
  fetchImpl: typeof fetch,
  url: string,
  label: string,
): Promise<PublicJsonFetchResult> {
  try {
    const response = await fetchCanonicalJson(fetchImpl, url)

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

  return etagMatchesOpaqueValue(etag, expectedDigest)
    ? undefined
    : `${label} ETag does not match event id`
}

function publicEventLogPageEtagProblem(
  headers: Headers,
  page: PublicEventLogPage,
  after: Sha256Digest | undefined,
): string | undefined {
  const etag = headers.get('etag')

  if (!etag) {
    return 'Public event log response is missing ETag'
  }

  const validator = page.nextAfter ?? after ?? 'head'
  const expected = `regesta.event-log:${validator}:${page.events.length}`

  return etagMatchesOpaqueValue(etag, expected)
    ? undefined
    : 'Public event log response ETag does not match page cursor'
}

function publicEventLogPageCacheControlProblem(
  headers: Headers,
): string | undefined {
  return publicMutableJsonCacheControlProblem(
    headers,
    'Public event log response',
  )
}

function publicMutableJsonCacheControlProblem(
  headers: Headers,
  label: string,
): string | undefined {
  const cacheControl = headers.get('cache-control')

  if (!cacheControl) {
    return `${label} is missing Cache-Control`
  }

  return cacheControlHas(cacheControl, 'no-cache')
    ? undefined
    : `${label} Cache-Control must include no-cache`
}

function publicRegistryAdapters(input: {
  event: RegistryEvent
  fetch: typeof fetch
  fetchedObjects: Map<Sha256Digest, StoredObject>
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
      get: async (digest) => {
        const object = await fetchObject(
          input.fetch,
          objectUrl(input.registry, digest),
          objectDescriptors.get(digest),
        )
        input.fetchedObjects.set(digest, object)
        return object
      },
      getDescriptor: async (digest) => {
        const descriptor = await fetchObjectDescriptor(
          input.fetch,
          objectUrl(input.registry, digest),
        )
        objectDescriptors.set(digest, descriptor)
        return { ...descriptor }
      },
      listDescriptors: unsupportedWrite('list object descriptors'),
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

function parsePublicStoredReleaseEnvelope(value: unknown):
  | {
      problems: string[]
      release?: undefined
    }
  | {
      problems: []
      release: StoredRelease
    } {
  if (!isRecord(value)) {
    return {
      problems: ['Public release response must be an object'],
    }
  }

  const shallowProblems = publicStoredReleaseEnvelopeProblems(value)
  if (shallowProblems.length > 0) {
    return {
      problems: shallowProblems,
    }
  }

  const record = value
  try {
    return {
      problems: [],
      release: {
        event: parseRegistryEvent(
          record.event,
          'Public release response event',
          {
            verifyId: false,
          },
        ),
        manifest: parseReleaseManifest(
          record.manifest,
          'Public release response manifest',
        ),
        manifestDescriptor: parseObjectDescriptor(
          record.manifestDescriptor,
          'Public release response manifestDescriptor',
        ),
      },
    }
  } catch (error) {
    return {
      problems: [errorMessage(error)],
    }
  }
}

function publicStoredReleaseEnvelopeProblems(value: unknown): string[] {
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

function parsePublicPackageState(
  value: unknown,
  packageId: PackageId,
):
  | {
      problems: string[]
      state?: undefined
    }
  | {
      problems: []
      state: PackageState
    } {
  const problems = publicPackageStateProblems(value, packageId)
  if (problems.length > 0) {
    return { problems }
  }

  try {
    return {
      problems: [],
      state: parsePackageState(value, 'Public package state response'),
    }
  } catch (error) {
    return {
      problems: [errorMessage(error)],
    }
  }
}

function publicPackageStateProblems(
  value: unknown,
  packageId: PackageId,
): string[] {
  const problems: string[] = []

  if (!isRecord(value)) {
    return ['Public package state response must be an object']
  }

  const expected = parsePackageId(packageId)
  const unknownField = Object.keys(value).find(
    (key) =>
      !['channels', 'ecosystem', 'id', 'name', 'object', 'releases'].includes(
        key,
      ),
  )
  if (unknownField) {
    problems.push(
      `Public package state response must not include unknown field: ${unknownField}`,
    )
  }

  if (value.object !== 'regesta.package-state') {
    problems.push(
      'Public package state response object must be regesta.package-state',
    )
  }

  if (value.id !== expected.id) {
    problems.push('Public package state response id does not match package id')
  }

  if (value.ecosystem !== expected.ecosystem) {
    problems.push(
      'Public package state response ecosystem does not match package id',
    )
  }

  if (value.name !== expected.name) {
    problems.push(
      'Public package state response name does not match package id',
    )
  }

  if (value.channels !== undefined) {
    if (isRecord(value.channels)) {
      for (const [channel, version] of Object.entries(value.channels)) {
        if (typeof version !== 'string' || version.length === 0) {
          problems.push(
            `Public package state response channel ${channel} must point to a version`,
          )
        }
      }
    } else {
      problems.push('Public package state response channels must be an object')
    }
  }

  if (Array.isArray(value.releases)) {
    for (const release of value.releases) {
      collectPublicPackageStateReleaseProblems(release, problems)
    }
  } else {
    problems.push('Public package state response releases must be an array')
  }

  return problems
}

function collectPublicPackageStateReleaseProblems(
  value: unknown,
  problems: string[],
): void {
  if (!isRecord(value)) {
    problems.push('Public package state response releases must contain objects')
    return
  }

  const unknownField = Object.keys(value).find(
    (key) => !['createdAt', 'manifestDigest', 'version'].includes(key),
  )
  if (unknownField) {
    problems.push(
      `Public package state response release must not include unknown field: ${unknownField}`,
    )
  }

  if (typeof value.version !== 'string' || value.version.length === 0) {
    problems.push('Public package state response release version is invalid')
  }

  if (typeof value.createdAt !== 'string' || value.createdAt.length === 0) {
    problems.push('Public package state response release createdAt is invalid')
  }

  if (typeof value.manifestDigest === 'string') {
    try {
      assertSha256Digest(value.manifestDigest)
    } catch {
      problems.push(
        'Public package state response release manifestDigest must be a sha256 digest',
      )
    }
  } else {
    problems.push(
      'Public package state response release manifestDigest must be a sha256 digest',
    )
  }
}

function publicPackageStateEtagProblem(
  headers: Headers,
  events: RegistryEvent[],
): string | undefined {
  const lastEvent = events.at(-1)
  if (!lastEvent) {
    return 'Public package state has no matching public event log entries'
  }

  const etag = headers.get('etag')
  if (!etag) {
    return 'Public package state response is missing ETag'
  }

  return etagMatchesOpaqueValue(etag, lastEvent.id)
    ? undefined
    : 'Public package state response ETag does not match last package event id'
}

function parsePublicRegistryEvent(
  value: unknown,
  label: string,
):
  | {
      event: RegistryEvent
      problem?: undefined
    }
  | {
      event?: undefined
      problem: string
    } {
  try {
    const event = parseRegistryEvent(value, label)
    assertRegistryEventIntegrity(event)
    return { event }
  } catch (error) {
    return {
      problem: `${label} is invalid: ${errorMessage(error)}`,
    }
  }
}

async function publicEventEndpointProblem(input: {
  event: RegistryEvent
  fetch: typeof fetch
  registry: string
}): Promise<string | undefined> {
  const eventFetch = await fetchPublicCanonicalJson(
    input.fetch,
    eventUrl(input.registry, input.event.id),
    'Public event endpoint request',
  )

  if (!eventFetch.ok) {
    return eventFetch.problem
  }

  const eventRead = parsePublicRegistryEvent(
    eventFetch.value,
    'Public event endpoint response',
  )
  if (!eventRead.event) {
    return eventRead.problem
  }
  const { event } = eventRead

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
    cache: 'no-store',
    credentials: 'omit',
    headers: {
      accept: 'application/json',
    },
    redirect: 'error',
  })

  if (!response.ok) {
    throw new Error(`Registry request failed: ${response.status} ${url}`)
  }

  validateJsonContentType(response.headers.get('content-type'), url)

  const text = await response.text()
  validateJsonContentLength(url, response, text)

  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    throw new TypeError(`Invalid JSON body: ${url}`, { cause: error })
  }

  return {
    headers: response.headers,
    value,
  }
}

async function fetchCanonicalJson(
  fetchImpl: typeof fetch,
  url: string,
): Promise<{ headers: Headers; value: unknown }> {
  const response = await fetchImpl(url, {
    cache: 'no-store',
    credentials: 'omit',
    headers: {
      accept: 'application/json',
    },
    redirect: 'error',
  })

  if (!response.ok) {
    throw new Error(`Registry request failed: ${response.status} ${url}`)
  }

  validateJsonContentType(response.headers.get('content-type'), url)

  const text = await response.text()
  let value: unknown

  try {
    value = JSON.parse(text)
  } catch (error) {
    throw new TypeError(`Invalid JSON body: ${url}`, { cause: error })
  }

  if (text !== `${canonicalJson(value)}\n`) {
    throw new TypeError(`Response body is not canonical JSON: ${url}`)
  }

  validateCanonicalJsonContentLength(url, response, text)
  validateImmutableCacheControl(url, response)

  return {
    headers: response.headers,
    value,
  }
}

function validateCanonicalJsonContentLength(
  url: string,
  response: Response,
  text: string,
): void {
  const sizeHeader = response.headers.get('content-length')

  if (!sizeHeader) {
    throw new TypeError(`Missing canonical JSON Content-Length header: ${url}`)
  }

  if (
    parseContentLength(sizeHeader, url, 'canonical JSON') !==
    new TextEncoder().encode(text).byteLength
  ) {
    throw new TypeError(
      `Canonical JSON Content-Length does not match body: ${url}`,
    )
  }
}

function validateJsonContentLength(
  url: string,
  response: Response,
  text: string,
): void {
  const sizeHeader = response.headers.get('content-length')

  if (!sizeHeader) {
    throw new TypeError(`Missing JSON Content-Length header: ${url}`)
  }

  if (
    parseContentLength(sizeHeader, url, 'JSON') !==
    new TextEncoder().encode(text).byteLength
  ) {
    throw new TypeError(`JSON Content-Length does not match body: ${url}`)
  }
}

function validateImmutableCacheControl(url: string, response: Response): void {
  const cacheControl = response.headers.get('cache-control')

  if (!cacheControl) {
    throw new TypeError(`Missing immutable JSON Cache-Control header: ${url}`)
  }

  if (!cacheControlHas(cacheControl, 'immutable')) {
    throw new TypeError(
      `Immutable JSON Cache-Control must include immutable: ${url}`,
    )
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
  const response = await fetchImpl(url, {
    cache: 'no-store',
    credentials: 'omit',
    redirect: 'error',
  })

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
    cache: 'no-store',
    credentials: 'omit',
    method: 'HEAD',
    redirect: 'error',
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

  const size = parseContentLength(sizeHeader, url)

  validateObjectCacheControl(url, response)
  validateObjectAcceptRanges(url, response)

  return {
    digest,
    mediaType,
    size,
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

  if (sha256(bytes) !== digest) {
    throw new TypeError(`Public object body digest does not match URL: ${url}`)
  }

  if (!mediaType) {
    throw new TypeError(`Missing object Content-Type header: ${url}`)
  }

  if (mediaType !== descriptor.mediaType) {
    throw new TypeError(`Public object Content-Type mismatch: ${url}`)
  }

  validateObjectCacheControl(url, response)
  validateObjectAcceptRanges(url, response)
}

function validateObjectCacheControl(url: string, response: Response): void {
  const cacheControl = response.headers.get('cache-control')

  if (!cacheControl) {
    throw new TypeError(`Missing object Cache-Control header: ${url}`)
  }

  if (!cacheControlHas(cacheControl, 'immutable')) {
    throw new TypeError(`Object Cache-Control must include immutable: ${url}`)
  }
}

function validateObjectAcceptRanges(url: string, response: Response): void {
  const acceptRanges = response.headers.get('accept-ranges')

  if (!acceptRanges) {
    throw new TypeError(`Missing object Accept-Ranges header: ${url}`)
  }

  if (acceptRanges.trim().toLowerCase() !== 'bytes') {
    throw new TypeError(`Object Accept-Ranges must be bytes: ${url}`)
  }
}

function parseContentLength(
  value: string,
  url: string,
  label = 'object',
): number {
  if (!/^(?:0|[1-9]\d*)$/u.test(value)) {
    throw new TypeError(`Invalid ${label} Content-Length header: ${url}`)
  }

  const size = Number(value)

  if (!Number.isSafeInteger(size)) {
    throw new TypeError(`Invalid ${label} Content-Length header: ${url}`)
  }

  return size
}

function etagMatchesDigest(etag: string, digest: Sha256Digest): boolean {
  return etagMatchesOpaqueValue(etag, digest)
}

function etagMatchesOpaqueValue(etag: string, value: string): boolean {
  return stripWeakEtag(etag.trim()) === `"${value}"`
}

function stripWeakEtag(etag: string): string {
  return etag.startsWith('W/') ? etag.slice(2) : etag
}

function cacheControlHas(value: string, directive: string): boolean {
  return value.split(',').some((part) => {
    const name = part.split('=', 1)[0]?.trim().toLowerCase()
    return name === directive
  })
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

function packageStateUrl(registry: string, packageId: PackageId): string {
  return `${registry}/packages/${encodeURIComponent(packageId)}`
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function sameCanonicalJson(left: unknown, right: unknown): boolean {
  try {
    return canonicalJson(left) === canonicalJson(right)
  } catch {
    return false
  }
}

function parsePublicEventLogPage(value: unknown):
  | {
      page?: undefined
      problems: string[]
    }
  | {
      page: PublicEventLogPage
      problems: []
    } {
  const problems = publicEventLogPageProblems(value)
  if (problems.length > 0) {
    return { problems }
  }

  if (!isRecord(value) || !Array.isArray(value.events)) {
    return {
      problems: ['Public event log response must be an object'],
    }
  }

  const events: RegistryEvent[] = []
  for (const event of value.events) {
    try {
      events.push(parseRegistryEvent(event))
    } catch (error) {
      problems.push(`Public event log event is invalid: ${errorMessage(error)}`)
    }
  }

  if (problems.length > 0) {
    return { problems }
  }

  const nextAfter =
    typeof value.nextAfter === 'string'
      ? assertSha256Digest(value.nextAfter)
      : undefined

  return {
    page: {
      events,
      ...(nextAfter ? { nextAfter } : {}),
    },
    problems: [],
  }
}

function publicEventLogPageProblems(value: unknown): string[] {
  const problems: string[] = []

  if (!isRecord(value)) {
    return ['Public event log response must be an object']
  }

  const unknownField = Object.keys(value).find(
    (key) => !['events', 'nextAfter'].includes(key),
  )
  if (unknownField) {
    problems.push(
      `Public event log response must not include unknown field: ${unknownField}`,
    )
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
