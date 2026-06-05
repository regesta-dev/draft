import { WriteAuthorizationError } from '@regesta/auth'
import { Hono } from 'hono'
import { createCoreRegistryApp } from './core-app.ts'
import { createDevLocalhostRoutes } from './dev-app.ts'
import { isDevLocalhostEnabled } from './dev-mode.ts'
import { createNpmRegistryRoutes } from './npm-app.ts'
import { RequestValidationError } from './request.ts'
import type { RegistryAdapters } from '@regesta/adapters'

export function createRegestaApp(adapters: RegistryAdapters): Hono {
  const app = new Hono({
    getPath: (request) => registryRoutePath(request),
  })

  app.onError((error, context) => {
    if (error instanceof RequestValidationError) {
      return context.json(
        {
          error: error.message,
          ...(error.issues.length === 0 ? {} : { issues: error.issues }),
        },
        400,
      )
    }

    if (error instanceof WriteAuthorizationError) {
      return context.json(
        {
          error: error.message,
          ...(error.issues.length === 0 ? {} : { issues: error.issues }),
        },
        401,
      )
    }

    return context.json({ error: 'Internal Server Error' }, 500)
  })

  app.route('/root', createCoreRegistryApp(adapters))
  app.route('/npm', createNpmRegistryRoutes(adapters))
  if (isDevLocalhostEnabled()) {
    app.route('/dev', createDevLocalhostRoutes())
  }

  return app
}

function registryRoutePath(request: Request): string {
  const url = new URL(request.url)
  const hostname = requestHostname(request)
  const prefix =
    hostname === 'dev.localhost'
      ? '/dev'
      : isNpmHostname(hostname)
        ? '/npm'
        : '/root'
  return `${prefix}${url.pathname}`
}

function requestHostname(request: Request): string {
  const host = request.headers.get('host')

  if (!host) {
    return new URL(request.url).hostname.toLowerCase()
  }

  if (host.startsWith('[')) {
    const end = host.indexOf(']')
    return end > 0 ? host.slice(1, end).toLowerCase() : host.toLowerCase()
  }

  return host.split(':', 1)[0]?.toLowerCase() ?? ''
}

function isNpmHostname(hostname: string): boolean {
  return hostname === 'npm' || hostname.startsWith('npm.')
}
