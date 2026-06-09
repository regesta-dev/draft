export type CanonicalJsonValue =
  | boolean
  | null
  | number
  | string
  | CanonicalJsonValue[]
  | { [key: string]: CanonicalJsonValue }

export interface CanonicalJsonCodec {
  stringify: (value: unknown) => string
}

export const defaultCanonicalJsonCodec: CanonicalJsonCodec = {
  stringify: canonicalJson,
}

export function canonicalJson(value: unknown): string {
  return stringifyCanonical(value)
}

function stringifyCanonical(value: unknown): string {
  if (value === undefined) {
    throw new TypeError('Canonical JSON does not support undefined values')
  }

  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'string'
  ) {
    return JSON.stringify(value)
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('Canonical JSON does not support non-finite numbers')
    }

    return JSON.stringify(value)
  }

  if (Array.isArray(value)) {
    assertNoSymbolProperties(value)
    assertNoArrayObjectProperties(value)

    const items: string[] = []

    for (let index = 0; index < value.length; index++) {
      if (!Object.prototype.hasOwnProperty.call(value, index)) {
        throw new TypeError('Canonical JSON does not support sparse arrays')
      }

      items.push(stringifyCanonical(value[index]))
    }

    return `[${items.join(',')}]`
  }

  if (!isPlainRecord(value)) {
    throw new TypeError('Canonical JSON only supports JSON-compatible values')
  }

  assertNoSymbolProperties(value)
  assertPlainDataProperties(value)

  const keys = Object.keys(value).toSorted()
  const entries = keys.map((key) => {
    return `${JSON.stringify(key)}:${stringifyCanonical(value[key])}`
  })
  return `{${entries.join(',')}}`
}

function assertNoArrayObjectProperties(value: unknown[]): void {
  for (const property of Object.getOwnPropertyNames(value)) {
    if (property === 'length') {
      continue
    }

    if (!isArrayIndexProperty(property)) {
      throw new TypeError(
        'Canonical JSON does not support array object properties',
      )
    }
  }
}

function assertNoSymbolProperties(value: object): void {
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new TypeError('Canonical JSON does not support symbol properties')
  }
}

function assertPlainDataProperties(value: Record<string, unknown>): void {
  for (const key of Object.getOwnPropertyNames(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)

    if (!descriptor?.enumerable) {
      throw new TypeError(
        'Canonical JSON does not support non-enumerable properties',
      )
    }

    if (!('value' in descriptor)) {
      throw new TypeError('Canonical JSON does not support accessor properties')
    }
  }
}

function isArrayIndexProperty(value: string): boolean {
  const index = Number(value)
  return (
    String(index) === value &&
    Number.isInteger(index) &&
    index >= 0 &&
    index < 4_294_967_295
  )
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }

  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}
