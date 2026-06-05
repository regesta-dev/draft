import { Hono } from 'hono'
import {
  devLocalhostDomain,
  devLocalhostDomainBinding,
  devLocalhostDomainBindingText,
  devLocalhostKeyId,
  devLocalhostPrivateKeyFileText,
  devLocalhostPublicKeyFileText,
  jsonResponse,
} from './dev-keys.ts'

export function createDevLocalhostRoutes(): Hono {
  const app = new Hono()

  app.get('/', (context) => {
    return context.json({
      domain: devLocalhostDomain,
      endpoints: {
        binding: '/.well-known/regesta.json',
        privateKey: '/regesta.private-key.json',
        publicKey: '/regesta.public-key.json',
      },
      kid: devLocalhostKeyId,
      object: 'regesta.dev-localhost',
      production: false,
    })
  })

  app.get('/.well-known/regesta.json', () => {
    return jsonResponse(devLocalhostDomainBindingText)
  })

  app.get('/regesta.public-key.json', () => {
    return jsonResponse(devLocalhostPublicKeyFileText)
  })

  app.get('/regesta.private-key.json', () => {
    return jsonResponse(devLocalhostPrivateKeyFileText)
  })

  app.get('/keys/:kid', (context) => {
    if (context.req.param('kid') !== devLocalhostKeyId) {
      return context.json({ error: 'Dev key not found' }, 404)
    }

    return context.json(devLocalhostDomainBinding.keys[0])
  })

  return app
}
