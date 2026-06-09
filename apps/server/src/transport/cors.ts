import { cors } from 'hono/cors'
import type { MiddlewareHandler } from 'hono'

export function createCorsMiddleware(): MiddlewareHandler {
  return cors({
    allowMethods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    maxAge: 86_400,
    origin: '*',
  })
}
