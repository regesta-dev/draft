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
