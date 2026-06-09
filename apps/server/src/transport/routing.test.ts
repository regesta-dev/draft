import { describe, expect, it } from 'vitest'
import {
  registryRoutePath,
  requestHostname,
  routePrefixForHostname,
} from './routing.ts'

describe('transport routing', () => {
  it('maps ordinary registry hosts to the core layer', () => {
    expect(routePrefixForHostname('registry.dev')).toBe('/root')
    expect(registryRoutePath(new Request('http://registry.dev/'))).toBe('/root')
    expect(
      registryRoutePath(new Request('http://registry.dev/api/v0/events')),
    ).toBe('/root/api/v0/events')
  })

  it('maps npm hosts to the npm projection layer', () => {
    expect(routePrefixForHostname('npm')).toBe('/npm')
    expect(routePrefixForHostname('npm.registry.dev')).toBe('/npm')
    expect(
      registryRoutePath(
        new Request('http://npm.localhost/@dev.localhost/hello-regesta'),
      ),
    ).toBe('/npm/@dev.localhost/hello-regesta')
  })

  it('reserves future ecosystem hosts for projection layers', () => {
    expect(routePrefixForHostname('pypi.registry.dev')).toBe('/pypi')
    expect(routePrefixForHostname('cargo.registry.dev')).toBe('/cargo')
    expect(routePrefixForHostname('go.registry.dev')).toBe('/go')
    expect(routePrefixForHostname('oci.registry.dev')).toBe('/oci')
    expect(
      registryRoutePath(new Request('http://cargo.registry.dev/index')),
    ).toBe('/cargo/index')
  })

  it('maps dev.localhost to development support routes', () => {
    expect(routePrefixForHostname('dev.localhost')).toBe('/dev')
    expect(
      registryRoutePath(
        new Request('http://dev.localhost/.well-known/regesta.json'),
      ),
    ).toBe('/dev/.well-known/regesta.json')
  })

  it('normalizes host headers without losing IPv6 literals', () => {
    expect(
      requestHostname(
        new Request('http://localhost/', {
          headers: { host: 'NPM.Localhost:4321' },
        }),
      ),
    ).toBe('npm.localhost')
    expect(
      requestHostname(
        new Request('http://[::1]/', {
          headers: { host: '[::1]:4321' },
        }),
      ),
    ).toBe('::1')
  })
})
