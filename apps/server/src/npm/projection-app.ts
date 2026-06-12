import { createNpmRegistryRoutes, type NpmRegistryRouteOptions } from './app.ts'
import {
  createNpmRegistryReader,
  type NpmRegistryReaderSource,
} from './reader.ts'
import type { Hono } from 'hono'

export type { NpmRegistryRouteOptions } from './app.ts'

export function createNpmProjectionApp(
  adapters: NpmRegistryReaderSource,
  options: NpmRegistryRouteOptions = {},
): Hono {
  return createNpmRegistryRoutes(createNpmRegistryReader(adapters), options)
}
