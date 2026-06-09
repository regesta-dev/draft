import { randomUUID } from 'node:crypto'
import type { Context, MiddlewareHandler } from 'hono'

export interface RequestLogEntry {
  durationMs: number
  host: string
  kind: 'regesta.request'
  method: string
  path: string
  requestId: string
  status: number
}

export type RequestLogSink = (entry: RequestLogEntry) => Promise<void> | void

const requestIdHeader = 'x-request-id'
const requestIdPattern = /^[\w.-]{1,128}$/u

export function createRequestIdMiddleware(): MiddlewareHandler {
  return async (context, next) => {
    const requestId = ensureRequestId(context)

    await next()
    context.header(requestIdHeader, requestId)
  }
}

export function createRequestLogger(log: RequestLogSink): MiddlewareHandler {
  return async (context, next) => {
    const startedAt = performance.now()
    const requestId = ensureRequestId(context)

    await next()
    context.header(requestIdHeader, requestId)

    try {
      await log({
        durationMs: elapsedMilliseconds(startedAt),
        host: context.req.header('host') ?? new URL(context.req.url).host,
        kind: 'regesta.request',
        method: context.req.method,
        path: new URL(context.req.url).pathname,
        requestId,
        status: context.res.status,
      })
    } catch (error) {
      console.error(error)
    }
  }
}

function elapsedMilliseconds(startedAt: number): number {
  return Math.round((performance.now() - startedAt) * 100) / 100
}

function ensureRequestId(context: Context): string {
  const responseRequestId = context.res.headers.get(requestIdHeader)
  if (responseRequestId && requestIdPattern.test(responseRequestId)) {
    return responseRequestId
  }

  const requestId = requestIdForRequest(context.req.header(requestIdHeader))
  context.header(requestIdHeader, requestId)
  return requestId
}

function requestIdForRequest(value: string | undefined): string {
  return value && requestIdPattern.test(value) ? value : randomUUID()
}
