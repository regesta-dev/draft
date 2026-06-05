import {
  canonicalJson,
  parsePackageId,
  sha256,
  type ChannelDeletedEvent,
  type ChannelUpdatedEvent,
  type PackageId,
  type PackageState,
  type WriteAuthorizationProof,
} from '@regesta/protocol'
import type { RegistryAdapters } from '@regesta/adapters'

export interface ChannelMutationResult {
  event: ChannelDeletedEvent | ChannelUpdatedEvent
  previousVersion?: string
}

export async function getPackageState(
  adapters: RegistryAdapters,
  packageId: PackageId,
): Promise<PackageState> {
  const parsed = parsePackageId(packageId)
  const releases = await adapters.database.listPackageReleases(packageId)
  const channels = await adapters.database.getPackageChannels(packageId)

  return {
    ...(Object.keys(channels).length === 0 ? {} : { channels }),
    ecosystem: parsed.ecosystem,
    id: packageId,
    name: parsed.name,
    object: 'regesta.package-state',
    releases: releases
      .map((release) => ({
        createdAt: release.manifest.createdAt,
        manifestDigest: release.manifestDescriptor.digest,
        version: release.manifest.version,
      }))
      .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt)),
    specVersion: 0,
  }
}

export async function updatePackageChannel(
  adapters: RegistryAdapters,
  input: {
    authorization?: WriteAuthorizationProof
    channel: string
    packageId: PackageId
    timestamp?: string
    version: string
  },
): Promise<ChannelMutationResult> {
  const release = await adapters.database.getRelease(
    input.packageId,
    input.version,
  )

  if (!release) {
    throw new Error(`Release not found: ${input.packageId}@${input.version}`)
  }

  const previousVersion = await adapters.database.setPackageChannel(
    input.packageId,
    input.channel,
    input.version,
  )
  const eventWithoutId = {
    ...(input.authorization ? { authorization: input.authorization } : {}),
    channel: input.channel,
    eventType: 'channel.updated',
    object: 'regesta.event',
    package: input.packageId,
    ...(previousVersion ? { previousVersion } : {}),
    specVersion: 0,
    timestamp: input.timestamp ?? new Date().toISOString(),
    version: input.version,
  } satisfies Omit<ChannelUpdatedEvent, 'id'>
  const event = {
    ...eventWithoutId,
    id: sha256(canonicalJson(eventWithoutId as never)),
  }

  await adapters.database.appendEvent(event)
  await adapters.queue.enqueue('channel.updated', {
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
    timestamp?: string
  },
): Promise<ChannelMutationResult> {
  const previousVersion = await adapters.database.deletePackageChannel(
    input.packageId,
    input.channel,
  )
  const eventWithoutId = {
    ...(input.authorization ? { authorization: input.authorization } : {}),
    channel: input.channel,
    eventType: 'channel.deleted',
    object: 'regesta.event',
    package: input.packageId,
    ...(previousVersion ? { previousVersion } : {}),
    specVersion: 0,
    timestamp: input.timestamp ?? new Date().toISOString(),
  } satisfies Omit<ChannelDeletedEvent, 'id'>
  const event = {
    ...eventWithoutId,
    id: sha256(canonicalJson(eventWithoutId as never)),
  }

  await adapters.database.appendEvent(event)
  await adapters.queue.enqueue('channel.deleted', {
    channel: input.channel,
    package: input.packageId,
  })

  return { event, ...(previousVersion ? { previousVersion } : {}) }
}
