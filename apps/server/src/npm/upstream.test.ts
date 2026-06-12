import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import { createNpmUpstreamFallback } from './upstream.ts'

describe('createNpmUpstreamFallback', () => {
  it('fetches npm packuments through bounded metadata requests', async () => {
    const upstreamFetch = vi.fn<typeof fetch>((input, init) => {
      expect(input).toBe('https://registry.npmjs.org/%40upstream%2Fpkg')
      expect(init?.cache).toBe('no-store')
      expect(init?.credentials).toBe('omit')
      expect(init?.headers).toBeInstanceOf(Headers)
      expect(init?.method).toBe('GET')
      expect(init?.redirect).toBe('error')

      return Promise.resolve(
        Response.json(
          {
            'dist-tags': {
              latest: '1.0.0',
            },
            name: '@upstream/pkg',
            versions: {
              '1.0.0': {
                dist: {
                  tarball:
                    'https://registry.npmjs.org/@upstream/pkg/-/pkg-1.0.0.tgz',
                },
                name: '@upstream/pkg',
                version: '1.0.0',
              },
            },
          },
          {
            headers: {
              'cache-control': 'public, max-age=300',
              etag: '"upstream-packument"',
              'last-modified': 'Mon, 01 Jun 2026 00:00:00 GMT',
            },
          },
        ),
      )
    })
    const upstream = createNpmUpstreamFallback({
      upstreamFetch,
      upstreamTimeoutMs: 0,
    })
    const app = new Hono()
    app.get('/packument', (context) => {
      return upstream.packument(context, '@upstream/pkg')
    })

    const response = await app.request('/packument', {
      headers: {
        'if-none-match': '"client-etag"',
      },
    })

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('public, max-age=300')
    expect(response.headers.get('etag')).toBe('"upstream-packument"')
    expect(response.headers.get('last-modified')).toBe(
      'Mon, 01 Jun 2026 00:00:00 GMT',
    )
    await expect(response.json()).resolves.toMatchObject({
      'dist-tags': {
        latest: '1.0.0',
      },
      name: '@upstream/pkg',
    })
    const requestHeaders = upstreamFetch.mock.calls[0]?.[1]?.headers
    expect(requestHeaders).toBeInstanceOf(Headers)
    if (!(requestHeaders instanceof Headers)) {
      throw new TypeError('Expected upstream request headers')
    }
    expect(requestHeaders.get('if-none-match')).toBe('"client-etag"')
  })

  it('forwards only metadata headers to upstream npm metadata requests', async () => {
    const upstreamFetch = vi.fn<typeof fetch>((input, init) => {
      expect(init?.credentials).toBe('omit')
      expect(init?.headers).toBeInstanceOf(Headers)

      if (input === 'https://registry.npmjs.org/%40upstream%2Fpkg/latest') {
        return Promise.resolve(
          Response.json({
            dist: {
              tarball:
                'https://registry.npmjs.org/@upstream/pkg/-/pkg-1.0.0.tgz',
            },
            name: '@upstream/pkg',
            version: '1.0.0',
          }),
        )
      }

      if (
        input ===
        'https://registry.npmjs.org/-/package/%40upstream%2Fpkg/dist-tags'
      ) {
        return Promise.resolve(
          Response.json({
            latest: '1.0.0',
          }),
        )
      }

      return Promise.resolve(
        Response.json({
          'dist-tags': {
            latest: '1.0.0',
          },
          name: '@upstream/pkg',
          versions: {
            '1.0.0': {
              dist: {
                tarball:
                  'https://registry.npmjs.org/@upstream/pkg/-/pkg-1.0.0.tgz',
              },
              name: '@upstream/pkg',
              version: '1.0.0',
            },
          },
        }),
      )
    })
    const upstream = createNpmUpstreamFallback({
      upstreamFetch,
      upstreamTimeoutMs: 0,
    })
    const app = new Hono()
    app.get('/packument', (context) => {
      return upstream.packument(context, '@upstream/pkg')
    })
    app.get('/manifest', (context) => {
      return upstream.packageManifest(context, '@upstream/pkg', 'latest')
    })
    app.get('/dist-tags', (context) => {
      return upstream.distTags(context, '@upstream/pkg')
    })

    const requestInit = {
      headers: {
        accept: 'application/vnd.npm.install-v1+json',
        authorization: 'Bearer npm-token',
        cookie: 'npm_token=secret',
        'if-modified-since': 'Mon, 01 Jun 2026 00:00:00 GMT',
        'if-none-match': '"client-etag"',
        'npm-auth-token': 'secret',
        'x-custom-secret': 'secret',
      },
    }

    await app.request('/packument', requestInit)
    await app.request('/manifest', requestInit)
    await app.request('/dist-tags', requestInit)

    expect(upstreamFetch).toHaveBeenCalledTimes(3)
    for (const [, init] of upstreamFetch.mock.calls) {
      expect(init?.cache).toBe('no-store')
      expect(init?.credentials).toBe('omit')
      expect(init?.redirect).toBe('error')
      const requestHeaders = init?.headers
      expect(requestHeaders).toBeInstanceOf(Headers)
      if (!(requestHeaders instanceof Headers)) {
        throw new TypeError('Expected upstream request headers')
      }
      expect([...requestHeaders.entries()].toSorted()).toEqual([
        ['accept', 'application/vnd.npm.install-v1+json'],
        ['if-modified-since', 'Mon, 01 Jun 2026 00:00:00 GMT'],
        ['if-none-match', '"client-etag"'],
      ])
    }
  })

  it('returns only metadata headers from upstream npm metadata responses', async () => {
    const body = {
      'dist-tags': {
        latest: '1.0.0',
      },
      name: '@upstream/pkg',
      versions: {
        '1.0.0': {
          dist: {
            tarball: 'https://registry.npmjs.org/@upstream/pkg/-/pkg-1.0.0.tgz',
          },
          name: '@upstream/pkg',
          version: '1.0.0',
        },
      },
    }
    const upstreamFetch = vi.fn<typeof fetch>(() => {
      return Promise.resolve(
        Response.json(body, {
          headers: {
            'cache-control': 'public, max-age=300',
            connection: 'keep-alive',
            'content-type': 'application/json',
            etag: '"upstream-packument"',
            'last-modified': 'Mon, 01 Jun 2026 00:00:00 GMT',
            location: 'https://registry.npmjs.org/login',
            'set-cookie': 'npm_token=secret',
            'www-authenticate': 'Bearer realm="npm"',
            'x-upstream-secret': 'secret',
          },
        }),
      )
    })
    const upstream = createNpmUpstreamFallback({
      upstreamFetch,
      upstreamTimeoutMs: 0,
    })
    const app = new Hono()
    app.get('/packument', (context) => {
      return upstream.packument(context, '@upstream/pkg')
    })

    const response = await app.request('/packument')

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('public, max-age=300')
    expect(response.headers.get('content-length')).toBeTypeOf('string')
    expect(response.headers.get('content-type')).toBe('application/json')
    expect(response.headers.get('etag')).toBe('"upstream-packument"')
    expect(response.headers.get('last-modified')).toBe(
      'Mon, 01 Jun 2026 00:00:00 GMT',
    )
    expect(response.headers.get('connection')).toBeNull()
    expect(response.headers.get('location')).toBeNull()
    expect(response.headers.get('set-cookie')).toBeNull()
    expect(response.headers.get('www-authenticate')).toBeNull()
    expect(response.headers.get('x-upstream-secret')).toBeNull()
    await expect(response.json()).resolves.toEqual(body)
  })

  it('returns only metadata headers for upstream npm HEAD metadata responses', async () => {
    const upstreamFetch = vi.fn<typeof fetch>((_, init) => {
      expect(init?.method).toBe('HEAD')

      return Promise.resolve(
        Response.json(
          {
            name: '@upstream/pkg',
          },
          {
            headers: {
              'cache-control': 'public, max-age=300',
              connection: 'keep-alive',
              'content-length': '999',
              'content-type': 'application/json',
              etag: '"upstream-packument"',
              'last-modified': 'Mon, 01 Jun 2026 00:00:00 GMT',
              location: 'https://registry.npmjs.org/login',
              'set-cookie': 'npm_token=secret',
              'www-authenticate': 'Bearer realm="npm"',
              'x-upstream-secret': 'secret',
            },
          },
        ),
      )
    })
    const upstream = createNpmUpstreamFallback({
      upstreamFetch,
      upstreamTimeoutMs: 0,
    })
    const app = new Hono()
    app.get('/packument', (context) => {
      return upstream.packument(context, '@upstream/pkg')
    })

    const response = await app.request('/packument', {
      method: 'HEAD',
    })

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('public, max-age=300')
    expect(response.headers.get('content-length')).toBeNull()
    expect(response.headers.get('content-type')).toBe('application/json')
    expect(response.headers.get('etag')).toBe('"upstream-packument"')
    expect(response.headers.get('last-modified')).toBe(
      'Mon, 01 Jun 2026 00:00:00 GMT',
    )
    expect(response.headers.get('connection')).toBeNull()
    expect(response.headers.get('location')).toBeNull()
    expect(response.headers.get('set-cookie')).toBeNull()
    expect(response.headers.get('www-authenticate')).toBeNull()
    expect(response.headers.get('x-upstream-secret')).toBeNull()
    await expect(response.text()).resolves.toBe('')
  })

  it('passes through upstream npm not-modified metadata responses without bodies', async () => {
    const upstreamFetch = vi.fn<typeof fetch>((input, init) => {
      expect(input).toBe('https://registry.npmjs.org/%40upstream%2Fpkg')
      expect(init?.method).toBe('GET')

      return Promise.resolve(
        new Response(null, {
          headers: {
            'cache-control': 'public, max-age=300',
            connection: 'keep-alive',
            etag: '"upstream-packument"',
            'last-modified': 'Mon, 01 Jun 2026 00:00:00 GMT',
            location: 'https://registry.npmjs.org/login',
            'set-cookie': 'npm_token=secret',
            'www-authenticate': 'Bearer realm="npm"',
            'x-upstream-secret': 'secret',
          },
          status: 304,
          statusText: 'Not Modified',
        }),
      )
    })
    const upstream = createNpmUpstreamFallback({
      upstreamFetch,
      upstreamTimeoutMs: 0,
    })
    const app = new Hono()
    app.get('/packument', (context) => {
      return upstream.packument(context, '@upstream/pkg')
    })

    const response = await app.request('/packument', {
      headers: {
        'if-modified-since': 'Mon, 01 Jun 2026 00:00:00 GMT',
        'if-none-match': '"client-etag"',
      },
    })

    expect(response.status).toBe(304)
    expect(response.statusText).toBe('Not Modified')
    expect(response.headers.get('cache-control')).toBe('public, max-age=300')
    expect(response.headers.get('etag')).toBe('"upstream-packument"')
    expect(response.headers.get('last-modified')).toBe(
      'Mon, 01 Jun 2026 00:00:00 GMT',
    )
    expect(response.headers.get('connection')).toBeNull()
    expect(response.headers.get('location')).toBeNull()
    expect(response.headers.get('set-cookie')).toBeNull()
    expect(response.headers.get('www-authenticate')).toBeNull()
    expect(response.headers.get('x-upstream-secret')).toBeNull()
    await expect(response.text()).resolves.toBe('')
    const requestHeaders = upstreamFetch.mock.calls[0]?.[1]?.headers
    expect(requestHeaders).toBeInstanceOf(Headers)
    if (!(requestHeaders instanceof Headers)) {
      throw new TypeError('Expected upstream request headers')
    }
    expect(requestHeaders.get('if-modified-since')).toBe(
      'Mon, 01 Jun 2026 00:00:00 GMT',
    )
    expect(requestHeaders.get('if-none-match')).toBe('"client-etag"')
  })

  it('serves upstream npm HEAD failures without JSON bodies', async () => {
    const upstreamError = new Error('upstream unavailable')
    const upstreamFetch = vi.fn<typeof fetch>((_, init) => {
      expect(init?.method).toBe('HEAD')

      return Promise.reject(upstreamError)
    })
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined)
    const upstream = createNpmUpstreamFallback({
      upstreamFetch,
      upstreamTimeoutMs: 0,
    })
    const app = new Hono()
    app.get('/packument', (context) => {
      return upstream.packument(context, '@upstream/pkg')
    })

    try {
      const response = await app.request('/packument', {
        method: 'HEAD',
      })

      expect(response.status).toBe(502)
      expect(response.headers.get('content-type')).toBe(
        'application/json; charset=UTF-8',
      )
      expect(response.headers.get('content-length')).toBeNull()
      await expect(response.text()).resolves.toBe('')
      expect(consoleError).toHaveBeenCalledWith(
        'Upstream npm registry request failed',
        expect.objectContaining({
          error: upstreamError,
          kind: 'regesta.npm-upstream-failure',
          url: 'https://registry.npmjs.org/%40upstream%2Fpkg',
        }),
      )
    } finally {
      consoleError.mockRestore()
    }
  })

  it('does not log invalid raw request ids for upstream failures', async () => {
    const upstreamError = new Error('upstream unavailable')
    const upstreamFetch = vi.fn<typeof fetch>(() =>
      Promise.reject(upstreamError),
    )
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined)
    const upstream = createNpmUpstreamFallback({
      upstreamFetch,
      upstreamTimeoutMs: 0,
    })
    const app = new Hono()
    app.get('/packument', (context) => {
      return upstream.packument(context, '@upstream/pkg')
    })

    try {
      const response = await app.request('/packument', {
        headers: {
          'x-request-id': 'invalid request id',
        },
      })

      expect(response.status).toBe(502)
      expect(consoleError).toHaveBeenCalledWith(
        'Upstream npm registry request failed',
        expect.not.objectContaining({
          requestId: 'invalid request id',
        }),
      )
    } finally {
      consoleError.mockRestore()
    }
  })

  it('builds npm tarball redirect URLs without fetching tarball bytes', () => {
    const upstreamFetch = vi.fn<typeof fetch>()
    const upstream = createNpmUpstreamFallback({
      upstreamFetch,
      upstreamTimeoutMs: 0,
    })

    expect(upstream.tarballUrl('@upstream/pkg', 'pkg-1.0.0.tgz')).toBe(
      'https://registry.npmjs.org/%40upstream%2Fpkg/-/pkg-1.0.0.tgz',
    )
    expect(upstreamFetch).not.toHaveBeenCalled()
  })
})
