import { describe, expect, it } from 'vitest'
import { assertRegistryEventSemantics } from './events.ts'

describe('assertRegistryEventSemantics', () => {
  it('rejects unsupported event types even without digest validation', () => {
    expect(() =>
      assertRegistryEventSemantics(
        JSON.parse(
          `{
            "eventType": "package.deleted",
            "id": "sha256:0000000000000000000000000000000000000000000000000000000000000000",
            "object": "regesta.event",
            "package": "npm:example.com/hello-regesta",
            "timestamp": "2026-06-01T00:00:00.000Z"
          }`,
        ),
      ),
    ).toThrow('Unsupported registry event type')
  })
})
