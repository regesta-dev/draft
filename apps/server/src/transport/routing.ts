const projectionRoutePrefixes = {
  cargo: '/cargo',
  go: '/go',
  npm: '/npm',
  oci: '/oci',
  pypi: '/pypi',
} as const

type ProjectionHostname = keyof typeof projectionRoutePrefixes
type TransportRoutePrefix =
  | (typeof projectionRoutePrefixes)[ProjectionHostname]
  | '/dev'
  | '/root'

export function registryRoutePath(request: Request): string {
  const url = new URL(request.url)
  const prefix = routePrefixForHostname(requestHostname(request))
  return url.pathname === '/' ? prefix : `${prefix}${url.pathname}`
}

export function routePrefixForHostname(hostname: string): TransportRoutePrefix {
  if (hostname === 'dev.localhost') {
    return '/dev'
  }

  const projectionHostname = hostname.split('.', 1)[0]
  if (isProjectionHostname(projectionHostname)) {
    return projectionRoutePrefixes[projectionHostname]
  }

  return '/root'
}

export function requestHostname(request: Request): string {
  const host = request.headers.get('host')

  if (!host) {
    return new URL(request.url).hostname.toLowerCase()
  }

  if (host.startsWith('[')) {
    const end = host.indexOf(']')
    return end > 0 ? host.slice(1, end).toLowerCase() : host.toLowerCase()
  }

  return host.split(':', 1)[0]?.toLowerCase() ?? ''
}

function isProjectionHostname(
  value: string | undefined,
): value is ProjectionHostname {
  return value !== undefined && value in projectionRoutePrefixes
}
