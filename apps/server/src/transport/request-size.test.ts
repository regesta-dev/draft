import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { createRequestSizeLimitMiddleware } from './request-size.ts'

describe('createRequestSizeLimitMiddleware', () => {
  it('lets requests through when the declared body size is within the limit', async () => {
    const app = new Hono()
    app.use(createRequestSizeLimitMiddleware({ maxBytes: 6 }))
    app.post('/publish', (context) => context.text('ok'))

    const response = await app.request('/publish', {
      body: 'upload',
      headers: {
        'content-length': '6',
      },
      method: 'POST',
    })

    expect(response.status).toBe(200)
    await expect(response.text()).resolves.toBe('ok')
  })

  it('rejects requests when the declared body size exceeds the limit', async () => {
    const app = new Hono()
    app.use(createRequestSizeLimitMiddleware({ maxBytes: 5 }))
    app.post('/publish', (context) => context.text('ok'))

    const response = await app.request('/publish', {
      body: 'upload',
      headers: {
        'content-length': '6',
      },
      method: 'POST',
    })

    expect(response.status).toBe(413)
    await expect(response.json()).resolves.toEqual({
      code: 'request_too_large',
      error: 'Request body too large',
      issues: ['content-length: Must be at most 5 bytes'],
      message: 'Request body too large',
    })
  })

  it('rejects malformed content length headers', async () => {
    const app = new Hono()
    app.use(createRequestSizeLimitMiddleware({ maxBytes: 5 }))
    app.post('/publish', (context) => context.text('ok'))

    const response = await app.request('/publish', {
      body: 'upload',
      headers: {
        'content-length': 'unknown',
      },
      method: 'POST',
    })

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({
      code: 'request_content_length_invalid',
      error: 'Invalid Content-Length header',
      message: 'Invalid Content-Length header',
    })
  })

  it('rejects oversized HEAD requests without JSON bodies', async () => {
    const app = new Hono()
    app.use(createRequestSizeLimitMiddleware({ maxBytes: 5 }))
    app.get('/probe', (context) => context.text('ok'))

    const response = await app.request('/probe', {
      headers: {
        'content-length': '6',
      },
      method: 'HEAD',
    })

    expect(response.status).toBe(413)
    expect(response.headers.get('content-type')).toBe(
      'application/json; charset=UTF-8',
    )
    expect(response.headers.get('content-length')).toBeNull()
    await expect(response.text()).resolves.toBe('')
  })

  it('rejects malformed HEAD content length headers without JSON bodies', async () => {
    const app = new Hono()
    app.use(createRequestSizeLimitMiddleware({ maxBytes: 5 }))
    app.get('/probe', (context) => context.text('ok'))

    const response = await app.request('/probe', {
      headers: {
        'content-length': 'unknown',
      },
      method: 'HEAD',
    })

    expect(response.status).toBe(400)
    expect(response.headers.get('content-type')).toBe(
      'application/json; charset=UTF-8',
    )
    expect(response.headers.get('content-length')).toBeNull()
    await expect(response.text()).resolves.toBe('')
  })

  it('rejects invalid configured limits at startup', () => {
    expect(() => createRequestSizeLimitMiddleware({ maxBytes: -1 })).toThrow(
      'Request byte limit must be a non-negative safe integer',
    )
  })
})
