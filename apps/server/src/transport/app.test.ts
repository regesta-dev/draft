import { describe, expect, it } from 'vitest'
import { createTransportRoutes } from './app.ts'

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
