import { WriteAuthorizationError } from '@regesta/auth'

export function isWriteAuthorizationError(error: unknown): boolean {
  return error instanceof WriteAuthorizationError
}
