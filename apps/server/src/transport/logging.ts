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

export function isValidRequestId(value: string): boolean {
  return requestIdPattern.test(value)
}

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

    const entry = {
      durationMs: elapsedMilliseconds(startedAt),
      host: context.req.header('host') ?? new URL(context.req.url).host,
      kind: 'regesta.request',
      method: context.req.method,
      path: new URL(context.req.url).pathname,
      requestId,
      status: context.res.status,
    } satisfies RequestLogEntry

    writeRequestLog(log, entry)
  }
}

function writeRequestLog(log: RequestLogSink, entry: RequestLogEntry): void {
  try {
    Promise.resolve(log(entry)).catch((error: unknown) => {
      reportRequestLogError(entry, error)
    })
  } catch (error) {
    reportRequestLogError(entry, error)
  }
}

function reportRequestLogError(entry: RequestLogEntry, error: unknown): void {
  console.error('Transport request log sink failed', {
    error,
    kind: 'regesta.request-log-error',
    method: entry.method,
    path: entry.path,
    requestId: entry.requestId,
    status: entry.status,
  })
}

function elapsedMilliseconds(startedAt: number): number {
  return Math.round((performance.now() - startedAt) * 100) / 100
}

function ensureRequestId(context: Context): string {
  const responseRequestId = context.res.headers.get(requestIdHeader)
  if (responseRequestId && isValidRequestId(responseRequestId)) {
    return responseRequestId
  }

  const requestId = requestIdForRequest(context.req.header(requestIdHeader))
  context.header(requestIdHeader, requestId)
  return requestId
}

function requestIdForRequest(value: string | undefined): string {
  return value && isValidRequestId(value) ? value : randomUUID()
}
