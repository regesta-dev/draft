import {
  verifyChannelDeleteAuthorization,
  verifyChannelUpdateAuthorization,
  verifyPublishAuthorization,
} from '@regesta/auth'

export type DomainBindingFetchForRequest = (requestUrl: string) => typeof fetch

export interface TrustServices {
  domainBindingFetchForRequest?: DomainBindingFetchForRequest
  verifyChannelDeleteAuthorization: typeof verifyChannelDeleteAuthorization
  verifyChannelUpdateAuthorization: typeof verifyChannelUpdateAuthorization
  verifyPublishAuthorization: typeof verifyPublishAuthorization
}

export interface TrustServicesOptions {
  domainBindingFetchForRequest?: DomainBindingFetchForRequest
}

export function createTrustServices(
  options: TrustServicesOptions = {},
): TrustServices {
  const services = {
    verifyChannelDeleteAuthorization,
    verifyChannelUpdateAuthorization,
    verifyPublishAuthorization,
  }

  return options.domainBindingFetchForRequest
    ? {
        ...services,
        domainBindingFetchForRequest: options.domainBindingFetchForRequest,
      }
    : services
}
