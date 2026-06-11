import process from 'node:process'
import type { Hono } from 'hono'

export function mountDevLocalhostRoutes(app: Hono): void {
  if (!shouldMountDevLocalhostRoutes()) {
    return
  }

  const devApp = import('./app.ts').then(({ createDevLocalhostRoutes }) =>
    createDevLocalhostRoutes(),
  )

  app.all('/dev/*', async (context) => (await devApp).fetch(context.req.raw))
}

function shouldMountDevLocalhostRoutes(): boolean {
  return import.meta.dev || process.env.NODE_ENV === 'development'
}
