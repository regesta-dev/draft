import { describe, expect, it } from 'vitest'
import {
  httpDate,
  matchesIfModifiedSince,
  matchesIfNoneMatch,
} from './responses.ts'

describe('matchesIfNoneMatch', () => {
  it('matches strong, weak, wildcard, and list validators', () => {
    expect(matchesIfNoneMatch('"current"', '"current"')).toBe(true)
    expect(matchesIfNoneMatch('W/"current"', '"current"')).toBe(true)
    expect(matchesIfNoneMatch('"current"', 'W/"current"')).toBe(true)
    expect(matchesIfNoneMatch('"other", W/"current"', '"current"')).toBe(true)
    expect(matchesIfNoneMatch('*', '"current"')).toBe(true)
    expect(matchesIfNoneMatch('"other"', '"current"')).toBe(false)
  })

  it('does not split entity tags on quoted commas', () => {
    expect(matchesIfNoneMatch('"other, current"', '"current"')).toBe(false)
    expect(matchesIfNoneMatch('"other, current", "next"', '"current"')).toBe(
      false,
    )
    expect(matchesIfNoneMatch('"other, current", "next"', '"next"')).toBe(true)
  })

  it('does not match entity tags split out of malformed quoted strings', () => {
    expect(matchesIfNoneMatch('"other, "current"', '"current"')).toBe(false)
    expect(matchesIfNoneMatch('W/"other, W/"current"', '"current"')).toBe(false)
  })
})

describe('httpDate', () => {
  it('formats ISO timestamps as HTTP dates', () => {
    expect(httpDate('2026-06-01T00:00:00.000Z')).toBe(
      'Mon, 01 Jun 2026 00:00:00 GMT',
    )
  })

  it('rejects invalid timestamps', () => {
    expect(() => httpDate('not-a-date')).toThrow('HTTP timestamp must be valid')
  })
})

describe('matchesIfModifiedSince', () => {
  it('matches when the resource is not newer than the request date', () => {
    expect(
      matchesIfModifiedSince(
        'Mon, 01 Jun 2026 00:00:00 GMT',
        'Mon, 01 Jun 2026 00:00:00 GMT',
      ),
    ).toBe(true)
    expect(
      matchesIfModifiedSince(
        'Tue, 02 Jun 2026 00:00:00 GMT',
        'Mon, 01 Jun 2026 00:00:00 GMT',
      ),
    ).toBe(true)
    expect(
      matchesIfModifiedSince(
        'Sun, 31 May 2026 23:59:59 GMT',
        'Mon, 01 Jun 2026 00:00:00 GMT',
      ),
    ).toBe(false)
  })

  it('ignores missing or invalid dates', () => {
    expect(
      matchesIfModifiedSince(undefined, 'Mon, 01 Jun 2026 00:00:00 GMT'),
    ).toBe(false)
    expect(
      matchesIfModifiedSince('not-a-date', 'Mon, 01 Jun 2026 00:00:00 GMT'),
    ).toBe(false)
    expect(
      matchesIfModifiedSince('Mon, 01 Jun 2026 00:00:00 GMT', undefined),
    ).toBe(false)
  })
})
