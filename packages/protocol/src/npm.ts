export interface NpmReleaseMetadata {
  bin?: string | Record<string, string>
  bundleDependencies?: boolean | string[]
  bundledDependencies?: string[]
  cpu?: string[]
  dependencies?: Record<string, string>
  engines?: Record<string, string>
  libc?: string[]
  optionalDependencies?: Record<string, string>
  os?: string[]
  peerDependencies?: Record<string, string>
  peerDependenciesMeta?: Record<string, NpmPeerDependencyMeta>
}

export interface NpmPeerDependencyMeta {
  optional?: boolean
}

export interface NpmPackument {
  'dist-tags': Record<string, string>
  name: string
  time: NpmPackumentTime
  versions: Record<string, NpmPackumentVersion>
}

export interface NpmPackumentTime {
  created: string
  modified: string
  [version: string]: string
}

export interface NpmPackumentVersion extends NpmReleaseMetadata {
  dist: {
    integrity: string
    tarball: string
  }
  name: string
  version: string
}
