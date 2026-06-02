export interface PackageCoordinate {
  coordinate: `@${string}/${string}`
  name: string
  scope: string
}

export interface PackageVersion {
  coordinate: `@${string}/${string}`
  version: string
}

export function parsePackageCoordinate(value: string): PackageCoordinate {
  const match = /^@([^/]+)\/([^/]+)$/.exec(value)

  if (!match) {
    throw new TypeError(`Invalid package coordinate: ${value}`)
  }

  const [, scope, name] = match

  if (!scope.includes('.')) {
    throw new TypeError(`Regesta v0 requires a domain scope: ${value}`)
  }

  return {
    coordinate: `@${scope}/${name}`,
    name,
    scope,
  }
}

export function parsePackageVersion(value: string): PackageVersion {
  const separatorIndex = value.lastIndexOf('@')

  if (separatorIndex <= 0) {
    throw new TypeError(`Package version must include a version: ${value}`)
  }

  const coordinate = value.slice(0, separatorIndex)
  const version = value.slice(separatorIndex + 1)

  if (!version) {
    throw new TypeError(`Package version must include a version: ${value}`)
  }

  return {
    coordinate: parsePackageCoordinate(coordinate).coordinate,
    version,
  }
}
