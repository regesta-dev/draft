import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  assertCanonicalTimestamp,
  assertSha256Digest,
  canonicalJson,
  parseObjectDescriptor,
  parseObjectInventoryPage,
  parsePackageId,
  parseRegistryEvent,
  parseReleaseManifest,
  sha256,
  type ObjectDescriptor,
  type ObjectInventoryPage,
  type PackageId,
  type RegistryEvent,
  type ReleaseManifest,
  type Sha256Digest,
} from '@regesta/protocol'
import { normalizeRegistryUrl } from './registry-url.ts'

export interface MirrorRegistryInput {
  fetch?: typeof fetch
  limit?: number
  maxPages?: number
  outputDir: string
  registry: string
}

export interface MirrorRegistryResult {
  events: number
  lastEventId?: Sha256Digest
  mirroredAt: string
  objects: number
  ok: boolean
  outputDir: string
  packages: number
  problems: string[]
  registry: string
  releases: number
}

export interface CompareMirrorDirectoriesInput {
  leftDir: string
  rightDir: string
}

export interface MirrorDirectoryComparisonSide {
  directory: string
  events: number
  lastEventId?: Sha256Digest
  mirroredAt?: string
  objects: number
  ok: boolean
  packages: number
  problems: string[]
  releases: number
}

export interface MirrorDirectoryComparisonResult {
  checkedEvents: number
  checkedObjects: number
  checkedReleases: number
  left: MirrorDirectoryComparisonSide
  ok: boolean
  problems: string[]
  right: MirrorDirectoryComparisonSide
}

interface EventLogPage {
  events: RegistryEvent[]
  nextAfter?: Sha256Digest
}

interface PublicReleaseEnvelope {
  event: RegistryEvent
  manifest: ReleaseManifest
  manifestDescriptor: ObjectDescriptor
}

interface LocalMirrorInventory {
  events: Sha256Digest[]
  kind: 'regesta.local-mirror.inventory'
  lastEventId?: Sha256Digest
  mirroredAt: string
  objects: Sha256Digest[]
  ok: boolean
  packages: PackageId[]
  problems: string[]
  registry: string
  releases: Array<{ id: PackageId; version: string }>
}

interface MirrorFileSet {
  eventValues: Map<Sha256Digest, RegistryEvent>
  events: Map<Sha256Digest, string>
  objects: Set<Sha256Digest>
  releaseEnvelopes: Map<string, PublicReleaseEnvelope>
  releases: Map<string, string>
}

const defaultEventLogPageLimit = 999
const defaultEventLogMaxPages = 1000

export async function mirrorRegistry(
  input: MirrorRegistryInput,
): Promise<MirrorRegistryResult> {
  const fetchImpl = input.fetch ?? fetch
  const registry = normalizeRegistryUrl(input.registry)
  const limit = input.limit ?? defaultEventLogPageLimit
  const maxPages = input.maxPages ?? defaultEventLogMaxPages
  const eventIds: Sha256Digest[] = []
  const acceptedEventIds = new Set<Sha256Digest>()
  const objectDescriptors = new Map<Sha256Digest, ObjectDescriptor>()
  const packageIds = new Set<PackageId>()
  const problems: string[] = []
  const releases: Array<{ id: PackageId; version: string }> = []
  const mirroredAt = new Date().toISOString()
  let after: Sha256Digest | undefined
  let reachedTail = false

  try {
    validateEventLogPageLimit(limit)
    validatePositiveInteger(maxPages, 'Event log max pages')
  } catch (error) {
    return mirrorResult({
      eventIds,
      objectDigests: new Set(objectDescriptors.keys()),
      outputDir: input.outputDir,
      packageIds,
      mirroredAt,
      problems: [errorMessage(error)],
      registry,
      releases,
    })
  }

  for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
    const page = await fetchJsonPage(
      fetchImpl,
      eventLogUrl(registry, { after, limit }),
    )
    if (!page.ok) {
      problems.push(page.problem)
      break
    }

    if (page.value.events.length === 0) {
      if (page.value.nextAfter) {
        problems.push('Mirror event log empty page must not include nextAfter')
        break
      }

      reachedTail = true
      break
    }

    if (page.value.events.length > limit) {
      problems.push('Mirror event log page returned more events than requested')
      break
    }

    const lastEventId = page.value.events.at(-1)?.id
    if (page.value.nextAfter !== lastEventId) {
      problems.push('Mirror event log nextAfter must match last event id')
      break
    }

    for (const event of page.value.events) {
      if (acceptedEventIds.has(event.id)) {
        problems.push(
          `Mirror event log contains duplicate event id: ${event.id}`,
        )
        break
      }

      const eventMirror = await mirrorEvent({
        event,
        fetch: fetchImpl,
        objectDescriptors,
        outputDir: input.outputDir,
        registry,
        releases,
      })

      if (!eventMirror.ok) {
        problems.push(...eventMirror.problems)
        break
      }

      eventIds.push(event.id)
      acceptedEventIds.add(event.id)
      packageIds.add(registryEventPackageId(event))
    }

    if (problems.length > 0) {
      break
    }

    after = page.value.nextAfter
  }

  if (!reachedTail && problems.length === 0) {
    problems.push('Mirror stopped before reaching event log tail')
  }

  if (problems.length === 0) {
    const objectInventoryMirror = await mirrorObjectInventory({
      fetch: fetchImpl,
      limit,
      maxPages,
      objectDescriptors,
      outputDir: input.outputDir,
      registry,
    })

    problems.push(...objectInventoryMirror.problems)
  }

  const result = mirrorResult({
    eventIds,
    lastEventId: eventIds.at(-1),
    objectDigests: new Set(objectDescriptors.keys()),
    outputDir: input.outputDir,
    packageIds,
    mirroredAt,
    problems,
    registry,
    releases,
  })

  await writeCanonicalJsonFile(join(input.outputDir, 'inventory.json'), {
    events: eventIds,
    kind: 'regesta.local-mirror.inventory',
    ...(result.lastEventId ? { lastEventId: result.lastEventId } : {}),
    mirroredAt,
    objects: [...objectDescriptors.keys()].toSorted(),
    ok: result.ok,
    packages: [...packageIds].toSorted(),
    problems,
    registry,
    releases,
  })

  return result
}

