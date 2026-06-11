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
    const app = createTransportApp({
      requestSizeLimit: {
        maxBytes: 3,
      },
    })
    app.post('/root/upload', (context) => context.text('ok'))

    const response = await app.request('http://registry.test/upload', {
      body: '1234',
      headers: {
        'content-length': '4',
      },
      method: 'POST',
    })

    expect(response.status).toBe(413)
    await expect(response.json()).resolves.toEqual({
      code: 'request_too_large',
      error: 'Request body too large',
      issues: ['content-length: Must be at most 3 bytes'],
      message: 'Request body too large',
    })
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
      await expect(response.text()).resolves.toBe('')
    }
  })
})

describe('createDeploymentStatisticsRead', () => {
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
