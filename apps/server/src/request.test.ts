import { describe, expect, it } from 'vitest'
import { requestKnownErrors, RequestValidationError } from './request.ts'

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
