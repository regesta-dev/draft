import { describe, expect, it } from 'vitest'
import {
  isValidRequestId,
  publicRequestUrl,
  requestIdHeader,
  requestKnownErrors,
  RequestValidationError,
  validatedRequestId,
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

describe('isValidRequestId', () => {
  it('accepts bounded portable request ids', () => {
    expect(isValidRequestId('request-01HZX2V4Q5R6')).toBe(true)
    expect(isValidRequestId('a'.repeat(128))).toBe(true)
  })

  it('rejects empty, oversized, and whitespace request ids', () => {
    expect(isValidRequestId('')).toBe(false)
    expect(isValidRequestId('a'.repeat(129))).toBe(false)
    expect(isValidRequestId('invalid request id')).toBe(false)
    expect(isValidRequestId('invalid\nrequest-id')).toBe(false)
  })
})

describe('validatedRequestId', () => {
  it('uses the validated response request id before the request header', () => {
    expect(
      validatedRequestId(
        new Headers({
          [requestIdHeader]: 'response-id',
        }),
        'request-id',
      ),
    ).toBe('response-id')
  })

  it('falls back to the validated request header when no response id exists', () => {
    expect(validatedRequestId(new Headers(), 'request-id')).toBe('request-id')
  })

  it('rejects invalid request ids without fallback after a response id exists', () => {
    expect(
      validatedRequestId(
        new Headers({
          [requestIdHeader]: 'invalid response id',
        }),
        'request-id',
      ),
    ).toBeUndefined()
    expect(
      validatedRequestId(new Headers(), 'invalid request id'),
    ).toBeUndefined()
  })
})