export async function compareMirrorDirectories(
  input: CompareMirrorDirectoriesInput,
): Promise<MirrorDirectoryComparisonResult> {
  const [leftRead, rightRead] = await Promise.all([
    readLocalMirrorInventory(input.leftDir, 'Left mirror'),
    readLocalMirrorInventory(input.rightDir, 'Right mirror'),
  ])
  const problems = [...leftRead.problems, ...rightRead.problems]
  const leftInventory = leftRead.inventory
  const rightInventory = rightRead.inventory

  if (!leftInventory || !rightInventory) {
    return mirrorDirectoryComparisonResult({
      leftDir: input.leftDir,
      leftFiles: emptyMirrorFileSet(),
      leftInventory,
      problems,
      rightDir: input.rightDir,
      rightFiles: emptyMirrorFileSet(),
      rightInventory,
    })
  }

  problems.push(
    ...compareStringLists(
      'Mirror event inventory',
      leftInventory.events,
      rightInventory.events,
    ),
    ...compareStringLists(
      'Mirror object inventory',
      leftInventory.objects,
      rightInventory.objects,
    ),
    ...compareStringLists(
      'Mirror package inventory',
      leftInventory.packages,
      rightInventory.packages,
    ),
    ...compareStringLists(
      'Mirror release inventory',
      leftInventory.releases.map(releaseKey),
      rightInventory.releases.map(releaseKey),
    ),
  )

  const [leftFiles, rightFiles] = await Promise.all([
    readMirrorFiles(input.leftDir, leftInventory, 'Left mirror'),
    readMirrorFiles(input.rightDir, rightInventory, 'Right mirror'),
  ])
  problems.push(...leftFiles.problems, ...rightFiles.problems)

  if (problems.length === 0) {
    problems.push(
      ...compareFileMap(
        'Mirror event',
        leftFiles.files.events,
        rightFiles.files.events,
      ),
      ...compareFileMap(
        'Mirror release',
        leftFiles.files.releases,
        rightFiles.files.releases,
      ),
    )
  }

  return mirrorDirectoryComparisonResult({
    leftDir: input.leftDir,
    leftFiles: leftFiles.files,
    leftInventory,
    problems,
    rightDir: input.rightDir,
    rightFiles: rightFiles.files,
    rightInventory,
  })
}

