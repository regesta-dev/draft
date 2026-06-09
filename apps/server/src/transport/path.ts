import { trimTrailingSlash } from 'hono/trailing-slash'
import type { MiddlewareHandler } from 'hono'

export function createPathNormalizationMiddleware(): MiddlewareHandler {
  return trimTrailingSlash()
}
