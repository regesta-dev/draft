import { describe, expect, it } from 'vitest'
import { assertCanonicalTimestamp } from './timestamp.ts'

describe('assertCanonicalTimestamp', () => {
  it('accepts canonical ISO 8601 timestamps', () => {
    expect(assertCanonicalTimestamp('2026-06-01T00:00:00.000Z')).toBe(
      '2026-06-01T00:00:00.000Z',
    )
  })

  it('rejects non-string values', () => {
    expect(() => assertCanonicalTimestamp(JSON.parse('null'))).toThrow(
      'Timestamp must be a string',
    )
  })

  it('rejects non-canonical or invalid timestamps', () => {
    for (const timestamp of [
      '2026-06-01T00:00:00Z',
      '2026-06-01T00:00:00.000+00:00',
      'not-a-date',
    ]) {
      expect(() => assertCanonicalTimestamp(timestamp)).toThrow(
        'Timestamp must be canonical ISO 8601',
      )
    }
  })
})
