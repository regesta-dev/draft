import { Hono } from 'hono'
import {
  createDeploymentInfo,
  normalizeDeploymentStatistics,
  type DeploymentStatistics,
} from './build-info.ts'
import { createCorsMiddleware } from './cors.ts'
import {
  createTransportErrorBoundary,
  type KnownTransportError,
} from './errors.ts'
import {
  createRequestIdMiddleware,
  createRequestLogger,
  type RequestLogSink,
} from './logging.ts'
import { createPathNormalizationMiddleware } from './path.ts'
import {
  createRequestSizeLimitMiddleware,
  type RequestSizeLimitOptions,
} from './request-size.ts'
import { registryRoutePath } from './routing.ts'

const defaultDeploymentStatisticsCacheTtlMs = 10_000

export type { RequestLogSink } from './logging.ts'
export type { RequestSizeLimitOptions } from './request-size.ts'

export interface ReadinessStatus {
  checks?: {
    database?: boolean
    objects?: boolean
    queue?: boolean
    signer?: boolean
  }
  kind: 'regesta.readiness'
  ok: boolean
}

export type ReadinessCheck = () => Promise<ReadinessStatus> | ReadinessStatus
export type StatisticsRead = () =>
  | DeploymentStatistics
  | Promise<DeploymentStatistics>

export interface DeploymentStatisticsReadOptions {
  cacheTtlMs?: number
}

export interface DeploymentStatisticsReader {
  countPackages: () => number | Promise<number>
}

export interface TransportRoutesOptions {
  readiness?: ReadinessCheck
  statistics?: StatisticsRead
}

export interface TransportAppOptions {
  knownErrors?: KnownTransportError[]
  requestLog?: RequestLogSink
  requestSizeLimit?: RequestSizeLimitOptions
}

export function createTransportApp(options: TransportAppOptions = {}): Hono {
  const app = new Hono({
    getPath: (request) => registryRoutePath(request),
  })

  app.use(createRequestIdMiddleware())
  if (options.requestLog) {
    app.use(createRequestLogger(options.requestLog))
  }
  app.use(createPathNormalizationMiddleware())
  app.use(createCorsMiddleware())
  if (options.requestSizeLimit) {
    app.use(createRequestSizeLimitMiddleware(options.requestSizeLimit))
  }
  app.onError(createTransportErrorBoundary(options.knownErrors))

  return app
}

export function createDeploymentStatisticsRead(
  reader: DeploymentStatisticsReader,
  options: DeploymentStatisticsReadOptions = {},
): StatisticsRead {
  const cacheTtlMs = normalizeDeploymentStatisticsCacheTtlMs(options.cacheTtlMs)
  let cached:
    | {
        expiresAt: number
        value: Awaited<ReturnType<StatisticsRead>>
      }
    | undefined
  let pending: Promise<Awaited<ReturnType<StatisticsRead>>> | undefined

  return () => {
    const now = Date.now()

    if (cacheTtlMs > 0 && cached && cached.expiresAt > now) {
      return cached.value
    }

    pending ??= Promise.resolve(reader.countPackages())
      .then((packages) => {
        const value = normalizeDeploymentStatistics({ packages })
        if (cacheTtlMs > 0) {
          cached = {
            expiresAt: Date.now() + cacheTtlMs,
            value,
          }
        } else {
          cached = undefined
        }
        return value
      })
      .finally(() => {
        pending = undefined
      })

    return pending
  }
}

export function createTransportRoutes(
  options: TransportRoutesOptions = {},
): Hono {
  const app = new Hono()

  app.get('/', (context) => {
    return deploymentInfoResponse(context.req.method, options.statistics)
  })

  app.on('HEAD', '/', (context) => {
    return deploymentInfoResponse(context.req.method, options.statistics)
  })

  app.get('/health', (context) => {
    return healthResponse(context.req.method)
  })

  app.on('HEAD', '/health', (context) => {
    return healthResponse(context.req.method)
  })

  app.get('/ready', (context) => {
    return readinessResponse(context.req.method, options.readiness)
  })

  app.on('HEAD', '/ready', (context) => {
    return readinessResponse(context.req.method, options.readiness)
  })

  app.get('/favicon.ico', () => {
    return new Response(null, {
      headers: {
        'cache-control': 'public, max-age=86400',
      },
      status: 204,
    })
  })

  return app
}

async function deploymentInfoResponse(
  method: string,
  statistics: StatisticsRead | undefined,
): Promise<Response> {
  return transportJson(
    method,
    createDeploymentInfo({
      ...(statistics ? { statistics: await statistics() } : {}),
    }),
    {
      headers: {
        'cache-control': 'no-store',
      },
    },
  )
}

function healthResponse(method: string): Response {
  return transportJson(method, { ok: true }, { headers: noStoreHeaders() })
}

async function readinessResponse(
  method: string,
  readiness: ReadinessCheck | undefined,
): Promise<Response> {
  const status = readiness ? await readiness() : readinessStatus(true)

  return transportJson(method, status, {
    headers: noStoreHeaders(),
    status: status.ok ? 200 : 503,
  })
}

function noStoreHeaders(): Record<string, string> {
  return {
    'cache-control': 'no-store',
  }
}

function readinessStatus(ok: boolean): ReadinessStatus {
  return {
    kind: 'regesta.readiness',
    ok,
  }
}

function normalizeDeploymentStatisticsCacheTtlMs(
  cacheTtlMs: number | undefined,
): number {
  const value = cacheTtlMs ?? defaultDeploymentStatisticsCacheTtlMs

  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(
      'Deployment statistics cache TTL must be a non-negative safe integer',
    )
  }

  return value
}

function transportJson(
  method: string,
  body: unknown,
  init: ResponseInit = {},
): Response {
  const bytes = new TextEncoder().encode(JSON.stringify(body))
  const headers = new Headers(init.headers)
  headers.set('content-length', String(bytes.byteLength))
  headers.set('content-type', 'application/json; charset=UTF-8')

  return new Response(method === 'HEAD' ? null : bytes, { ...init, headers })
}
