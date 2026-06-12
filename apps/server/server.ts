import process from 'node:process'
import { createLocalRegistryAdapters } from '@regesta/adapters'
import { createRegestaApp } from './src/app.ts'
import { regestaAppOptionsFromRuntimeOptions } from './src/runtime-app-options.ts'
import { runtimeOptionsFromEnv } from './src/runtime-options.ts'
import type { Hono } from 'hono'

const dataDir = process.env.REGESTA_DATA_DIR ?? '.regesta-data'
const app: Hono = createRegestaApp(createLocalRegistryAdapters(dataDir), {
  ...regestaAppOptionsFromRuntimeOptions(runtimeOptionsFromEnv(process.env)),
  requestLog(entry) {
    console.info(JSON.stringify(entry))
  },
  auditLog(entry) {
    console.info(JSON.stringify(entry))
  },
})

// eslint-disable-next-line import/no-default-export
export default app
