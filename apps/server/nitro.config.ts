import { defineConfig } from 'nitro'

export default defineConfig({
  devServer: {
    port: 4321,
  },
  exportConditions: ['regesta-source'],
})
