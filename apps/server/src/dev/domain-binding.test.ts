import { describe, expect, it } from 'vitest'
import { domainBindingFetchForRequest } from './domain-binding.ts'
import { devLocalhostDomainBinding } from './keys.ts'

describe('dev domain binding fetch', () => {
  it('resolves the fixed dev.localhost binding without relying on DNS', async () => {
    const fetchBinding = domainBindingFetchForRequest()
    const response = await fetchBinding(
      'https://dev.localhost/.well-known/regesta.json',
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual(devLocalhostDomainBinding)
  })
})
