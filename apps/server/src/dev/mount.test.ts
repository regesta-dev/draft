import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { devLocalhostDomainBinding, devLocalhostKeyId } from './keys.ts'
import { mountDevLocalhostRoutes } from './mount.ts'

describe('mountDevLocalhostRoutes', () => {
  it('mounts fixed dev.localhost routes behind the dev host prefix', async () => {
    const app = new Hono({
      getPath: (request) => {
        const url = new URL(request.url)
        return url.hostname === 'dev.localhost'
          ? `/dev${url.pathname}`
          : url.pathname
      },
    })
    mountDevLocalhostRoutes(app)

    const info = await app.request('http://dev.localhost/')
    const binding = await app.request(
      'http://dev.localhost/.well-known/regesta.json',
    )
    const publicKey = await app.request(
      `http://dev.localhost/keys/${devLocalhostKeyId}`,
    )

    expect(info.status).toBe(200)
    await expect(info.json()).resolves.toMatchObject({
      domain: 'dev.localhost',
      kid: devLocalhostKeyId,
      object: 'regesta.dev-localhost',
      production: false,
    })
    expect(binding.status).toBe(200)
    await expect(binding.json()).resolves.toEqual(devLocalhostDomainBinding)
    expect(publicKey.status).toBe(200)
    await expect(publicKey.json()).resolves.toEqual(
      devLocalhostDomainBinding.keys[0],
    )
  })
})
