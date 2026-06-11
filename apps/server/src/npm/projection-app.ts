import { createNpmRegistryRoutes, type NpmRegistryRouteOptions } from './app.ts'
import { createNpmRegistryReader } from './reader.ts'
import type { RegistryAdapters } from '@regesta/core'
import type { Hono } from 'hono'

export type { NpmRegistryRouteOptions } from './app.ts'

export function createNpmProjectionApp(
  adapters: Pick<RegistryAdapters, 'database'>,
  options: NpmRegistryRouteOptions = {},
): Hono {
  return createNpmRegistryRoutes(createNpmRegistryReader(adapters), options)
}
