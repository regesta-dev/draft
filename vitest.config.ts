import { defineConfig } from 'vitest/config'

export default defineConfig({
  define: {
    __REGESTA_BUILD_TIME__: JSON.stringify('2026-06-08T00:00:00.000Z'),
    __REGESTA_GIT_DIRTY__: 'false',
    __REGESTA_GIT_SHA__: JSON.stringify('test-git-sha'),
    'import.meta.dev': 'true',
  },
  resolve: {
    conditions: ['regesta-source'],
  },
  ssr: {
    resolve: {
      conditions: ['regesta-source'],
    },
  },
})
