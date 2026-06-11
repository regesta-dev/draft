import { createMemoryRegistryAdapters } from '@regesta/adapters'
import { describe, expect, it, vi } from 'vitest'
import { createNpmProjectionApp } from './app.ts'

describe('createNpmProjectionApp', () => {
  it('constructs npm projection routes with upstream fallback options', async () => {
    const upstreamFetch = vi.fn<typeof fetch>((input, init) => {
      expect(input).toBe('https://registry.npmjs.org/%40upstream%2Fpkg')
      expect(init?.credentials).toBe('omit')
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
    const app = createNpmProjectionApp(createMemoryRegistryAdapters(), {
      upstreamFetch,
      upstreamTimeoutMs: 0,
    })

    const response = await app.request('/@upstream/pkg')

    expect(response.status).toBe(200)
    expect(response.headers.get('etag')).toBe('"upstream-packument"')
    await expect(response.json()).resolves.toEqual({
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
    })
    expect(upstreamFetch).toHaveBeenCalledTimes(1)
  })
})
