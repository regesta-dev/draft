import {
  defaultPackageChannel,
  registryEventDigest,
  sha256,
  type ChannelDeletedEvent,
  type ChannelUpdatedEvent,
  type PackageId,
  type PublishReleaseEvent,
} from '@regesta/protocol'
import { describe, expect, it } from 'vitest'
import { replayPackageState } from './channels.ts'

describe('replayPackageState', () => {
  it('reconstructs package releases and channels from ordered registry events', () => {
    const packageId: PackageId = 'npm:example.com/hello-regesta'
    const first = publishEvent(packageId, '1.0.0', '2026-06-01T00:00:00.000Z')
    const second = publishEvent(packageId, '2.0.0', '2026-06-02T00:00:00.000Z')
    const beta = channelUpdatedEvent({
      channel: 'beta',
      packageId,
      timestamp: '2026-06-02T00:01:00.000Z',
      version: '2.0.0',
    })
    const deleteLatest = channelDeletedEvent({
      channel: defaultPackageChannel,
      packageId,
      previousVersion: '2.0.0',
      timestamp: '2026-06-02T00:02:00.000Z',
    })
    const unrelated = publishEvent(
      'npm:other.example.com/hello-regesta',
      '9.0.0',
      '2026-06-03T00:00:00.000Z',
    )

    expect(
      replayPackageState(
        [unrelated, first, second, beta, deleteLatest],
        packageId,
      ),
    ).toEqual({
      channels: {
        beta: '2.0.0',
      },
      ecosystem: 'npm',
      id: packageId,
      name: 'example.com/hello-regesta',
      object: 'regesta.package-state',
      releases: [
        {
          createdAt: '2026-06-01T00:00:00.000Z',
          manifestDigest: first.release.manifestDigest,
          version: '1.0.0',
        },
        {
          createdAt: '2026-06-02T00:00:00.000Z',
          manifestDigest: second.release.manifestDigest,
          version: '2.0.0',
        },
      ],
    })
  })

  it('rejects events whose id does not match the canonical payload', () => {
    const event = publishEvent(
      'npm:example.com/hello-regesta',
      '1.0.0',
      '2026-06-01T00:00:00.000Z',
    )

    expect(() =>
      replayPackageState(
        [{ ...event, id: sha256('different event payload') }],
        event.release.id,
      ),
    ).toThrow('Registry event id does not match canonical event payload')
  })

  it('rejects events whose digest matches but registry semantics are invalid', () => {
    const event = channelUpdatedEvent({
      channel: '',
      packageId: 'npm:example.com/hello-regesta',
      timestamp: '2026-06-01T00:00:00.000Z',
      version: '1.0.0',
    })

    expect(() => replayPackageState([event], event.package)).toThrow(
      'Registry event channel must be a non-empty string',
    )

    const controlChannelEvent = channelUpdatedEvent({
      channel: 'latest\r\nx',
      packageId: 'npm:example.com/hello-regesta',
      timestamp: '2026-06-01T00:00:00.000Z',
      version: '1.0.0',
    })

    expect(() =>
      replayPackageState([controlChannelEvent], controlChannelEvent.package),
    ).toThrow('Registry event channel must not include control characters')
  })

  it('rejects unknown event fields even when the event id matches them', () => {
    const packageId: PackageId = 'npm:example.com/hello-regesta'
    const payload = {
      ...publishEvent(packageId, '1.0.0', '2026-06-01T00:00:00.000Z'),
      mirrorPolicy: 'not part of the protocol',
    }
    const event = {
      ...payload,
      id: registryEventDigest(payload),
    }

    expect(() => replayPackageState([event], packageId)).toThrow(
      'Registry event must not include unknown field: mirrorPolicy',
    )
  })

  it('rejects duplicate release versions during replay', () => {
    const packageId: PackageId = 'npm:example.com/hello-regesta'
    const first = publishEvent(packageId, '1.0.0', '2026-06-01T00:00:00.000Z')
    const duplicate = publishEvent(
      packageId,
      '1.0.0',
      '2026-06-02T00:00:00.000Z',
    )

    expect(() => replayPackageState([first, duplicate], packageId)).toThrow(
      'Registry event release version already exists: 1.0.0',
    )
  })

  it('rejects channel updates that target unpublished versions during replay', () => {
    const packageId: PackageId = 'npm:example.com/hello-regesta'
    const release = publishEvent(packageId, '1.0.0', '2026-06-01T00:00:00.000Z')
    const beta = channelUpdatedEvent({
      channel: 'beta',
      packageId,
      timestamp: '2026-06-01T00:01:00.000Z',
      version: '2.0.0',
    })

    expect(() => replayPackageState([release, beta], packageId)).toThrow(
      'Registry event channel target version does not exist: 2.0.0',
    )
  })

  it('rejects channel events whose previousVersion does not match replayed state', () => {
    const packageId: PackageId = 'npm:example.com/hello-regesta'
    const release = publishEvent(packageId, '1.0.0', '2026-06-01T00:00:00.000Z')
    const deleteLatest = channelDeletedEvent({
      channel: defaultPackageChannel,
      packageId,
      timestamp: '2026-06-01T00:01:00.000Z',
    })

    expect(() =>
      replayPackageState([release, deleteLatest], packageId),
    ).toThrow(
      'Registry event previousVersion does not match replayed channel state',
    )
  })
})

function publishEvent(
  packageId: PackageId,
  version: string,
  timestamp: string,
): PublishReleaseEvent {
  const payload: Omit<PublishReleaseEvent, 'id'> = {
    artifactDigests: [sha256(`artifact:${packageId}@${version}`)],
    channel: defaultPackageChannel,
    eventType: 'release.published',
    object: 'regesta.event',
    release: {
      id: packageId,
      manifestDigest: sha256(`manifest:${packageId}@${version}`),
      version,
    },
    sourceDigest: sha256(`source:${packageId}@${version}`),
    timestamp,
  }

  return {
    ...payload,
    id: registryEventDigest(payload),
  }
}

function channelUpdatedEvent(input: {
  channel: string
  packageId: PackageId
  previousVersion?: string
  timestamp: string
  version: string
}): ChannelUpdatedEvent {
  const payload: Omit<ChannelUpdatedEvent, 'id'> = {
    channel: input.channel,
    eventType: 'channel.updated',
    object: 'regesta.event',
    package: input.packageId,
    ...(input.previousVersion
      ? { previousVersion: input.previousVersion }
      : {}),
    timestamp: input.timestamp,
    version: input.version,
  }

  return {
    ...payload,
    id: registryEventDigest(payload),
  }
}

function channelDeletedEvent(input: {
  channel: string
  packageId: PackageId
  previousVersion?: string
  timestamp: string
}): ChannelDeletedEvent {
  const payload: Omit<ChannelDeletedEvent, 'id'> = {
    channel: input.channel,
    eventType: 'channel.deleted',
    object: 'regesta.event',
    package: input.packageId,
    ...(input.previousVersion
      ? { previousVersion: input.previousVersion }
      : {}),
    timestamp: input.timestamp,
  }

  return {
    ...payload,
    id: registryEventDigest(payload),
  }
}
