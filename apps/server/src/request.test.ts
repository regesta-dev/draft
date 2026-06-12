import { describe, expect, it } from 'vitest'
import {
  publicRequestUrl,
  requestKnownErrors,
  RequestValidationError,
} from './request.ts'

describe('requestKnownErrors', () => {
  it('maps request validation errors to bad requests', () => {
    const match = requestKnownErrors.find((item) =>
      item.match(new RequestValidationError('Invalid request')),
    )

    expect(match).toMatchObject({
      code: 'request_invalid',
      status: 400,
    })
  })

  it('does not match unrelated errors', () => {
    expect(
      requestKnownErrors.some((item) => item.match(new Error('unexpected'))),
    ).toBe(false)
  })
})

describe('publicRequestUrl', () => {
  it('uses the Host header as the public authority', () => {
    expect(
      publicRequestUrl(
        'http://127.0.0.1:4321/packages/npm:example.com/pkg',
        'registry.example:8443',
      ).href,
    ).toBe('http://registry.example:8443/packages/npm:example.com/pkg')
  })

  it('falls back to the request URL authority when Host is unavailable', () => {
    expect(publicRequestUrl('http://127.0.0.1:4321/releases', null).href).toBe(
      'http://127.0.0.1:4321/releases',
    )
  })
})