async function mirrorEvent(input: {
  event: RegistryEvent
  fetch: typeof fetch
  objectDescriptors: Map<Sha256Digest, ObjectDescriptor>
  outputDir: string
  registry: string
  releases: Array<{ id: PackageId; version: string }>
}): Promise<{ ok: boolean; problems: string[] }> {
  const eventFetch = await fetchCanonicalJson(
    input.fetch,
    eventUrl(input.registry, input.event.id),
    parseRegistryEvent,
  )
  if (!eventFetch.ok) {
    return eventFetch
  }

  if (canonicalJson(eventFetch.value) !== canonicalJson(input.event)) {
    return {
      ok: false,
      problems: ['Mirror event endpoint does not match event log entry'],
    }
  }

  if (input.event.eventType !== 'release.published') {
    await writeCanonicalJsonFile(
      eventFilePath(input.outputDir, input.event.id),
      input.event,
    )
    return { ok: true, problems: [] }
  }

  const releaseFetch = await fetchCanonicalJson(
    input.fetch,
    releaseUrl(
      input.registry,
      input.event.release.id,
      input.event.release.version,
    ),
    parsePublicReleaseEnvelope,
  )
  if (!releaseFetch.ok) {
    return releaseFetch
  }

  const release = releaseFetch.value
  const consistencyProblems = releaseEnvelopeConsistencyProblems(
    release,
    input.event,
  )
  if (consistencyProblems.length > 0) {
    return {
      ok: false,
      problems: consistencyProblems,
    }
  }

  const fetchedObjects: Array<{
    bytes: Uint8Array
    descriptor: ObjectDescriptor
  }> = []

  for (const descriptor of releaseObjectDescriptors(release)) {
    const descriptorProblem = objectDescriptorConflict(
      input.objectDescriptors,
      descriptor,
    )
    if (descriptorProblem) {
      return {
        ok: false,
        problems: [descriptorProblem],
      }
    }

    if (input.objectDescriptors.has(descriptor.digest)) {
      continue
    }

    const objectFetch = await fetchObject(
      input.fetch,
      input.registry,
      descriptor,
    )
    if (!objectFetch.ok) {
      return objectFetch
    }

    fetchedObjects.push({
      bytes: objectFetch.bytes,
      descriptor,
    })
  }

  await writeCanonicalJsonFile(
    eventFilePath(input.outputDir, input.event.id),
    input.event,
  )
  await writeCanonicalJsonFile(
    releaseFilePath(
      input.outputDir,
      input.event.release.id,
      input.event.release.version,
    ),
    release,
  )

  for (const { bytes, descriptor } of fetchedObjects) {
    await writeBinaryFile(
      objectFilePath(input.outputDir, descriptor.digest),
      bytes,
    )
    input.objectDescriptors.set(descriptor.digest, descriptor)
  }

  input.releases.push({
    id: input.event.release.id,
    version: input.event.release.version,
  })

  return { ok: true, problems: [] }
}

async function mirrorObjectInventory(input: {
  fetch: typeof fetch
  limit: number
  maxPages: number
  objectDescriptors: Map<Sha256Digest, ObjectDescriptor>
  outputDir: string
  registry: string
}): Promise<{ problems: string[] }> {
  const problems: string[] = []
  let after: Sha256Digest | undefined
  let reachedTail = false

  for (let pageIndex = 0; pageIndex < input.maxPages; pageIndex += 1) {
    const page = await fetchObjectInventoryPage(
      input.fetch,
      objectInventoryUrl(input.registry, { after, limit: input.limit }),
    )
    if (!page.ok) {
      problems.push(page.problem)
      break
    }

    if (page.value.objects.length === 0) {
      if (page.value.nextAfter) {
        problems.push(
          'Mirror object inventory empty page must not include nextAfter',
        )
        break
      }

      reachedTail = true
      break
    }

    if (page.value.objects.length > input.limit) {
      problems.push(
        'Mirror object inventory page returned more objects than requested',
      )
      break
    }

    const lastObjectDigest = page.value.objects.at(-1)?.digest
    if (page.value.nextAfter !== lastObjectDigest) {
      problems.push(
        'Mirror object inventory nextAfter must match last object digest',
      )
      break
    }

    const orderProblem = objectInventoryOrderProblem(after, page.value.objects)
    if (orderProblem) {
      problems.push(orderProblem)
      break
    }

    for (const descriptor of page.value.objects) {
      const descriptorProblem = objectDescriptorConflict(
        input.objectDescriptors,
        descriptor,
      )
      if (descriptorProblem) {
        problems.push(descriptorProblem)
        break
      }

      if (input.objectDescriptors.has(descriptor.digest)) {
        continue
      }

      const objectFetch = await fetchObject(
        input.fetch,
        input.registry,
        descriptor,
      )
      if (!objectFetch.ok) {
        problems.push(...objectFetch.problems)
        break
      }

      await writeBinaryFile(
        objectFilePath(input.outputDir, descriptor.digest),
        objectFetch.bytes,
      )
      input.objectDescriptors.set(descriptor.digest, descriptor)
    }

    if (problems.length > 0) {
      break
    }

    after = page.value.nextAfter
  }

  if (!reachedTail && problems.length === 0) {
    problems.push('Mirror stopped before reaching object inventory tail')
  }

  return { problems }
}

function objectInventoryOrderProblem(
  after: Sha256Digest | undefined,
  descriptors: ObjectDescriptor[],
): string | undefined {
  let previous = after

  for (const descriptor of descriptors) {
    if (previous && descriptor.digest <= previous) {
      return 'Mirror object inventory page must be strictly ordered by digest'
    }

    previous = descriptor.digest
  }

  return undefined
}

