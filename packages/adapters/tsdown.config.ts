import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: 'src/index.ts',
  exports: {
    devExports: 'regesta-source',
  },
})
