import { describe, expect, it } from 'vitest'
import { assertSourceArchivePath } from './config.ts'

describe('assertSourceArchivePath', () => {
  it('returns normalized relative archive paths', () => {
    expect(assertSourceArchivePath('regesta.json')).toBe('regesta.json')
    expect(assertSourceArchivePath('src/index.ts')).toBe('src/index.ts')
    expect(assertSourceArchivePath('docs/')).toBe('docs/')
  })

  it('rejects unsafe archive paths', () => {
    const cases: Array<{
      message: string
      path: unknown
    }> = [
      {
        message: 'Source archive path must be a string',
        path: null,
      },
      {
        message: 'Source archive path must be non-empty',
        path: '',
      },
      {
        message: 'Source archive path must not contain control characters',
        path: 'src/\nindex.ts',
      },
      {
        message: 'Source archive path must use forward slashes',
        path: String.raw`src\index.ts`,
      },
      {
        message: 'Source archive path must be relative',
        path: '/etc/passwd',
      },
      {
        message: 'Source archive path must be relative',
        path: 'C:/Users/source',
      },
      {
        message: 'Source archive path must be normalized',
        path: './src',
      },
      {
        message: 'Source archive path must be normalized',
        path: 'src//index.ts',
      },
      {
        message:
          'Source archive path must not contain parent directory segments',
        path: '../secret.txt',
      },
    ]

    for (const testCase of cases) {
      expect(() => assertSourceArchivePath(testCase.path)).toThrow(
        testCase.message,
      )
    }
  })
})