async function readLocalMirrorInventory(
  directory: string,
  label: string,
): Promise<{ inventory?: LocalMirrorInventory; problems: string[] }> {
  try {
    const value: unknown = JSON.parse(
      await readFile(join(directory, 'inventory.json'), 'utf8'),
    )

    return {
      inventory: parseLocalMirrorInventory(value, label),
      problems: [],
    }
  } catch (error) {
    return {
      problems: [`${label} inventory read failed: ${errorMessage(error)}`],
    }
  }
}

async function readMirrorFiles(
  directory: string,
  inventory: LocalMirrorInventory,
  label: string,
): Promise<{ files: MirrorFileSet; problems: string[] }> {
  const files = emptyMirrorFileSet()
  const problems: string[] = []

  for (const eventId of inventory.events) {
    const path = eventFilePath(directory, eventId)
    try {
      const text = await readFile(path, 'utf8')
      const event = parseRegistryEvent(JSON.parse(text))
      if (event.id !== eventId) {
        problems.push(`${label} event file id does not match path: ${eventId}`)
      }
      if (`${canonicalJson(event)}\n` !== text) {
        problems.push(`${label} event file is not canonical JSON: ${eventId}`)
      }
      files.eventValues.set(eventId, event)
      files.events.set(eventId, text)
    } catch (error) {
      problems.push(
        `${label} event file read failed: ${eventId}: ${errorMessage(error)}`,
      )
    }
  }

  for (const release of inventory.releases) {
    const key = releaseKey(release)
    const path = releaseFilePath(directory, release.id, release.version)
    try {
      const text = await readFile(path, 'utf8')
      const envelope = parsePublicReleaseEnvelope(JSON.parse(text))
      if (envelope.manifest.id !== release.id) {
        problems.push(
          `${label} release file id does not match inventory: ${key}`,
        )
      }
      if (envelope.manifest.version !== release.version) {
        problems.push(
          `${label} release file version does not match inventory: ${key}`,
        )
      }
      if (`${canonicalJson(envelope)}\n` !== text) {
        problems.push(`${label} release file is not canonical JSON: ${key}`)
      }
      files.releaseEnvelopes.set(key, envelope)
      files.releases.set(key, text)
    } catch (error) {
      problems.push(
        `${label} release file read failed: ${key}: ${errorMessage(error)}`,
      )
    }
  }

  for (const digest of inventory.objects) {
    try {
      const bytes = new Uint8Array(
        await readFile(objectFilePath(directory, digest)),
      )
      if (sha256(bytes) !== digest) {
        problems.push(`${label} object bytes do not match digest: ${digest}`)
      }
      files.objects.add(digest)
    } catch (error) {
      problems.push(
        `${label} object read failed: ${digest}: ${errorMessage(error)}`,
      )
    }
  }

  problems.push(...localMirrorConsistencyProblems(label, inventory, files))

  return { files, problems }
}

function localMirrorConsistencyProblems(
  label: string,
  inventory: LocalMirrorInventory,
  files: MirrorFileSet,
): string[] {
  const problems: string[] = []

  for (const release of inventory.releases) {
    const key = releaseKey(release)
    const envelope = files.releaseEnvelopes.get(key)
    if (!envelope) {
      continue
    }

    const event = files.eventValues.get(envelope.event.id)
    if (event) {
      for (const problem of releaseEnvelopeConsistencyProblems(
        envelope,
        event,
      )) {
        problems.push(
          `${label} release file is inconsistent with event: ${key}: ${problem}`,
        )
      }
    } else {
      problems.push(`${label} release event is missing from mirror: ${key}`)
    }

    for (const descriptor of releaseObjectDescriptors(envelope)) {
      if (!files.objects.has(descriptor.digest)) {
        problems.push(
          `${label} release object is missing from mirror: ${key}: ${descriptor.digest}`,
        )
      }
    }
  }

  return problems
}

function releaseEnvelopeConsistencyProblems(
  release: PublicReleaseEnvelope,
  event: RegistryEvent,
): string[] {
  const problems: string[] = []

  if (event.eventType !== 'release.published') {
    return ['Mirror release envelope can only be checked for publish events']
  }

  if (release.event.id !== event.id) {
    problems.push('Mirror release event id does not match publish event')
  } else if (canonicalJson(release.event) !== canonicalJson(event)) {
    problems.push('Mirror release event does not match publish event')
  }

  if (release.manifest.id !== event.release.id) {
    problems.push('Mirror release manifest id does not match publish event')
  }
  if (release.manifest.version !== event.release.version) {
    problems.push(
      'Mirror release manifest version does not match publish event',
    )
  }
  if (release.manifestDescriptor.digest !== event.release.manifestDigest) {
    problems.push(
      'Mirror release manifestDescriptor digest does not match publish event',
    )
  }
  if (
    sha256(canonicalJson(release.manifest)) !==
    release.manifestDescriptor.digest
  ) {
    problems.push(
      'Mirror release manifest digest does not match manifestDescriptor',
    )
  }
  if (release.manifest.source.digest !== event.sourceDigest) {
    problems.push('Mirror release source digest does not match publish event')
  }
  if (
    !sameStringArray(
      release.manifest.artifacts.map((artifact) => artifact.digest),
      event.artifactDigests,
    )
  ) {
    problems.push('Mirror release artifact digests do not match publish event')
  }

  return problems
}

