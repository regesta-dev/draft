import { describe, expect, it } from 'vitest'
import { sha256 } from './digest.ts'
import {
  parseRegistryEvent,
  registryEventDigest,
  registryEventPayload,
  type PublishReleaseEvent,
  type PublishReleaseEventPayload,
} from './event.ts'

describe('registryEventDigest', () => {
  it('rejects non-object event inputs', () => {
    expect(() => registryEventDigest(JSON.parse('null'))).toThrow(
      'Registry event must be an object',
    )
    expect(() => registryEventDigest(JSON.parse('[]'))).toThrow(
      'Registry event must be an object',
    )
  })

  it('rejects unsupported event payload types before digesting', () => {
    const payload = publishReleasePayload()
    Object.assign(payload, {
      eventType: 'package.deleted',
    })

    expect(() => registryEventDigest(payload)).toThrow(
      'Unsupported registry event type',
    )
  })

  it('rejects unsupported event types before stripping ids', () => {
    const payload = publishReleasePayload()
    const event = {
      ...payload,
      id: registryEventDigest(payload),
    }
    Object.assign(event, {
      eventType: 'package.deleted',
    })

    expect(() => registryEventDigest(event)).toThrow(
      'Unsupported registry event type',
    )
  })
})

describe('registryEventPayload', () => {
  it('rejects non-object event inputs', () => {
    expect(() => registryEventPayload(JSON.parse('null'))).toThrow(
      'Registry event must be an object',
    )
  })
})

describe('parseRegistryEvent', () => {
  it('parses valid registry events without unsafe narrowing', () => {
    const payload = publishReleasePayload()
    const event: PublishReleaseEvent = {
      ...payload,
      id: registryEventDigest(payload),
    }

    expect(parseRegistryEvent(event)).toEqual(event)
  })

  it('rejects registry events whose ids do not match canonical payloads', () => {
    const payload = publishReleasePayload()
    const event: PublishReleaseEvent = {
      ...payload,
      id: registryEventDigest(payload),
    }

    expect(() =>
      parseRegistryEvent({
        ...event,
        id: sha256(bytes('different event')),
      }),
    ).toThrow('Registry event id does not match canonical event payload')
  })

  it('can parse event references before immutable endpoint verification', () => {
    const payload = publishReleasePayload()
    const event: PublishReleaseEvent = {
      ...payload,
      id: sha256(bytes('different event')),
    }

    expect(
      parseRegistryEvent(event, 'Registry event reference', {
        verifyId: false,
      }),
    ).toEqual(event)
  })

  it('rejects unknown registry event fields', () => {
    const payload = publishReleasePayload()
    const event: PublishReleaseEvent = {
      ...payload,
      id: registryEventDigest(payload),
    }

    expect(() =>
      parseRegistryEvent({
        ...event,
        extra: true,
      }),
    ).toThrow('Registry event must not include unknown field: extra')
  })

  it('rejects unknown publish event release fields before event id mismatches', () => {
    const payload = publishReleasePayload()
    const event: PublishReleaseEvent = {
      ...payload,
      id: registryEventDigest(payload),
    }

    expect(() =>
      parseRegistryEvent({
        ...event,
        release: {
          ...event.release,
          operatorHint: 'not verified',
        },
      }),
    ).toThrow(
      'Registry event release must not include unknown field: operatorHint',
    )
  })
})

function publishReleasePayload(): PublishReleaseEventPayload {
  return {
    artifactDigests: [sha256(bytes('artifact'))],
    channel: 'latest',
    eventType: 'release.published',
    object: 'regesta.event',
    release: {
      id: 'npm:example.com/event-test',
      manifestDigest: sha256(bytes('manifest')),
      version: '0.0.1',
    },
    sourceDigest: sha256(bytes('source')),
    timestamp: '2026-06-01T00:00:00.000Z',
  }
}

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value)
}
