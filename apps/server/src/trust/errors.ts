import { WriteAuthorizationError } from '@regesta/auth'

export interface TrustKnownError {
  code: string
  match: (error: Error) => boolean
  status: 400 | 401 | 403 | 404 | 409 | 422
}

export const trustKnownErrors = [
  {
    code: 'write_authorization_invalid',
    match: isWriteAuthorizationError,
    status: 401,
  },
] satisfies TrustKnownError[]

export function isWriteAuthorizationError(error: unknown): boolean {
  return error instanceof WriteAuthorizationError
}
