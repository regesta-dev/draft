import process from 'node:process'
import { createLocalRegistryAdapters } from '@regesta/adapters'
import { createRegestaApp } from './src/app.ts'
import type { Hono } from 'hono'

const dataDir = process.env.REGESTA_DATA_DIR ?? '.regesta-data'
const app: Hono = createRegestaApp(createLocalRegistryAdapters(dataDir))

// eslint-disable-next-line import/no-default-export
export default app
