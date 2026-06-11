import { WriteAuthorizationError } from '@regesta/auth'
import { describe, expect, it } from 'vitest'
import { trustKnownErrors } from './errors.ts'

describe('trustKnownErrors', () => {
  it('maps write authorization errors to unauthorized responses', () => {
    const match = trustKnownErrors.find((item) =>
      item.match(new WriteAuthorizationError('Invalid signature')),
    )

    expect(match).toMatchObject({
      code: 'write_authorization_invalid',
      status: 401,
    })
  })

  it('does not match unrelated errors', () => {
    expect(
      trustKnownErrors.some((item) => item.match(new Error('unexpected'))),
    ).toBe(false)
  })
})
