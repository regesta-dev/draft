import {
  readWriteAuthorization,
  verifyChannelDeleteAuthorization,
  verifyChannelUpdateAuthorization,
  verifyPublishAuthorization,
} from '@regesta/auth'
import type { WriteAuthorizationProof } from '@regesta/protocol'

export type DomainBindingFetchForRequest = (requestUrl: string) => typeof fetch

type AuthVerifyPublishInput = Parameters<typeof verifyPublishAuthorization>[0]
type AuthVerifyChannelUpdateInput = Parameters<
  typeof verifyChannelUpdateAuthorization
>[0]
type AuthVerifyChannelDeleteInput = Parameters<
  typeof verifyChannelDeleteAuthorization
>[0]

export type VerifyPublishAuthorizationInput = Omit<
  AuthVerifyPublishInput,
  'domainBindingFetchTimeoutMs' | 'fetchBinding'
> & {
  requestUrl: string
}

export type VerifyChannelUpdateAuthorizationInput = Omit<
  AuthVerifyChannelUpdateInput,
  'domainBindingFetchTimeoutMs' | 'fetchBinding'
> & {
  requestUrl: string
}

export type VerifyChannelDeleteAuthorizationInput = Omit<
  AuthVerifyChannelDeleteInput,
  'domainBindingFetchTimeoutMs' | 'fetchBinding'
> & {
  requestUrl: string
}

export type VerifyPublishAuthorization = (
  input: VerifyPublishAuthorizationInput,
) => Promise<WriteAuthorizationProof>

export type VerifyChannelUpdateAuthorization = (
  input: VerifyChannelUpdateAuthorizationInput,
) => Promise<WriteAuthorizationProof>

export type VerifyChannelDeleteAuthorization = (
  input: VerifyChannelDeleteAuthorizationInput,
) => Promise<WriteAuthorizationProof>

export interface TrustServices {
  readWriteAuthorization: typeof readWriteAuthorization
  verifyChannelDeleteAuthorization: VerifyChannelDeleteAuthorization
  verifyChannelUpdateAuthorization: VerifyChannelUpdateAuthorization
  verifyPublishAuthorization: VerifyPublishAuthorization
}

export interface TrustServicesOptions {
  domainBindingFetchForRequest?: DomainBindingFetchForRequest
  domainBindingFetchTimeoutMs?: number
}

export function createTrustServices(
  options: TrustServicesOptions = {},
): TrustServices {
  const domainBindingFetchTimeoutMs = normalizeDomainBindingFetchTimeoutMs(
    options.domainBindingFetchTimeoutMs,
  )
  const services = {
    readWriteAuthorization,
    verifyChannelDeleteAuthorization: (input) => {
      const { requestUrl, ...authorizationInput } = input

      return verifyChannelDeleteAuthorization(
        withDomainBindingFetchTimeout(
          {
            ...authorizationInput,
            fetchBinding: fetchBindingForRequest(options, requestUrl),
          },
          domainBindingFetchTimeoutMs,
        ),
      )
    },
    verifyChannelUpdateAuthorization: (input) => {
      const { requestUrl, ...authorizationInput } = input

      return verifyChannelUpdateAuthorization(
        withDomainBindingFetchTimeout(
          {
            ...authorizationInput,
            fetchBinding: fetchBindingForRequest(options, requestUrl),
          },
          domainBindingFetchTimeoutMs,
        ),
      )
    },
    verifyPublishAuthorization: (input) => {
      const { requestUrl, ...authorizationInput } = input

      return verifyPublishAuthorization(
        withDomainBindingFetchTimeout(
          {
            ...authorizationInput,
            fetchBinding: fetchBindingForRequest(options, requestUrl),
          },
          domainBindingFetchTimeoutMs,
        ),
      )
    },
  } satisfies TrustServices

  return services
}

function fetchBindingForRequest(
  options: TrustServicesOptions,
  requestUrl: string,
): typeof fetch {
  return options.domainBindingFetchForRequest
    ? options.domainBindingFetchForRequest(requestUrl)
    : fetch
}

function normalizeDomainBindingFetchTimeoutMs(
  timeoutMs: number | undefined,
): number | undefined {
  if (timeoutMs === undefined) {
    return undefined
  }

  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0) {
    throw new TypeError(
      'Domain binding fetch timeout must be a non-negative safe integer',
    )
  }

  return timeoutMs
}

function withDomainBindingFetchTimeout<TInput extends object>(
  input: TInput,
  timeoutMs: number | undefined,
): TInput & { domainBindingFetchTimeoutMs?: number } {
  return timeoutMs === undefined
    ? input
    : { ...input, domainBindingFetchTimeoutMs: timeoutMs }
}
