import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    conditions: ['regesta-source'],
  },
  ssr: {
    resolve: {
      conditions: ['regesta-source'],
    },
  },
})
