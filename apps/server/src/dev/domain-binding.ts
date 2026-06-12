import process from 'node:process'
import { devJsonFileResponse, devLocalhostDomainBindingText } from './keys.ts'

export function domainBindingFetchForRequest(): typeof fetch {
  if (!import.meta.dev && process.env.NODE_ENV !== 'development') {
    return fetch
  }

  return (input, init) => {
    const url = fetchInputUrl(input)

    if (url === 'https://dev.localhost/.well-known/regesta.json') {
      return Promise.resolve(devJsonFileResponse(devLocalhostDomainBindingText))
    }

    return fetch(input, init)
  }
}

function fetchInputUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') {
    return input
  }

  if (input instanceof URL) {
    return input.href
  }

  return input.url
}