function parseLocalMirrorInventory(
  value: unknown,
  label: string,
): LocalMirrorInventory {
  if (!isRecord(value)) {
    throw new TypeError(`${label} inventory must be an object`)
  }
  if (value.kind !== 'regesta.local-mirror.inventory') {
    throw new TypeError(
      `${label} inventory kind must be regesta.local-mirror.inventory`,
    )
  }
  assertKnownFields(
    value,
    [
      'events',
      'kind',
      'lastEventId',
      'mirroredAt',
      'objects',
      'ok',
      'packages',
      'problems',
      'registry',
      'releases',
    ],
    `${label} inventory`,
  )

  const events = readDigestArray(value.events, `${label} inventory events`)
  const lastEventId =
    value.lastEventId === undefined
      ? undefined
      : assertSha256Digest(
          readString(value.lastEventId, `${label} inventory lastEventId`),
        )
  const objects = readDigestArray(value.objects, `${label} inventory objects`)
  const packages = readPackageIdArray(
    value.packages,
    `${label} inventory packages`,
  )
  const releases = readInventoryReleases(
    value.releases,
    `${label} inventory releases`,
  )
  assertUniqueStrings(events, `${label} inventory events`)
  assertSortedUniqueStrings(objects, `${label} inventory objects`)
  assertSortedUniqueStrings(packages, `${label} inventory packages`)
  assertUniqueStrings(
    releases.map((release) => releaseKey(release)),
    `${label} inventory releases`,
  )
  assertLastEventId(events, lastEventId, `${label} inventory lastEventId`)
  const ok = readBoolean(value.ok, `${label} inventory ok`)
  const problems = readStringArray(
    value.problems,
    `${label} inventory problems`,
  )
  assertInventoryProblemState(ok, problems, `${label} inventory`)

  return {
    events,
    kind: 'regesta.local-mirror.inventory',
    ...(lastEventId ? { lastEventId } : {}),
    mirroredAt: assertCanonicalTimestamp(
      readString(value.mirroredAt, `${label} inventory mirroredAt`),
      `${label} inventory mirroredAt`,
    ),
    objects,
    ok,
    packages,
    problems,
    registry: readString(value.registry, `${label} inventory registry`),
    releases,
  }
}

function assertInventoryProblemState(
  ok: boolean,
  problems: readonly string[],
  label: string,
): void {
  if (ok !== (problems.length === 0)) {
    throw new TypeError(`${label} ok must match problems`)
  }
}

function assertLastEventId(
  events: readonly Sha256Digest[],
  lastEventId: Sha256Digest | undefined,
  label: string,
): void {
  if (lastEventId !== events.at(-1)) {
    throw new TypeError(`${label} must match final event id`)
  }
}

function assertUniqueStrings<Value extends string>(
  values: readonly Value[],
  label: string,
): void {
  const seen = new Set<Value>()

  for (const value of values) {
    if (seen.has(value)) {
      throw new TypeError(`${label} must be unique`)
    }

    seen.add(value)
  }
}

function assertSortedUniqueStrings<Value extends string>(
  values: readonly Value[],
  label: string,
): void {
  for (let index = 1; index < values.length; index += 1) {
    if (values[index]! <= values[index - 1]!) {
      throw new TypeError(`${label} must be sorted and unique`)
    }
  }
}

function assertKnownFields(
  record: Record<string, unknown>,
  knownFields: string[],
  label: string,
): void {
  const known = new Set(knownFields)
  const unknown = Object.keys(record).find((key) => {
    return !known.has(key)
  })

  if (unknown) {
    throw new TypeError(`${label} must not include unknown field: ${unknown}`)
  }
}

function readDigestArray(value: unknown, label: string): Sha256Digest[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`${label} must be an array`)
  }

  return value.map((item, index) => {
    return assertSha256Digest(readString(item, `${label}[${index}]`))
  })
}

function readPackageIdArray(value: unknown, label: string): PackageId[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`${label} must be an array`)
  }

  return value.map((item, index) => {
    return parsePackageId(readString(item, `${label}[${index}]`)).id
  })
}

