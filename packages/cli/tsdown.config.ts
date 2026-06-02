import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: 'src/index.ts',
  exports: {
    bin: {
      regesta: './src/index.ts',
    },
    devExports: 'regesta-source',
  },
})
