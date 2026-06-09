export interface RegestaCompatibility {
  abi?: AbiCompatibility[]
  modules?: string[]
  platforms?: PlatformCompatibility[]
  runtimes?: RuntimeCompatibility[]
}

export interface AbiCompatibility {
  name: string
  versions?: string[]
}

export interface PlatformCompatibility {
  arch?: string[]
  libc?: string[]
  os?: string[]
}

export type RuntimeCompatibility = RuntimeKey | RuntimeCompatibilityObject

export interface RuntimeCompatibilityObject {
  conditions?: string[]
  name: RuntimeKey
  versions?: string
}

export function assertCompatibilityString(
  value: unknown,
  label = 'Compatibility string',
): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`)
  }

  if (hasControlCharacter(value)) {
    throw new TypeError(`${label} must not include control characters`)
  }

  return value
}

export type RuntimeKey =
  | 'andromeda'
  | 'arvancloud'
  | 'azion'
  | 'bun'
  | 'convex'
  | 'deno'
  | 'edge-light'
  | 'edge-routine'
  | 'electron'
  | 'fastly'
  | 'kiesel'
  | 'lagon'
  | 'moddable'
  | 'netlify'
  | 'node'
  | 'pythonmonkey'
  | 'quickjs'
  | 'quickjs-ng'
  | 'react-native'
  | 'react-server'
  | 'rhino'
  | 'wasmer'
  | 'workerd'
  | 'jvm'
  | 'python'
  | 'wasm'
  | (string & {})

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0)

    if (code !== undefined && (code <= 0x1f || code === 0x7f)) {
      return true
    }
  }

  return false
}
