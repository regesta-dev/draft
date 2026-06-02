import process from 'node:process'
import { serve } from '@hono/node-server'
import { createLocalRegistryAdapters } from '@regesta/adapters'
import { createRegestaApp } from './app.ts'

const port = Number.parseInt(process.env.REGESTA_PORT ?? '4321', 10)
const hostname = process.env.REGESTA_HOST ?? '127.0.0.1'
const dataDir = process.env.REGESTA_DATA_DIR ?? '.regesta-data'

const adapters = createLocalRegistryAdapters(dataDir)
const app = createRegestaApp(adapters)

serve({
  fetch: app.fetch,
  hostname,
  port,
})

console.info(`Regesta server listening on http://${hostname}:${port}`)
