import { Hono } from 'hono'
import { createDeploymentInfo } from './build-info.ts'

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

export interface TransportRoutesOptions {
  readiness?: ReadinessCheck
}

export function createTransportRoutes(
  options: TransportRoutesOptions = {},
): Hono {
  const app = new Hono()

  app.get('/', (context) => {
    return transportJson(context.req.method, createDeploymentInfo())
  })

  app.on('HEAD', '/', (context) => {
    return transportJson(context.req.method, createDeploymentInfo())
  })

  app.get('/health', (context) => {
    return transportJson(context.req.method, { ok: true })
  })

  app.on('HEAD', '/health', (context) => {
    return transportJson(context.req.method, { ok: true })
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

async function readinessResponse(
  method: string,
  readiness: ReadinessCheck | undefined,
): Promise<Response> {
  const status = readiness ? await readiness() : readinessStatus(true)

  return transportJson(method, status, {
    headers: {
      'cache-control': 'no-store',
    },
    status: status.ok ? 200 : 503,
  })
}

function readinessStatus(ok: boolean): ReadinessStatus {
  return {
    kind: 'regesta.readiness',
    ok,
  }
}

function transportJson(
  method: string,
  body: unknown,
  init: ResponseInit = {},
): Response {
  const headers = new Headers(init.headers)
  headers.set('content-type', 'application/json; charset=UTF-8')

  return method === 'HEAD'
    ? new Response(null, { ...init, headers })
    : Response.json(body, { ...init, headers })
}
