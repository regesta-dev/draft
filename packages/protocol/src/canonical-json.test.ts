import { describe, expect, it } from 'vitest'
import { canonicalJson } from './canonical-json.ts'

describe('canonicalJson', () => {
  it('sorts object keys recursively', () => {
    expect(
      canonicalJson({
        z: true,
        a: {
          y: 2,
          x: 1,
        },
      }),
    ).toBe('{"a":{"x":1,"y":2},"z":true}')
  })
})
