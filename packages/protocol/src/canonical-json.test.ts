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

  it('rejects values outside canonical JSON', () => {
    expect(() => canonicalJson({ value: undefined })).toThrow(
      'Canonical JSON does not support undefined values',
    )
    expect(() => canonicalJson([undefined])).toThrow(
      'Canonical JSON does not support undefined values',
    )

    const sparseArray = [1, 3]
    sparseArray.length = 3
    expect(() => canonicalJson(sparseArray)).toThrow(
      'Canonical JSON does not support sparse arrays',
    )

    const arrayWithProperty = [1] as number[] & { extra?: number }
    arrayWithProperty.extra = 2
    expect(() => canonicalJson(arrayWithProperty)).toThrow(
      'Canonical JSON does not support array object properties',
    )

    expect(() => canonicalJson({ [Symbol('hidden')]: true })).toThrow(
      'Canonical JSON does not support symbol properties',
    )

    const objectWithNonEnumerableProperty = { value: true }
    Object.defineProperty(objectWithNonEnumerableProperty, 'hidden', {
      enumerable: false,
      value: true,
    })
    expect(() => canonicalJson(objectWithNonEnumerableProperty)).toThrow(
      'Canonical JSON does not support non-enumerable properties',
    )

    const objectWithAccessorProperty = {}
    Object.defineProperty(objectWithAccessorProperty, 'value', {
      enumerable: true,
      get: () => true,
    })
    expect(() => canonicalJson(objectWithAccessorProperty)).toThrow(
      'Canonical JSON does not support accessor properties',
    )
    expect(() => canonicalJson(new Date())).toThrow(
      'Canonical JSON only supports JSON-compatible values',
    )
    expect(() => canonicalJson(Number.NaN)).toThrow(
      'Canonical JSON does not support non-finite numbers',
    )
  })
})
