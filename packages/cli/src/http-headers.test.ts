import { describe, expect, it } from 'vitest'
import {
  cacheControlHasDirective,
  isolatedRequestInit,
} from './http-headers.ts'

describe('cacheControlHasDirective', () => {
  it('matches cache-control directives as case-insensitive tokens', () => {
    expect(
      cacheControlHasDirective(
        'public, max-age=31536000, immutable',
        'immutable',
      ),
    ).toBe(true)
    expect(cacheControlHasDirective('No-Cache, max-age=0', 'no-cache')).toBe(
      true,
    )
    expect(
      cacheControlHasDirective(
        'public, no-cacheable, not-immutable',
        'no-cache',
      ),
    ).toBe(false)
    expect(
      cacheControlHasDirective(
        'public, no-cacheable, not-immutable',
        'immutable',
      ),
    ).toBe(false)
    expect(
      cacheControlHasDirective('public, extension="immutable"', 'immutable'),
    ).toBe(false)
    expect(
      cacheControlHasDirective('public, extension="no-cache"', 'no-cache'),
    ).toBe(false)
    expect(
      cacheControlHasDirective(
        'public, extension="not done, immutable", max-age=0',
        'immutable',
      ),
    ).toBe(false)
    expect(
      cacheControlHasDirective(
        'public, extension="not done, still quoted", immutable',
        'immutable',
      ),
    ).toBe(true)
    expect(
      cacheControlHasDirective(
        String.raw`public, extension="escaped \" quote, immutable", max-age=0`,
        'immutable',
      ),
    ).toBe(false)
    expect(
      cacheControlHasDirective(
        String.raw`public, extension="escaped comma\, immutable", max-age=0`,
        'immutable',
      ),
    ).toBe(false)
    expect(cacheControlHasDirective('public, max-age=0', '')).toBe(false)
  })
})

describe('isolatedRequestInit', () => {
  it('builds registry requests without ambient cache, credentials, or redirects', () => {
    expect(isolatedRequestInit()).toEqual({
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'error',
    })
    expect(
      isolatedRequestInit({
        accept: 'application/json',
        method: 'POST',
      }),
    ).toEqual({
      cache: 'no-store',
      credentials: 'omit',
      headers: {
        accept: 'application/json',
      },
      method: 'POST',
      redirect: 'error',
    })
  })
})
