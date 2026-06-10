import { Hono } from 'hono'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTransportErrorBoundary } from './errors.ts'
import {
  createRequestIdMiddleware,
  createRequestLogger,
  type RequestLogEntry,
} from './logging.ts'

class ExpectedError extends Error {
  override readonly name = 'ExpectedError'
}

describe('createRequestLogger', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('logs the final mapped response status', async () => {
    const entries: RequestLogEntry[] = []
    const app = new Hono()
    app.use(
      createRequestLogger((entry) => {
        entries.push(entry)
      }),
    )
    app.onError(
      createTransportErrorBoundary([
        {
          code: 'expected_error',
          match: (error) => error instanceof ExpectedError,
          status: 400,
        },
      ]),
    )
    app.get('/known', () => {
      throw new ExpectedError('Known request error')
    })

    const response = await app.request('http://registry.test/known')

    expect(response.status).toBe(400)
    expect(response.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/u)
    expect(entries).toMatchObject([
      {
        host: 'registry.test',
        kind: 'regesta.request',
        method: 'GET',
        path: '/known',
        requestId: response.headers.get('x-request-id'),
        status: 400,
      },
    ])
  })

  it('preserves valid client request ids in responses and logs', async () => {
    const entries: RequestLogEntry[] = []
    const app = new Hono()
    app.use(
      createRequestLogger((entry) => {
        entries.push(entry)
      }),
    )
    app.get('/ok', (context) => context.text('ok'))

    const response = await app.request('http://registry.test/ok', {
      headers: {
        'x-request-id': 'publish-01HZX2V4Q5R6',
      },
    })

    expect(response.status).toBe(200)
    expect(response.headers.get('x-request-id')).toBe('publish-01HZX2V4Q5R6')
    expect(entries).toMatchObject([
      {
        kind: 'regesta.request',
        path: '/ok',
        requestId: 'publish-01HZX2V4Q5R6',
        status: 200,
      },
    ])
  })

  it('logs the request id created by the request-id middleware', async () => {
    const entries: RequestLogEntry[] = []
    const app = new Hono()
    app.use(createRequestIdMiddleware())
    app.use(
      createRequestLogger((entry) => {
        entries.push(entry)
      }),
    )
    app.get('/ok', (context) => context.text('ok'))

    const response = await app.request('http://registry.test/ok')

    expect(response.status).toBe(200)
    expect(response.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/u)
    expect(entries).toMatchObject([
      {
        kind: 'regesta.request',
        requestId: response.headers.get('x-request-id'),
        status: 200,
      },
    ])
  })

  it('does not fail requests when the log sink throws', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const app = new Hono()
    app.use(
      createRequestLogger(() => {
        throw new Error('log sink failed')
      }),
    )
    app.onError(createTransportErrorBoundary())
    app.get('/ok', (context) => context.text('ok'))

    const response = await app.request('/ok')

    expect(response.status).toBe(200)
    await expect(response.text()).resolves.toBe('ok')
    expect(consoleError).toHaveBeenCalledWith(
      'Transport request log sink failed',
      expect.objectContaining({
        error: expect.any(Error),
        kind: 'regesta.request-log-error',
        method: 'GET',
        path: '/ok',
        requestId: response.headers.get('x-request-id'),
        status: 200,
      }),
    )
  })
})
