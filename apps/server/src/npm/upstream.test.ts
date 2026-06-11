import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import { createNpmUpstreamFallback } from './upstream.ts'

describe('createNpmUpstreamFallback', () => {
  it('fetches npm packuments through bounded metadata requests', async () => {
    const upstreamFetch = vi.fn<typeof fetch>((input, init) => {
      expect(input).toBe('https://registry.npmjs.org/%40upstream%2Fpkg')
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
              etag: '"upstream-packument"',
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
    expect(response.headers.get('etag')).toBe('"upstream-packument"')
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
