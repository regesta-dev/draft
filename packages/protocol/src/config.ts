import type { PackageId } from './package.ts'

export interface RegestaConfig {
  id: PackageId
  version: string
  description?: string
  exports?: RegestaPackageExport
  family?: string
  languages?: string[]
  provenance: RegestaProvenance
  repository?: string
  source: RegestaSourceConfig
}

export interface RegestaProvenance {
  level: 'source-attached'
}

export interface RegestaSourceConfig {
  exclude?: string[]
  include?: string[]
}

export type RegestaPackageExport =
  | null
  | string
  | RegestaPackageExport[]
  | { [key: string]: RegestaPackageExport }

export function assertSourceArchivePath(
  value: unknown,
  label = 'Source archive path',
): string {
  if (typeof value !== 'string') {
    throw new TypeError(`${label} must be a string`)
  }

  if (value.length === 0) {
    throw new TypeError(`${label} must be non-empty`)
  }

  if (hasControlCharacter(value)) {
    throw new TypeError(`${label} must not contain control characters`)
  }

  if (value.includes('\\')) {
    throw new TypeError(`${label} must use forward slashes`)
  }

  if (value.startsWith('/') || /^[A-Za-z]:\//u.test(value)) {
    throw new TypeError(`${label} must be relative`)
  }

  const segments = new Set(value.split('/'))
  if (
    value === '.' ||
    value.startsWith('./') ||
    value.includes('//') ||
    segments.has('.')
  ) {
    throw new TypeError(`${label} must be normalized`)
  }

  if (segments.has('..')) {
    throw new TypeError(`${label} must not contain parent directory segments`)
  }

  return value
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0)

    if (code !== undefined && (code <= 0x1f || code === 0x7f)) {
      return true
    }
  }

  return false
}
