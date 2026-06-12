import { describe, expect, it } from 'vitest'
import { matchesIfNoneMatch } from './responses.ts'

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
