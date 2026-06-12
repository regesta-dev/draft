// @ts-check
import { sxzz } from '@sxzz/eslint-config'

export default sxzz(
  {},
  {
    ignores: [
      'dist',
      'coverage',
      '.regesta-data',
      'docs/.vitepress/.temp',
      'docs/.vitepress/cache',
    ],
  },
)
