import { describe, expect, it } from 'vitest'
import { normalizeRegestaConfig } from './config.ts'

describe('normalizeRegestaConfig', () => {
  it('rejects generic dependencies in core package config', () => {
    expect(() =>
      normalizeRegestaConfig({
        dependencies: {
          'example.com/base': '^1.0.0',
        },
        id: 'npm:example.com/hello-regesta',
        source: {
          include: ['regesta.json'],
        },
        version: '0.0.1',
      }),
    ).toThrow(
      'regesta.json dependencies are not supported; use ecosystem-native manifests',
    )
  })
})