function readInventoryReleases(
  value: unknown,
  label: string,
): Array<{ id: PackageId; version: string }> {
  if (!Array.isArray(value)) {
    throw new TypeError(`${label} must be an array`)
  }

  return value.map((item, index) => {
    if (!isRecord(item)) {
      throw new TypeError(`${label}[${index}] must be an object`)
    }
    assertKnownFields(item, ['id', 'version'], `${label}[${index}]`)

    return {
      id: parsePackageId(readString(item.id, `${label}[${index}].id`)).id,
      version: readString(item.version, `${label}[${index}].version`),
    }
  })
}

function releaseObjectDescriptors(
  release: PublicReleaseEnvelope,
): ObjectDescriptor[] {
  return [
    release.manifestDescriptor,
    release.manifest.source,
    ...release.manifest.artifacts,
  ]
}

function objectDescriptorConflict(
  descriptors: ReadonlyMap<Sha256Digest, ObjectDescriptor>,
  descriptor: ObjectDescriptor,
): string | undefined {
  const existing = descriptors.get(descriptor.digest)
  if (!existing) {
    return undefined
  }

  if (
    existing.mediaType === descriptor.mediaType &&
    existing.size === descriptor.size
  ) {
    return undefined
  }

  return `Mirror object descriptor conflict: ${descriptor.digest}`
}

async function fetchJson<T>(
  fetchImpl: typeof fetch,
  url: string,
  parse: (value: unknown) => T,
): Promise<{ ok: true; value: T } | { ok: false; problems: string[] }> {
  try {
    const response = await fetchImpl(
      url,
      isolatedRequestInit('application/json'),
    )
    if (!response.ok) {
      throw new Error(`Registry request failed: ${response.status} ${url}`)
    }

    const text = await response.text()
    validateJsonContentType(response.headers.get('content-type'), url)
    validateJsonContentLength(url, response, text)
    const value: unknown = JSON.parse(text)

    return {
      ok: true,
      value: parse(value),
    }
  } catch (error) {
    return {
      ok: false,
      problems: [`Mirror JSON request failed: ${errorMessage(error)}`],
    }
  }
}

async function fetchCanonicalJson<T>(
  fetchImpl: typeof fetch,
  url: string,
  parse: (value: unknown) => T,
): Promise<{ ok: true; value: T } | { ok: false; problems: string[] }> {
  try {
    const response = await fetchImpl(
      url,
      isolatedRequestInit('application/json'),
    )
    if (!response.ok) {
      throw new Error(`Registry request failed: ${response.status} ${url}`)
    }

    const text = await response.text()
    validateJsonContentType(response.headers.get('content-type'), url)
    const value: unknown = JSON.parse(text)

    if (text !== `${canonicalJson(value)}\n`) {
      throw new TypeError(`Response body is not canonical JSON: ${url}`)
    }

    validateCanonicalJsonContentLength(url, response, text)
    validateImmutableCacheControl(url, response)

    return {
      ok: true,
      value: parse(value),
    }
  } catch (error) {
    return {
      ok: false,
      problems: [`Mirror JSON request failed: ${errorMessage(error)}`],
    }
  }
}

async function fetchJsonPage(
  fetchImpl: typeof fetch,
  url: string,
): Promise<{ ok: true; value: EventLogPage } | { ok: false; problem: string }> {
  const result = await fetchJson(fetchImpl, url, parseEventLogPage)

  return result.ok ? result : { ok: false, problem: result.problems.join('; ') }
}

async function fetchObjectInventoryPage(
  fetchImpl: typeof fetch,
  url: string,
): Promise<
  { ok: true; value: ObjectInventoryPage } | { ok: false; problem: string }
> {
  const result = await fetchJson(fetchImpl, url, (value) => {
    return parseObjectInventoryPage(value, 'Mirror object inventory')
  })

  return result.ok ? result : { ok: false, problem: result.problems.join('; ') }
}

async function fetchObject(
  fetchImpl: typeof fetch,
  registry: string,
  descriptor: ObjectDescriptor,
): Promise<
  { bytes: Uint8Array; ok: true } | { ok: false; problems: string[] }
> {
  const url = objectUrl(registry, descriptor.digest)

  try {
    const response = await fetchImpl(
      url,
      isolatedRequestInit(descriptor.mediaType),
    )
    if (!response.ok) {
      throw new Error(`Registry request failed: ${response.status} ${url}`)
    }

    const bytes = new Uint8Array(await response.arrayBuffer())
    validateObjectResponseMetadata(url, response, bytes, descriptor)
    if (bytes.byteLength !== descriptor.size) {
      throw new Error(
        `Object size does not match descriptor: ${descriptor.digest}`,
      )
    }
    if (sha256(bytes) !== descriptor.digest) {
      throw new Error(
        `Object bytes digest does not match descriptor: ${descriptor.digest}`,
      )
    }

    return { bytes, ok: true }
  } catch (error) {
    return {
      ok: false,
      problems: [`Mirror object request failed: ${errorMessage(error)}`],
    }
  }
}

