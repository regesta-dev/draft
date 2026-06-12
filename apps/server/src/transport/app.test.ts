import { describe, expect, it, vi } from 'vitest'
import {
  createDeploymentStatisticsRead,
  createTransportApp,
  createTransportRoutes,
} from './app.ts'
import type { RequestLogEntry } from './logging.ts'

class ExpectedTransportError extends Error {
  override readonly name = 'ExpectedTransportError'
  readonly issues = ['field: Must be valid']
}

describe('createTransportApp', () => {
  it('applies hostname-aware routing at the transport shell', async () => {
    const app = createTransportApp()
    app.get('/npm/package', (context) => context.text('npm projection'))
    app.get('/root/package', (context) => context.text('core registry'))

    const npm = await app.request('http://npm.registry.test/package')
    const root = await app.request('http://registry.test/package')

    expect(npm.status).toBe(200)
    await expect(npm.text()).resolves.toBe('npm projection')
    expect(root.status).toBe(200)
    await expect(root.text()).resolves.toBe('core registry')
  })

  it('applies request ids, request logging, and known error mapping', async () => {
    const entries: RequestLogEntry[] = []
    const app = createTransportApp({
      knownErrors: [
        {
          code: 'expected_transport_error',
          match: (error) => error instanceof ExpectedTransportError,
          status: 422,
        },
      ],
      requestLog: (entry) => {
        entries.push(entry)
      },
    })
    app.get('/root/known', () => {
      throw new ExpectedTransportError('Known transport error')
    })

    const response = await app.request('http://registry.test/known', {
      headers: {
        'x-request-id': 'transport-shell-001',
      },
    })

    expect(response.status).toBe(422)
    expect(response.headers.get('x-request-id')).toBe('transport-shell-001')
    await expect(response.json()).resolves.toEqual({
      code: 'expected_transport_error',
      error: 'Known transport error',
      issues: ['field: Must be valid'],
      message: 'Known transport error',
    })
    expect(entries).toMatchObject([
      {
        host: 'registry.test',
        kind: 'regesta.request',
        method: 'GET',
        path: '/known',
        requestId: 'transport-shell-001',
        status: 422,
      },
    ])
  })

  it('applies configured request size limits at the transport shell', async () => {
    const entries: RequestLogEntry[] = []
    const app = createTransportApp({
      requestLog: (entry) => {
        entries.push(entry)
      },
      requestSizeLimit: {
        maxBytes: 3,
      },
    })
    const route = vi.fn((context) => context.text('ok'))
    app.post('/root/upload', route)

    const response = await app.request('http://registry.test/upload', {
      body: '1234',
      headers: {
        'content-length': '4',
        'x-request-id': 'request-too-large-001',
      },
      method: 'POST',
    })

    expect(response.status).toBe(413)
    expect(response.headers.get('x-request-id')).toBe('request-too-large-001')
    await expect(response.json()).resolves.toEqual({
      code: 'request_too_large',
      error: 'Request body too large',
      issues: ['content-length: Must be at most 3 bytes'],
      message: 'Request body too large',
    })
    expect(route).not.toHaveBeenCalled()
    expect(entries).toMatchObject([
      {
        host: 'registry.test',
        kind: 'regesta.request',
        method: 'POST',
        path: '/upload',
        requestId: 'request-too-large-001',
        status: 413,
      },
    ])
  })

  it('rejects malformed content length at the transport shell', async () => {
    const entries: RequestLogEntry[] = []
    const app = createTransportApp({
      requestLog: (entry) => {
        entries.push(entry)
      },
      requestSizeLimit: {
        maxBytes: 3,
      },
    })
    const route = vi.fn((context) => context.text('ok'))
    app.post('/root/upload', route)

    const response = await app.request('http://registry.test/upload', {
      body: '1234',
      headers: {
        'content-length': 'unknown',
        'x-request-id': 'content-length-invalid-001',
      },
      method: 'POST',
    })

    expect(response.status).toBe(400)
    expect(response.headers.get('x-request-id')).toBe(
      'content-length-invalid-001',
    )
    await expect(response.json()).resolves.toEqual({
      code: 'request_content_length_invalid',
      error: 'Invalid Content-Length header',
      message: 'Invalid Content-Length header',
    })
    expect(route).not.toHaveBeenCalled()
    expect(entries).toMatchObject([
      {
        host: 'registry.test',
        kind: 'regesta.request',
        method: 'POST',
        path: '/upload',
        requestId: 'content-length-invalid-001',
        status: 400,
      },
    ])
  })

  it('handles CORS preflights before request size limits and mounted routes', async () => {
    const entries: RequestLogEntry[] = []
    const app = createTransportApp({
      requestLog: (entry) => {
        entries.push(entry)
      },
      requestSizeLimit: {
        maxBytes: 3,
      },
    })
    const route = vi.fn(() => {
      throw new Error('preflight must not reach mounted routes')
    })
    app.post('/root/releases', route)

    const response = await app.request('http://registry.test/releases', {
      headers: {
        'access-control-request-headers': 'content-type',
        'access-control-request-method': 'POST',
        'content-length': '4',
        origin: 'https://client.example',
        'x-request-id': 'cors-preflight-001',
      },
      method: 'OPTIONS',
    })

    expect(response.status).toBe(204)
    expect(response.headers.get('x-request-id')).toBe('cors-preflight-001')
    expect(response.headers.get('access-control-allow-origin')).toBe('*')
    expect(response.headers.get('access-control-allow-methods')).toContain(
      'POST',
    )
    expect(route).not.toHaveBeenCalled()
    expect(entries).toMatchObject([
      {
        host: 'registry.test',
        kind: 'regesta.request',
        method: 'OPTIONS',
        path: '/releases',
        requestId: 'cors-preflight-001',
        status: 204,
      },
    ])
  })
})

