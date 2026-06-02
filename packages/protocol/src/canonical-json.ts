export type CanonicalJsonValue =
  | boolean
  | null
  | number
  | string
  | CanonicalJsonValue[]
  | { [key: string]: CanonicalJsonValue }

export interface CanonicalJsonCodec {
  stringify: (value: CanonicalJsonValue) => string
}

export const defaultCanonicalJsonCodec: CanonicalJsonCodec = {
  stringify: canonicalJson,
}

export function canonicalJson(value: CanonicalJsonValue): string {
  return stringifyCanonical(value)
}

function stringifyCanonical(value: CanonicalJsonValue): string {
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
    return `[${value.map((item) => stringifyCanonical(item)).join(',')}]`
  }

  const keys = Object.keys(value).toSorted()
  const entries = keys.map(
    (key) => `${JSON.stringify(key)}:${stringifyCanonical(value[key]!)}`,
  )
  return `{${entries.join(',')}}`
}