function validateObjectResponseMetadata(
  url: string,
  response: Response,
  bytes: Uint8Array,
  descriptor: ObjectDescriptor,
): void {
  const sizeHeader = response.headers.get('content-length')
  if (!sizeHeader) {
    throw new Error(`Missing object Content-Length header: ${url}`)
  }
  if (parseContentLength(sizeHeader, url, 'object') !== bytes.byteLength) {
    throw new Error(`Object Content-Length does not match body: ${url}`)
  }

  const mediaType = response.headers.get('content-type')
  if (!mediaType) {
    throw new Error(`Missing object Content-Type header: ${descriptor.digest}`)
  }
  if (mediaType !== descriptor.mediaType) {
    throw new Error(`Object Content-Type mismatch: ${descriptor.digest}`)
  }

  const cacheControl = response.headers.get('cache-control')
  if (!cacheControl) {
    throw new Error(`Missing object Cache-Control header: ${descriptor.digest}`)
  }
  if (!cacheControlHas(cacheControl, 'immutable')) {
    throw new Error(
      `Object Cache-Control must include immutable: ${descriptor.digest}`,
    )
  }
}

function isolatedRequestInit(accept: string): RequestInit {
  return {
    cache: 'no-store',
    credentials: 'omit',
    headers: { accept },
    redirect: 'error',
  }
}

function parseEventLogPage(value: unknown): EventLogPage {
  if (!isRecord(value)) {
    throw new TypeError('Mirror event log page must be an object')
  }

  const unknownField = Object.keys(value).find((key) => {
    return !['events', 'nextAfter'].includes(key)
  })
  if (unknownField) {
    throw new TypeError(
      `Mirror event log page must not include unknown field: ${unknownField}`,
    )
  }

  if (!Array.isArray(value.events)) {
    throw new TypeError('Mirror event log page events must be an array')
  }

  const events = value.events.map((event, index) => {
    return parseRegistryEvent(event, `Mirror event log page events[${index}]`)
  })
  const nextAfter =
    value.nextAfter === undefined
      ? undefined
      : assertSha256Digest(readString(value.nextAfter, 'Mirror nextAfter'))

  return {
    events,
    ...(nextAfter ? { nextAfter } : {}),
  }
}

function parsePublicReleaseEnvelope(value: unknown): PublicReleaseEnvelope {
  if (!isRecord(value)) {
    throw new TypeError('Mirror release response must be an object')
  }

  return {
    event: parseRegistryEvent(value.event),
    manifest: parseReleaseManifest(value.manifest),
    manifestDescriptor: parseObjectDescriptor(
      value.manifestDescriptor,
      'Mirror release manifestDescriptor',
    ),
  }
}

function readString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`)
  }

  return value
}

function readBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') {
    throw new TypeError(`${label} must be a boolean`)
  }

  return value
}

function readStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`${label} must be an array`)
  }

  return value.map((item, index) => {
    return readString(item, `${label}[${index}]`)
  })
}

function registryEventPackageId(event: RegistryEvent): PackageId {
  switch (event.eventType) {
    case 'channel.deleted':
    case 'channel.updated':
      return event.package
    case 'release.published':
      return event.release.id
  }
}

function mirrorResult(input: {
  eventIds: Sha256Digest[]
  lastEventId?: Sha256Digest
  objectDigests: ReadonlySet<Sha256Digest>
  outputDir: string
  packageIds: ReadonlySet<PackageId>
  mirroredAt: string
  problems: string[]
  registry: string
  releases: ReadonlyArray<{ id: PackageId; version: string }>
}): MirrorRegistryResult {
  return {
    events: input.eventIds.length,
    ...(input.lastEventId ? { lastEventId: input.lastEventId } : {}),
    mirroredAt: input.mirroredAt,
    objects: input.objectDigests.size,
    ok: input.problems.length === 0,
    outputDir: input.outputDir,
    packages: input.packageIds.size,
    problems: input.problems,
    registry: input.registry,
    releases: input.releases.length,
  }
}

function mirrorDirectoryComparisonResult(input: {
  leftDir: string
  leftFiles: MirrorFileSet
  leftInventory: LocalMirrorInventory | undefined
  problems: string[]
  rightDir: string
  rightFiles: MirrorFileSet
  rightInventory: LocalMirrorInventory | undefined
}): MirrorDirectoryComparisonResult {
  return {
    checkedEvents: Math.min(
      input.leftFiles.events.size,
      input.rightFiles.events.size,
    ),
    checkedObjects: Math.min(
      input.leftFiles.objects.size,
      input.rightFiles.objects.size,
    ),
    checkedReleases: Math.min(
      input.leftFiles.releases.size,
      input.rightFiles.releases.size,
    ),
    left: mirrorDirectoryComparisonSide(input.leftDir, input.leftInventory),
    ok: input.problems.length === 0,
    problems: input.problems,
    right: mirrorDirectoryComparisonSide(input.rightDir, input.rightInventory),
  }
}

function mirrorDirectoryComparisonSide(
  directory: string,
  inventory: LocalMirrorInventory | undefined,
): MirrorDirectoryComparisonSide {
  return {
    directory,
    events: inventory?.events.length ?? 0,
    ...(inventory?.lastEventId ? { lastEventId: inventory.lastEventId } : {}),
    ...(inventory?.mirroredAt ? { mirroredAt: inventory.mirroredAt } : {}),
    objects: inventory?.objects.length ?? 0,
    ok: inventory?.ok ?? false,
    packages: inventory?.packages.length ?? 0,
    problems: inventory?.problems ?? [],
    releases: inventory?.releases.length ?? 0,
  }
}

function emptyMirrorFileSet(): MirrorFileSet {
  return {
    eventValues: new Map(),
    events: new Map(),
    objects: new Set(),
    releaseEnvelopes: new Map(),
    releases: new Map(),
  }
}

async function writeCanonicalJsonFile(
  path: string,
  value: unknown,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${canonicalJson(value)}\n`)
}