describe('createTransportRoutes', () => {
  it('serves schema-complete deployment statistics without a statistics reader', async () => {
    const app = createTransportRoutes()

    const response = await app.request('/')

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    await expect(response.json()).resolves.toMatchObject({
      object: 'regesta.deployment-info',
      statistics: {
        packages: 0,
      },
    })
  })

  it('serves health status without cache storage', async () => {
    const app = createTransportRoutes()

    const response = await app.request('/health')

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    await expect(response.json()).resolves.toEqual({ ok: true })
  })

  it('serves status route headers without cache storage', async () => {
    const app = createTransportRoutes()

    for (const path of ['/', '/health', '/ready']) {
      const response = await app.request(path, { method: 'HEAD' })

      expect(response.status).toBe(200)
      expect(response.headers.get('cache-control')).toBe('no-store')
      expect(response.headers.get('content-length')).toBeNull()
      await expect(response.text()).resolves.toBe('')
    }
  })

  it('does not read deployment statistics for root HEAD requests', async () => {
    const statistics = vi.fn(() => {
      throw new Error('HEAD root must not read deployment statistics')
    })
    const app = createTransportRoutes({ statistics })

    const response = await app.request('/', { method: 'HEAD' })

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('content-type')).toBe(
      'application/json; charset=UTF-8',
    )
    await expect(response.text()).resolves.toBe('')
    expect(statistics).not.toHaveBeenCalled()
  })
})

describe('createDeploymentStatisticsRead', () => {
  it('coalesces concurrent statistics refresh reads', async () => {
    let resolvePackages: (packages: number) => void = () => {}
    const packages = new Promise<number>((resolve) => {
      resolvePackages = resolve
    })
    const countPackages = vi
      .fn<() => Promise<number>>()
      .mockReturnValue(packages)
    const readStatistics = createDeploymentStatisticsRead(
      {
        countPackages,
      },
      {
        cacheTtlMs: 25,
      },
    )

    const firstRead = readStatistics()
    const secondRead = readStatistics()

    expect(firstRead).toBe(secondRead)
    expect(countPackages).toHaveBeenCalledTimes(1)

    resolvePackages(13)
    await expect(Promise.all([firstRead, secondRead])).resolves.toEqual([
      { packages: 13 },
      { packages: 13 },
    ])
    expect(readStatistics()).toEqual({ packages: 13 })
    expect(countPackages).toHaveBeenCalledTimes(1)
  })

  it('serves stale cached statistics when a synchronous refresh read fails', async () => {
    const dateNow = vi.spyOn(Date, 'now').mockReturnValue(1_000)
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const refreshError = new Error('statistics adapter sync failure')
    const countPackages = vi
      .fn<() => number>()
      .mockReturnValueOnce(8)
      .mockImplementationOnce(() => {
        throw refreshError
      })
    const readStatistics = createDeploymentStatisticsRead(
      {
        countPackages,
      },
      {
        cacheTtlMs: 25,
      },
    )

    try {
      await expect(readStatistics()).resolves.toEqual({ packages: 8 })
      dateNow.mockReturnValue(1_025)

      expect(readStatistics()).toEqual({ packages: 8 })
      expect(countPackages).toHaveBeenCalledTimes(2)
      expect(consoleError).toHaveBeenCalledWith(
        'Deployment statistics refresh failed; serving cached value',
        {
          error: refreshError,
          kind: 'regesta.deployment-statistics-refresh-failure',
        },
      )
    } finally {
      consoleError.mockRestore()
      dateNow.mockRestore()
    }
  })

  it('serves stale cached statistics when an asynchronous refresh read fails', async () => {
    const dateNow = vi.spyOn(Date, 'now').mockReturnValue(1_000)
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const refreshError = new Error('statistics adapter async failure')
    const countPackages = vi
      .fn<() => Promise<number>>()
      .mockResolvedValueOnce(21)
      .mockRejectedValueOnce(refreshError)
    const readStatistics = createDeploymentStatisticsRead(
      {
        countPackages,
      },
      {
        cacheTtlMs: 25,
      },
    )

    try {
      await expect(readStatistics()).resolves.toEqual({ packages: 21 })
      dateNow.mockReturnValue(1_025)

      await expect(readStatistics()).resolves.toEqual({ packages: 21 })
      expect(countPackages).toHaveBeenCalledTimes(2)
      expect(consoleError).toHaveBeenCalledWith(
        'Deployment statistics refresh failed; serving cached value',
        {
          error: refreshError,
          kind: 'regesta.deployment-statistics-refresh-failure',
        },
      )
    } finally {
      consoleError.mockRestore()
      dateNow.mockRestore()
    }
  })

  it('throws synchronous statistics read failures when no cached value exists', () => {
    const readError = new Error('statistics adapter cold failure')
    const readStatistics = createDeploymentStatisticsRead({
      countPackages: () => {
        throw readError
      },
    })

    expect(() => readStatistics()).toThrow(readError)
  })
})
