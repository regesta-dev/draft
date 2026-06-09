import { describe, expect, it } from 'vitest'
import { sha256 } from './digest.ts'
import {
  registryEventDigest,
  registryEventPayload,
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
    specVersion: 0,
    timestamp: '2026-06-01T00:00:00.000Z',
  }
}

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value)
}
