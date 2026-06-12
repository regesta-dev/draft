import { Hono } from 'hono'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTransportErrorBoundary } from './errors.ts'
import { createRequestIdMiddleware } from './logging.ts'

class ExpectedError extends Error {
  override readonly name = 'ExpectedError'
  readonly issues = ['field: Must be valid']
}

describe('createTransportErrorBoundary', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('maps known errors to structured JSON responses', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const app = new Hono()
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

    const response = await app.request('/known')

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({
      code: 'expected_error',
      error: 'Known request error',
      issues: ['field: Must be valid'],
      message: 'Known request error',
    })
    expect(consoleError).not.toHaveBeenCalled()
  })

  it('maps known HEAD errors without serializing response bodies', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const app = new Hono()
    app.onError(
      createTransportErrorBoundary([
        {
          code: 'expected_error',
          match: (error) => error instanceof ExpectedError,
          status: 400,
        },
      ]),
    )
    app.get('/known-head', () => {
      throw new ExpectedError('Known request error')
    })

    const response = await app.request('/known-head', {
      method: 'HEAD',
    })

    expect(response.status).toBe(400)
    expect(response.headers.get('content-type')).toBe(
      'application/json; charset=UTF-8',
    )
    expect(response.headers.get('content-length')).toBeNull()
    expect(await response.text()).toBe('')
    expect(consoleError).not.toHaveBeenCalled()
  })

  it('uses public messages for known errors when configured', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const app = new Hono()
    app.onError(
      createTransportErrorBoundary([
        {
          code: 'expected_error',
          match: (error) => error instanceof ExpectedError,
          message: 'Public request error',
          status: 400,
        },
      ]),
    )
    app.get('/known-public-message', () => {
      throw new ExpectedError('Internal known request details')
    })

    const response = await app.request('/known-public-message')

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({
      code: 'expected_error',
      error: 'Public request error',
      issues: ['field: Must be valid'],
      message: 'Public request error',
    })
    expect(consoleError).not.toHaveBeenCalled()
  })

  it('logs unknown errors and hides their details', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const app = new Hono()
    app.use(createRequestIdMiddleware())
    app.onError(createTransportErrorBoundary())
    app.get('/unknown', () => {
      throw new Error('database password leaked in exception')
    })

    const response = await app.request('/unknown', {
      headers: {
        'x-request-id': 'error-001',
      },
    })

    expect(response.status).toBe(500)
    expect(response.headers.get('x-request-id')).toBe('error-001')
    await expect(response.json()).resolves.toEqual({
      code: 'internal_server_error',
      error: 'Internal Server Error',
      message: 'Internal Server Error',
    })
    expect(consoleError).toHaveBeenCalledWith(
      'Unexpected transport error',
      expect.objectContaining({
        error: expect.any(Error),
        kind: 'regesta.unexpected-error',
        requestId: 'error-001',
      }),
    )
  })

  it('logs unknown HEAD errors without serializing response bodies', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const app = new Hono()
    app.use(createRequestIdMiddleware())
    app.onError(createTransportErrorBoundary())
    app.get('/unknown-head', () => {
      throw new Error('database password leaked in exception')
    })

    const response = await app.request('/unknown-head', {
      headers: {
        'x-request-id': 'head-error-001',
      },
      method: 'HEAD',
    })

    expect(response.status).toBe(500)
    expect(response.headers.get('x-request-id')).toBe('head-error-001')
    expect(response.headers.get('content-type')).toBe(
      'application/json; charset=UTF-8',
    )
    expect(response.headers.get('content-length')).toBeNull()
    expect(await response.text()).toBe('')
    expect(consoleError).toHaveBeenCalledWith(
      'Unexpected transport error',
      expect.objectContaining({
        error: expect.any(Error),
        kind: 'regesta.unexpected-error',
        requestId: 'head-error-001',
      }),
    )
  })
})
