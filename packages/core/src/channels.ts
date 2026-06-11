import {
  assertCanonicalTimestamp,
  assertPackageChannel,
  assertPackageVersion,
  parsePackageId,
  registryEventDigest,
  type ChannelDeletedEvent,
  type ChannelUpdatedEvent,
  type PackageId,
  type PackageState,
  type PackageStateRelease,
  type RegistryEvent,
  type WriteAuthorizationProof,
} from '@regesta/protocol'
import { assertRegistryEventIntegrity } from './events.ts'
import { enqueueDerivedRegistryJob } from './queue.ts'
import {
  RegistryEventIntegrityError,
  ReleaseNotFoundError,
  type RegistryAdapters,
} from './storage.ts'
import { assertWriteAuthorizationIsFresh } from './write-authorization.ts'

export interface ChannelMutationResult {
  event: ChannelDeletedEvent | ChannelUpdatedEvent
  previousVersion?: string
}

export function replayPackageState(
  events: Iterable<RegistryEvent>,
  packageId: PackageId,
): PackageState {
  const parsed = parsePackageId(packageId)
  const releases = new Map<string, PackageStateRelease>()
  const channels: Record<string, string> = {}

  for (const event of events) {
    assertRegistryEventIntegrity(event)

    if (eventPackageId(event) !== packageId) {
      continue
    }

    switch (event.eventType) {
      case 'release.published': {
        if (releases.has(event.release.version)) {
          throw new RegistryEventIntegrityError(
            `Registry event release version already exists: ${event.release.version}`,
          )
        }

        releases.set(event.release.version, {
          createdAt: event.timestamp,
          manifestDigest: event.release.manifestDigest,
          version: event.release.version,
        })
        channels[event.channel] = event.release.version
        break
      }
      case 'channel.updated': {
        assertReplayReleaseExists(releases, event.version)
        assertReplayPreviousVersion(event, channels[event.channel])
        channels[event.channel] = event.version
        break
      }
      case 'channel.deleted': {
        assertReplayPreviousVersion(event, channels[event.channel])
        delete channels[event.channel]
        break
      }
    }
  }

  return {
    ...(Object.keys(channels).length === 0 ? {} : { channels }),
    ecosystem: parsed.ecosystem,
    id: packageId,
    name: parsed.name,
    object: 'regesta.package-state',
    releases: [...releases.values()].toSorted((left, right) =>
      left.createdAt.localeCompare(right.createdAt),
    ),
  }
}

export async function getPackageState(
  adapters: RegistryAdapters,
  packageId: PackageId,
): Promise<PackageState> {
  return (await adapters.database.getPackageEventState(packageId)).state
}

export async function getPackageChannelVersion(
  adapters: RegistryAdapters,
  packageId: PackageId,
  channel: string,
): Promise<string | undefined> {
  assertPackageChannel(channel)
  return (await adapters.database.getPackageChannels(packageId))[channel]
}

function eventPackageId(event: RegistryEvent): PackageId {
  return event.eventType === 'release.published'
    ? event.release.id
    : event.package
}

function assertReplayReleaseExists(
  releases: ReadonlyMap<string, PackageStateRelease>,
  version: string,
): void {
  assertPackageVersion(version, 'Registry event version')

  if (!releases.has(version)) {
    throw new RegistryEventIntegrityError(
      `Registry event channel target version does not exist: ${version}`,
    )
  }
}

function assertReplayPreviousVersion(
  event: ChannelDeletedEvent | ChannelUpdatedEvent,
  actualVersion: string | undefined,
): void {
  if (event.previousVersion !== actualVersion) {
    throw new RegistryEventIntegrityError(
      `Registry event previousVersion does not match replayed channel state: ${event.package}#${event.channel}`,
    )
  }
}

export async function updatePackageChannel(
  adapters: RegistryAdapters,
  input: {
    authorization?: WriteAuthorizationProof
    channel: string
    packageId: PackageId
    previousVersion?: string
    timestamp?: string
    version: string
  },
): Promise<ChannelMutationResult> {
  assertPackageChannel(input.channel)
  assertPackageVersion(input.version)
  await assertWriteAuthorizationIsFresh(adapters, input.authorization)
  const timestamp = channelMutationTimestamp(input)

  const release = await adapters.database.getRelease(
    input.packageId,
    input.version,
  )

  if (!release) {
    throw new ReleaseNotFoundError(input.packageId, input.version)
  }

  const previousVersion = await channelMutationPreviousVersion(adapters, input)
  const eventWithoutId = {
    ...(input.authorization ? { authorization: input.authorization } : {}),
    channel: input.channel,
    eventType: 'channel.updated',
    object: 'regesta.event',
    package: input.packageId,
    ...(previousVersion ? { previousVersion } : {}),
    timestamp,
    version: input.version,
  } satisfies Omit<ChannelUpdatedEvent, 'id'>
  const event = {
    ...eventWithoutId,
    id: registryEventDigest(eventWithoutId),
  }

  await adapters.database.commitPackageChannelUpdate(event)
  enqueueDerivedRegistryJob(adapters, 'channel.updated', {
    channel: input.channel,
    package: input.packageId,
    version: input.version,
  })

  return { event, ...(previousVersion ? { previousVersion } : {}) }
}

export async function deletePackageChannel(
  adapters: RegistryAdapters,
  input: {
    authorization?: WriteAuthorizationProof
    channel: string
    packageId: PackageId
    previousVersion?: string
    timestamp?: string
  },
): Promise<ChannelMutationResult> {
  assertPackageChannel(input.channel)
  await assertWriteAuthorizationIsFresh(adapters, input.authorization)
  const timestamp = channelMutationTimestamp(input)

  const previousVersion = await channelMutationPreviousVersion(adapters, input)
  const eventWithoutId = {
    ...(input.authorization ? { authorization: input.authorization } : {}),
    channel: input.channel,
    eventType: 'channel.deleted',
    object: 'regesta.event',
    package: input.packageId,
    ...(previousVersion ? { previousVersion } : {}),
    timestamp,
  } satisfies Omit<ChannelDeletedEvent, 'id'>
  const event = {
    ...eventWithoutId,
    id: registryEventDigest(eventWithoutId),
  }

  await adapters.database.commitPackageChannelDelete(event)
  enqueueDerivedRegistryJob(adapters, 'channel.deleted', {
    channel: input.channel,
    package: input.packageId,
  })

  return { event, ...(previousVersion ? { previousVersion } : {}) }
}

function channelMutationPreviousVersion(
  adapters: RegistryAdapters,
  input: {
    channel: string
    packageId: PackageId
    previousVersion?: string
  },
): Promise<string | undefined> {
  if (!Object.prototype.hasOwnProperty.call(input, 'previousVersion')) {
    return getPackageChannelVersion(adapters, input.packageId, input.channel)
  }

  if (input.previousVersion !== undefined) {
    assertPackageVersion(input.previousVersion, 'Channel previousVersion')
  }

  return Promise.resolve(input.previousVersion)
}

function channelMutationTimestamp(input: {
  authorization?: WriteAuthorizationProof
  timestamp?: string
}): string {
  const timestamp = input.timestamp ?? input.authorization?.signedAt

  if (
    input.authorization &&
    timestamp !== undefined &&
    timestamp !== input.authorization.signedAt
  ) {
    throw new TypeError(
      'Channel timestamp must match write authorization signedAt',
    )
  }

  return timestamp === undefined
    ? new Date().toISOString()
    : assertCanonicalTimestamp(timestamp, 'Channel timestamp')
}