async function writeBinaryFile(path: string, bytes: Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, bytes)
}

function eventFilePath(outputDir: string, digest: Sha256Digest): string {
  const { algorithm, hex } = digestParts(digest)
  return join(outputDir, 'events', algorithm, `${hex}.json`)
}

function releaseFilePath(
  outputDir: string,
  packageId: PackageId,
  version: string,
): string {
  return join(
    outputDir,
    'releases',
    encodeURIComponent(packageId),
    `${encodeURIComponent(version)}.json`,
  )
}

function objectFilePath(outputDir: string, digest: Sha256Digest): string {
  const { algorithm, hex } = digestParts(digest)
  return join(outputDir, 'objects', algorithm, hex)
}

function compareStringLists(
  label: string,
  left: string[],
  right: string[],
): string[] {
  const checked = Math.min(left.length, right.length)

  for (let index = 0; index < checked; index += 1) {
    if (left[index] !== right[index]) {
      return [
        `${label} differs at index ${index}: left ${left[index]}, right ${right[index]}`,
      ]
    }
  }

  return left.length === right.length
    ? []
    : [`${label} length differs: left ${left.length}, right ${right.length}`]
}

function compareFileMap(
  label: string,
  left: ReadonlyMap<string, string>,
  right: ReadonlyMap<string, string>,
): string[] {
  for (const [key, leftValue] of left) {
    const rightValue = right.get(key)
    if (rightValue === undefined) {
      return [`${label} missing from right mirror: ${key}`]
    }
    if (leftValue !== rightValue) {
      return [`${label} file differs: ${key}`]
    }
  }

  for (const key of right.keys()) {
    if (!left.has(key)) {
      return [`${label} missing from left mirror: ${key}`]
    }
  }

  return []
}

function releaseKey(release: { id: PackageId; version: string }): string {
  return `${release.id}@${release.version}`
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
  options: { after: Sha256Digest | undefined; limit: number },
): string {
  const url = new URL(`${registry}/events`)
  if (options.after) {
    url.searchParams.set('after', options.after)
  }
  url.searchParams.set('limit', String(options.limit))
  return url.href
}

function objectInventoryUrl(
  registry: string,
  options: { after: Sha256Digest | undefined; limit: number },
): string {
  const url = new URL(`${registry}/objects`)
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

function digestParts(digest: Sha256Digest): { algorithm: string; hex: string } {
  const [algorithm, hex] = digest.split(':')

  return {
    algorithm: algorithm!,
    hex: hex!,
  }
}

function validateEventLogPageLimit(limit: number): void {
  validatePositiveInteger(limit, 'Event log page limit')
  if (limit > 999) {
    throw new TypeError('Event log page limit must be at most 999')
  }
}

function validatePositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`)
  }
}

function cacheControlHas(value: string, directive: string): boolean {
  return value.split(',').some((part) => {
    const name = part.split('=', 1)[0]?.trim().toLowerCase()
    return name === directive
  })
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

function parseContentLength(value: string, url: string, label: string): number {
  if (!/^(?:0|[1-9]\d*)$/u.test(value)) {
    throw new TypeError(`Invalid ${label} Content-Length header: ${url}`)
  }

  const size = Number(value)

  if (!Number.isSafeInteger(size)) {
    throw new TypeError(`Invalid ${label} Content-Length header: ${url}`)
  }

  return size
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function sameStringArray(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  )
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
