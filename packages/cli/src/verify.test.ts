import {
  canonicalJson,
  defaultPackageChannel,
  registryEventDigest,
  sha256,
  type ChannelUpdatedEvent,
  type ObjectDescriptor,
  type PublishReleaseEvent,
  type RegistryEvent,
  type ReleaseManifest,
} from '@regesta/protocol'
import { describe, expect, it } from 'vitest'
import {
  verifyEventLogFromRegistry,
  verifyReleaseFromRegistry,
} from './verify.ts'
import type { StoredRelease } from '@regesta/core'

type TestFetch = typeof fetch & { headRequests: string[]; requests: string[] }

describe('verifyReleaseFromRegistry', () => {
  it('verifies a release from public registry data without using the convenience endpoint', async () => {
    const fixture = releaseFixture()
    const fetch = publicRegistryFetch(fixture)

    const result = await verifyReleaseFromRegistry({
      fetch,
      packageId: fixture.release.manifest.id,
      registry: 'https://registry.example/',
      version: fixture.release.manifest.version,
    })

    expect(result.ok).toBe(true)
    expect(fetch.requests.some((url) => url.includes('/verification'))).toBe(
      false,
    )
    expect(fetch.requests).toEqual([
      'https://registry.example/packages/npm%3Aexample.com%2Fhello-regesta/releases/1.0.0',
      `https://registry.example/events/sha256/${fixture.release.event.id.slice('sha256:'.length)}`,
      `https://registry.example/objects/sha256/${fixture.release.manifestDescriptor.digest.slice('sha256:'.length)}`,
      `https://registry.example/objects/sha256/${fixture.release.manifestDescriptor.digest.slice('sha256:'.length)}`,
      `https://registry.example/objects/sha256/${fixture.release.manifest.source.digest.slice('sha256:'.length)}`,
      `https://registry.example/objects/sha256/${fixture.release.manifest.source.digest.slice('sha256:'.length)}`,
      `https://registry.example/objects/sha256/${fixture.release.manifest.artifacts[0]!.digest.slice('sha256:'.length)}`,
      `https://registry.example/objects/sha256/${fixture.release.manifest.artifacts[0]!.digest.slice('sha256:'.length)}`,
    ])
    expect(fetch.headRequests).toEqual([
      `https://registry.example/objects/sha256/${fixture.release.manifestDescriptor.digest.slice('sha256:'.length)}`,
      `https://registry.example/objects/sha256/${fixture.release.manifest.source.digest.slice('sha256:'.length)}`,
      `https://registry.example/objects/sha256/${fixture.release.manifest.artifacts[0]!.digest.slice('sha256:'.length)}`,
    ])
  })

  it('reports object integrity problems from downloaded public object bytes', async () => {
    const fixture = releaseFixture()
    const badSourceBytes = bytes('tampered bytes')
    const fetch = publicRegistryFetch({
      ...fixture,
      objects: new Map([
        ...fixture.objects,
        [
          fixture.release.manifest.source.digest,
          {
            bytes: badSourceBytes,
            descriptor: fixture.release.manifest.source,
          },
        ],
      ]),
    })

    const result = await verifyReleaseFromRegistry({
      fetch,
      packageId: fixture.release.manifest.id,
      registry: 'https://registry.example',
      version: fixture.release.manifest.version,
    })

    expect(result.ok).toBe(false)
    expect(result.problems).toContain(
      `Source object bytes digest mismatch: ${fixture.release.manifest.source.digest}`,
    )
  })

  it('reports malformed public object headers as verification problems', async () => {
    const fixture = releaseFixture()
    const sourceDigest = fixture.release.manifest.source.digest
    const fetch = publicRegistryFetch(fixture)
    const malformedObjectFetch = Object.assign(
      (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = String(input)
        if (url.endsWith(sourceDigest.slice('sha256:'.length))) {
          fetch.requests.push(url)
          if (init?.method === 'HEAD') {
            fetch.headRequests.push(url)
          }
          const source = fixture.objects.get(sourceDigest)

          return Promise.resolve(
            new Response(init?.method === 'HEAD' ? null : source?.bytes, {
              headers: {
                'content-length': 'not-a-number',
                'content-type':
                  source?.descriptor.mediaType ?? 'application/octet-stream',
                etag: `"${sourceDigest}"`,
              },
            }),
          )
        }

        return fetch(input, init)
      },
      { headRequests: fetch.headRequests, requests: fetch.requests },
    )

    const result = await verifyReleaseFromRegistry({
      fetch: malformedObjectFetch,
      packageId: fixture.release.manifest.id,
      registry: 'https://registry.example',
      version: fixture.release.manifest.version,
    })

    expect(result.ok).toBe(false)
    expect(result.problems).toContain(
      `Source object descriptor read failed: Invalid object Content-Length header: https://registry.example/objects/sha256/${sourceDigest.slice('sha256:'.length)}`,
    )
  })

  it('reports missing public object Content-Length headers as verification problems', async () => {
    const fixture = releaseFixture()
    const sourceDigest = fixture.release.manifest.source.digest
    const fetch = publicRegistryFetch(fixture)
    const missingObjectLengthFetch = Object.assign(
      (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = String(input)
        if (
          init?.method === 'HEAD' &&
          url.endsWith(sourceDigest.slice('sha256:'.length))
        ) {
          fetch.requests.push(url)
          fetch.headRequests.push(url)
          const source = fixture.objects.get(sourceDigest)

          return Promise.resolve(
            new Response(null, {
              headers: {
                'content-type':
                  source?.descriptor.mediaType ?? 'application/octet-stream',
                etag: `"${sourceDigest}"`,
              },
            }),
          )
        }

        return fetch(input, init)
      },
      { headRequests: fetch.headRequests, requests: fetch.requests },
    )

    const result = await verifyReleaseFromRegistry({
      fetch: missingObjectLengthFetch,
      packageId: fixture.release.manifest.id,
      registry: 'https://registry.example',
      version: fixture.release.manifest.version,
    })

    expect(result.ok).toBe(false)
    expect(result.problems).toContain(
      `Source object descriptor read failed: Missing object Content-Length header: https://registry.example/objects/sha256/${sourceDigest.slice('sha256:'.length)}`,
    )
  })

  it('reports missing public object Content-Type headers as verification problems', async () => {
    const fixture = releaseFixture()
    const sourceDigest = fixture.release.manifest.source.digest
    const fetch = publicRegistryFetch(fixture)
    const missingObjectTypeFetch = Object.assign(
      (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = String(input)
        if (
          init?.method === 'HEAD' &&
          url.endsWith(sourceDigest.slice('sha256:'.length))
        ) {
          fetch.requests.push(url)
          fetch.headRequests.push(url)
          const source = fixture.objects.get(sourceDigest)

          return Promise.resolve(
            new Response(null, {
              headers: {
                'content-length': String(source?.descriptor.size),
                etag: `"${sourceDigest}"`,
              },
            }),
          )
        }

        return fetch(input, init)
      },
      { headRequests: fetch.headRequests, requests: fetch.requests },
    )

    const result = await verifyReleaseFromRegistry({
      fetch: missingObjectTypeFetch,
      packageId: fixture.release.manifest.id,
      registry: 'https://registry.example',
      version: fixture.release.manifest.version,
    })

    expect(result.ok).toBe(false)
    expect(result.problems).toContain(
      `Source object descriptor read failed: Missing object Content-Type header: https://registry.example/objects/sha256/${sourceDigest.slice('sha256:'.length)}`,
    )
  })

  it('reports public object GET Content-Length mismatches as verification problems', async () => {
    const fixture = releaseFixture()
    const sourceDigest = fixture.release.manifest.source.digest
    const fetch = publicRegistryFetch(fixture)
    const mismatchedObjectLengthFetch = Object.assign(
      (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = String(input)
        if (
          init?.method !== 'HEAD' &&
          url.endsWith(sourceDigest.slice('sha256:'.length))
        ) {
          fetch.requests.push(url)
          const source = fixture.objects.get(sourceDigest)

          return Promise.resolve(
            new Response(source?.bytes, {
              headers: {
                'content-length': String((source?.descriptor.size ?? 0) + 1),
                'content-type':
                  source?.descriptor.mediaType ?? 'application/octet-stream',
                etag: `"${sourceDigest}"`,
              },
            }),
          )
        }

        return fetch(input, init)
      },
      { headRequests: fetch.headRequests, requests: fetch.requests },
    )

    const result = await verifyReleaseFromRegistry({
      fetch: mismatchedObjectLengthFetch,
      packageId: fixture.release.manifest.id,
      registry: 'https://registry.example',
      version: fixture.release.manifest.version,
    })

    expect(result.ok).toBe(false)
    expect(result.problems).toContain(
      `Source object read failed: Public object Content-Length does not match body: https://registry.example/objects/sha256/${sourceDigest.slice('sha256:'.length)}`,
    )
  })

  it('reports missing public object GET Content-Length headers as verification problems', async () => {
    const fixture = releaseFixture()
    const sourceDigest = fixture.release.manifest.source.digest
    const fetch = publicRegistryFetch(fixture)
    const missingObjectLengthFetch = Object.assign(
      (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = String(input)
        if (
          init?.method !== 'HEAD' &&
          url.endsWith(sourceDigest.slice('sha256:'.length))
        ) {
          fetch.requests.push(url)
          const source = fixture.objects.get(sourceDigest)

          return Promise.resolve(
            new Response(source?.bytes, {
              headers: {
                'content-type':
                  source?.descriptor.mediaType ?? 'application/octet-stream',
                etag: `"${sourceDigest}"`,
              },
            }),
          )
        }

        return fetch(input, init)
      },
      { headRequests: fetch.headRequests, requests: fetch.requests },
    )

    const result = await verifyReleaseFromRegistry({
      fetch: missingObjectLengthFetch,
      packageId: fixture.release.manifest.id,
      registry: 'https://registry.example',
      version: fixture.release.manifest.version,
    })

    expect(result.ok).toBe(false)
    expect(result.problems).toContain(
      `Source object read failed: Missing object Content-Length header: https://registry.example/objects/sha256/${sourceDigest.slice('sha256:'.length)}`,
    )
  })

  it('reports public object GET Content-Type mismatches as verification problems', async () => {
    const fixture = releaseFixture()
    const sourceDigest = fixture.release.manifest.source.digest
    const fetch = publicRegistryFetch(fixture)
    const mismatchedObjectTypeFetch = Object.assign(
      (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = String(input)
        if (
          init?.method !== 'HEAD' &&
          url.endsWith(sourceDigest.slice('sha256:'.length))
        ) {
          fetch.requests.push(url)
          const source = fixture.objects.get(sourceDigest)

          return Promise.resolve(
            new Response(source?.bytes, {
              headers: {
                'content-length': String(source?.descriptor.size),
                'content-type': 'application/octet-stream',
                etag: `"${sourceDigest}"`,
              },
            }),
          )
        }

        return fetch(input, init)
      },
      { headRequests: fetch.headRequests, requests: fetch.requests },
    )

    const result = await verifyReleaseFromRegistry({
      fetch: mismatchedObjectTypeFetch,
      packageId: fixture.release.manifest.id,
      registry: 'https://registry.example',
      version: fixture.release.manifest.version,
    })

    expect(result.ok).toBe(false)
    expect(result.problems).toContain(
      `Source object read failed: Public object Content-Type mismatch: https://registry.example/objects/sha256/${sourceDigest.slice('sha256:'.length)}`,
    )
  })

  it('reports missing public object GET Content-Type headers as verification problems', async () => {
    const fixture = releaseFixture()
    const sourceDigest = fixture.release.manifest.source.digest
    const fetch = publicRegistryFetch(fixture)
    const missingObjectTypeFetch = Object.assign(
      (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = String(input)
        if (
          init?.method !== 'HEAD' &&
          url.endsWith(sourceDigest.slice('sha256:'.length))
        ) {
          fetch.requests.push(url)
          const source = fixture.objects.get(sourceDigest)

          return Promise.resolve(
            new Response(source?.bytes, {
              headers: {
                'content-length': String(source?.descriptor.size),
                etag: `"${sourceDigest}"`,
              },
            }),
          )
        }

        return fetch(input, init)
      },
      { headRequests: fetch.headRequests, requests: fetch.requests },
    )

    const result = await verifyReleaseFromRegistry({
      fetch: missingObjectTypeFetch,
      packageId: fixture.release.manifest.id,
      registry: 'https://registry.example',
      version: fixture.release.manifest.version,
    })

    expect(result.ok).toBe(false)
    expect(result.problems).toContain(
      `Source object read failed: Missing object Content-Type header: https://registry.example/objects/sha256/${sourceDigest.slice('sha256:'.length)}`,
    )
  })

  it('reports public object ETag digest mismatches as verification problems', async () => {
    const fixture = releaseFixture()
    const sourceDigest = fixture.release.manifest.source.digest
    const fetch = publicRegistryFetch(fixture)
    const mismatchedObjectEtagFetch = Object.assign(
      (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = String(input)
        if (url.endsWith(sourceDigest.slice('sha256:'.length))) {
          fetch.requests.push(url)
          if (init?.method === 'HEAD') {
            fetch.headRequests.push(url)
          }
          const source = fixture.objects.get(sourceDigest)

          return Promise.resolve(
            new Response(init?.method === 'HEAD' ? null : source?.bytes, {
              headers: {
                'content-length': String(source?.descriptor.size),
                'content-type':
                  source?.descriptor.mediaType ?? 'application/octet-stream',
                etag: `"sha256:${'0'.repeat(64)}"`,
              },
            }),
          )
        }

        return fetch(input, init)
      },
      { headRequests: fetch.headRequests, requests: fetch.requests },
    )

    const result = await verifyReleaseFromRegistry({
      fetch: mismatchedObjectEtagFetch,
      packageId: fixture.release.manifest.id,
      registry: 'https://registry.example',
      version: fixture.release.manifest.version,
    })

    expect(result.ok).toBe(false)
    expect(result.problems).toContain(
      `Source object descriptor read failed: Public object ETag does not match digest: https://registry.example/objects/sha256/${sourceDigest.slice('sha256:'.length)}`,
    )
  })

  it('reports missing public object HEAD ETag headers as verification problems', async () => {
    const fixture = releaseFixture()
    const sourceDigest = fixture.release.manifest.source.digest
    const fetch = publicRegistryFetch(fixture)
    const missingObjectEtagFetch = Object.assign(
      (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = String(input)
        if (
          init?.method === 'HEAD' &&
          url.endsWith(sourceDigest.slice('sha256:'.length))
        ) {
          fetch.requests.push(url)
          fetch.headRequests.push(url)
          const source = fixture.objects.get(sourceDigest)

          return Promise.resolve(
            new Response(null, {
              headers: {
                'content-length': String(source?.descriptor.size),
                'content-type':
                  source?.descriptor.mediaType ?? 'application/octet-stream',
              },
            }),
          )
        }

        return fetch(input, init)
      },
      { headRequests: fetch.headRequests, requests: fetch.requests },
    )

    const result = await verifyReleaseFromRegistry({
      fetch: missingObjectEtagFetch,
      packageId: fixture.release.manifest.id,
      registry: 'https://registry.example',
      version: fixture.release.manifest.version,
    })

    expect(result.ok).toBe(false)
    expect(result.problems).toContain(
      `Source object descriptor read failed: Missing object ETag header: https://registry.example/objects/sha256/${sourceDigest.slice('sha256:'.length)}`,
    )
  })

  it('reports missing public object GET ETag headers as verification problems', async () => {
    const fixture = releaseFixture()
    const sourceDigest = fixture.release.manifest.source.digest
    const fetch = publicRegistryFetch(fixture)
    const missingObjectEtagFetch = Object.assign(
      (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = String(input)
        if (
          init?.method !== 'HEAD' &&
          url.endsWith(sourceDigest.slice('sha256:'.length))
        ) {
          fetch.requests.push(url)
          const source = fixture.objects.get(sourceDigest)

          return Promise.resolve(
            new Response(source?.bytes, {
              headers: {
                'content-length': String(source?.descriptor.size),
                'content-type':
                  source?.descriptor.mediaType ?? 'application/octet-stream',
              },
            }),
          )
        }

        return fetch(input, init)
      },
      { headRequests: fetch.headRequests, requests: fetch.requests },
    )

    const result = await verifyReleaseFromRegistry({
      fetch: missingObjectEtagFetch,
      packageId: fixture.release.manifest.id,
      registry: 'https://registry.example',
      version: fixture.release.manifest.version,
    })

    expect(result.ok).toBe(false)
    expect(result.problems).toContain(
      `Source object read failed: Missing object ETag header: https://registry.example/objects/sha256/${sourceDigest.slice('sha256:'.length)}`,
    )
  })

  it('reports malformed public release envelopes as verification problems', async () => {
    const result = await verifyReleaseFromRegistry({
      fetch: jsonFetch({
        manifest: {},
        manifestDescriptor: {},
      }),
      packageId: 'npm:example.com/hello-regesta',
      registry: 'https://registry.example',
      version: '1.0.0',
    })

    expect(result).toEqual({
      ok: false,
      problems: ['Public release response event must be an object'],
    })
  })

  it('reports unknown public release envelope fields as verification problems', async () => {
    const fixture = releaseFixture()
    const result = await verifyReleaseFromRegistry({
      fetch: jsonFetch({
        ...fixture.release,
        operatorHint: 'not verified',
      }),
      packageId: fixture.release.manifest.id,
      registry: 'https://registry.example',
      version: fixture.release.manifest.version,
    })

    expect(result).toEqual({
      ok: false,
      problems: [
        'Public release response must not include unknown field: operatorHint',
      ],
    })
  })

  it('reports invalid public release JSON Content-Type headers', async () => {
    const fixture = releaseFixture()
    const result = await verifyReleaseFromRegistry({
      fetch: () =>
        Promise.resolve(
          Response.json(fixture.release, {
            headers: {
              'content-type': 'text/plain',
            },
          }),
        ),
      packageId: fixture.release.manifest.id,
      registry: 'https://registry.example',
      version: fixture.release.manifest.version,
    })

    expect(result).toEqual({
      ok: false,
      problems: [
        'Public release request failed: Invalid JSON Content-Type header: https://registry.example/packages/npm%3Aexample.com%2Fhello-regesta/releases/1.0.0',
      ],
    })
  })

  it('reports public release identity mismatches as verification problems', async () => {
    const fixture = releaseFixture()
    const packageId = fixture.release.manifest.id
    const version = fixture.release.manifest.version
    Object.assign(fixture.release.manifest, {
      id: 'npm:example.com/other-package',
      name: 'example.com/other-package',
      version: '2.0.0',
    })

    const result = await verifyReleaseFromRegistry({
      fetch: publicRegistryFetch(fixture),
      packageId,
      registry: 'https://registry.example',
      version,
    })

    expect(result.ok).toBe(false)
    expect(result.problems).not.toContain(
      `Release not found: ${packageId}@${version}`,
    )
    expect(result.problems).toContain(
      'Release manifest package id does not match requested package id',
    )
    expect(result.problems).toContain(
      'Release manifest version does not match requested version',
    )
  })

  it('reports public release ETag event id mismatches as verification problems', async () => {
    const fixture = releaseFixture()
    const fetch = publicRegistryFetch(fixture)
    const mismatchedReleaseEtagFetch = Object.assign(
      (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = String(input)
        if (url.includes('/packages/')) {
          fetch.requests.push(url)

          return Promise.resolve(
            jsonResponse(fixture.release, {
              headers: {
                etag: `W/"sha256:${'0'.repeat(64)}"`,
              },
            }),
          )
        }

        return fetch(input, init)
      },
      { headRequests: fetch.headRequests, requests: fetch.requests },
    )

    const result = await verifyReleaseFromRegistry({
      fetch: mismatchedReleaseEtagFetch,
      packageId: fixture.release.manifest.id,
      registry: 'https://registry.example',
      version: fixture.release.manifest.version,
    })

    expect(result.ok).toBe(false)
    expect(result.problems).toEqual([
      'Public release response ETag does not match event id',
    ])
  })

  it('reports missing public release ETag headers as verification problems', async () => {
    const fixture = releaseFixture()
    const result = await verifyReleaseFromRegistry({
      fetch: () => Promise.resolve(Response.json(fixture.release)),
      packageId: fixture.release.manifest.id,
      registry: 'https://registry.example',
      version: fixture.release.manifest.version,
    })

    expect(result.ok).toBe(false)
    expect(result.problems).toEqual(['Public release response is missing ETag'])
  })

  it('reports public release request failures as verification problems', async () => {
    const result = await verifyReleaseFromRegistry({
      fetch: () => Promise.resolve(new Response('not found', { status: 404 })),
      packageId: 'npm:example.com/hello-regesta',
      registry: 'https://registry.example',
      version: '1.0.0',
    })

    expect(result.ok).toBe(false)
    expect(result.problems).toEqual([
      'Public release request failed: Registry request failed: 404 https://registry.example/packages/npm%3Aexample.com%2Fhello-regesta/releases/1.0.0',
    ])
  })

  it('reports public event request failures as verification problems', async () => {
    const fixture = releaseFixture()
    const fetch = publicRegistryFetch(fixture)
    const failingFetch = Object.assign(
      (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = String(input)
        if (url.includes('/events/')) {
          fetch.requests.push(url)
          return Promise.resolve(new Response('not found', { status: 404 }))
        }

        return fetch(input, init)
      },
      { headRequests: fetch.headRequests, requests: fetch.requests },
    )

    const result = await verifyReleaseFromRegistry({
      fetch: failingFetch,
      packageId: fixture.release.manifest.id,
      registry: 'https://registry.example',
      version: fixture.release.manifest.version,
    })

    expect(result.ok).toBe(false)
    expect(result.manifest?.id).toBe(fixture.release.manifest.id)
    expect(result.problems).toEqual([
      `Public event request failed: Registry request failed: 404 https://registry.example/events/sha256/${fixture.release.event.id.slice('sha256:'.length)}`,
    ])
  })

  it('reports public event ETag event id mismatches as verification problems', async () => {
    const fixture = releaseFixture()
    const fetch = publicRegistryFetch(fixture)
    const mismatchedEventEtagFetch = Object.assign(
      (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = String(input)
        if (url.includes('/events/')) {
          fetch.requests.push(url)

          return Promise.resolve(
            jsonResponse(fixture.release.event, {
              headers: {
                etag: `"sha256:${'0'.repeat(64)}"`,
              },
            }),
          )
        }

        return fetch(input, init)
      },
      { headRequests: fetch.headRequests, requests: fetch.requests },
    )

    const result = await verifyReleaseFromRegistry({
      fetch: mismatchedEventEtagFetch,
      packageId: fixture.release.manifest.id,
      registry: 'https://registry.example',
      version: fixture.release.manifest.version,
    })

    expect(result.ok).toBe(false)
    expect(result.problems).toEqual([
      'Public event response ETag does not match event id',
    ])
  })

  it('reports missing public event ETag headers as verification problems', async () => {
    const fixture = releaseFixture()
    const fetch = publicRegistryFetch(fixture)
    const missingEventEtagFetch = Object.assign(
      (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = String(input)
        if (url.includes('/events/')) {
          fetch.requests.push(url)

          return Promise.resolve(Response.json(fixture.release.event))
        }

        return fetch(input, init)
      },
      { headRequests: fetch.headRequests, requests: fetch.requests },
    )

    const result = await verifyReleaseFromRegistry({
      fetch: missingEventEtagFetch,
      packageId: fixture.release.manifest.id,
      registry: 'https://registry.example',
      version: fixture.release.manifest.version,
    })

    expect(result.ok).toBe(false)
    expect(result.problems).toEqual(['Public event response is missing ETag'])
  })

  it('reports invalid public event JSON Content-Type headers', async () => {
    const fixture = releaseFixture()
    const fetch = publicRegistryFetch(fixture)
    const invalidEventContentTypeFetch = Object.assign(
      (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = String(input)
        if (url.includes('/events/')) {
          fetch.requests.push(url)

          return Promise.resolve(
            Response.json(fixture.release.event, {
              headers: {
                'content-type': 'text/plain',
              },
            }),
          )
        }

        return fetch(input, init)
      },
      { headRequests: fetch.headRequests, requests: fetch.requests },
    )

    const result = await verifyReleaseFromRegistry({
      fetch: invalidEventContentTypeFetch,
      packageId: fixture.release.manifest.id,
      registry: 'https://registry.example',
      version: fixture.release.manifest.version,
    })

    expect(result.ok).toBe(false)
    expect(result.manifest?.id).toBe(fixture.release.manifest.id)
    expect(result.problems).toEqual([
      `Public event request failed: Invalid JSON Content-Type header: https://registry.example/events/sha256/${fixture.release.event.id.slice('sha256:'.length)}`,
    ])
  })

  it('reports public event body mismatches as verification problems', async () => {
    const fixture = releaseFixture()
    const fetch = publicRegistryFetch(fixture)
    const mismatchedEventPayload: Omit<PublishReleaseEvent, 'id'> = {
      ...fixture.release.event,
      channel: 'beta',
    }
    const mismatchedEvent = {
      ...mismatchedEventPayload,
      id: registryEventDigest(mismatchedEventPayload),
    }
    const mismatchedFetch = Object.assign(
      (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = String(input)
        if (url.includes('/events/')) {
          fetch.requests.push(url)
          return Promise.resolve(
            jsonResponse(mismatchedEvent, {
              headers: {
                etag: `"${fixture.release.event.id}"`,
              },
            }),
          )
        }

        return fetch(input, init)
      },
      { headRequests: fetch.headRequests, requests: fetch.requests },
    )

    const result = await verifyReleaseFromRegistry({
      fetch: mismatchedFetch,
      packageId: fixture.release.manifest.id,
      registry: 'https://registry.example',
      version: fixture.release.manifest.version,
    })

    expect(result.ok).toBe(false)
    expect(result.problems).toEqual([
      'Public event response id does not match release event id',
    ])
  })

  it('reports invalid public event bodies before replaying release verification', async () => {
    const fixture = releaseFixture()
    const fetch = publicRegistryFetch(fixture)
    const invalidEventFetch = Object.assign(
      (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = String(input)
        if (url.includes('/events/')) {
          fetch.requests.push(url)

          return Promise.resolve(
            jsonResponse(
              {
                ...fixture.release.event,
                operatorHint: 'not verified',
              },
              {
                headers: {
                  etag: `"${fixture.release.event.id}"`,
                },
              },
            ),
          )
        }

        return fetch(input, init)
      },
      { headRequests: fetch.headRequests, requests: fetch.requests },
    )

    const result = await verifyReleaseFromRegistry({
      fetch: invalidEventFetch,
      packageId: fixture.release.manifest.id,
      registry: 'https://registry.example',
      version: fixture.release.manifest.version,
    })

    expect(result).toEqual({
      manifest: fixture.release.manifest,
      ok: false,
      problems: [
        `Public event response is invalid: Registry event id does not match canonical event payload: ${fixture.release.event.id}`,
      ],
    })
  })
})

describe('verifyEventLogFromRegistry', () => {
  it('verifies public event log pages and replays package state', async () => {
    const fixture = releaseFixture()
    const channelEvent = channelUpdatedEvent(fixture.release.event, {
      channel: 'beta',
      timestamp: '2026-06-09T00:01:00.000Z',
      version: fixture.release.manifest.version,
    })
    const fetch = publicEventLogFetch([fixture.release.event, channelEvent])

    const result = await verifyEventLogFromRegistry({
      fetch,
      limit: 1,
      registry: 'https://registry.example/',
    })

    expect(result).toEqual({
      checkedEvents: 2,
      lastEventId: channelEvent.id,
      ok: true,
      packages: 1,
      problems: [],
    })
    expect(fetch.requests).toEqual([
      'https://registry.example/events?limit=1',
      `https://registry.example/events/sha256/${fixture.release.event.id.slice('sha256:'.length)}`,
      `https://registry.example/events?after=${encodeURIComponent(
        fixture.release.event.id,
      )}&limit=1`,
      `https://registry.example/events/sha256/${channelEvent.id.slice('sha256:'.length)}`,
      `https://registry.example/events?after=${encodeURIComponent(
        channelEvent.id,
      )}&limit=1`,
    ])
  })

  it('rejects event log entries that do not match immutable event endpoints', async () => {
    const fixture = releaseFixture()
    const endpointEvent = channelUpdatedEvent(fixture.release.event, {
      channel: 'beta',
      timestamp: '2026-06-09T00:01:00.000Z',
      version: fixture.release.manifest.version,
    })

    const result = await verifyEventLogFromRegistry({
      fetch: publicEventLogFetch([fixture.release.event], {
        eventEndpointEvents: new Map([
          [fixture.release.event.id, endpointEvent],
        ]),
      }),
      registry: 'https://registry.example',
    })

    expect(result).toEqual({
      checkedEvents: 0,
      ok: false,
      packages: 0,
      problems: [
        'Public event endpoint response id does not match event log entry id',
      ],
    })
  })

  it('reports duplicate event ids in the public event log', async () => {
    const fixture = releaseFixture()
    const fetch = publicEventLogFetch([
      fixture.release.event,
      fixture.release.event,
    ])

    const result = await verifyEventLogFromRegistry({
      fetch,
      registry: 'https://registry.example',
    })

    expect(result.ok).toBe(false)
    expect(result.problems).toEqual([
      `Public event log contains duplicate event id: ${fixture.release.event.id}`,
    ])
  })

  it('reports event logs that cannot replay package state', async () => {
    const fixture = releaseFixture()
    const channelEvent = channelUpdatedEvent(fixture.release.event, {
      channel: 'beta',
      timestamp: '2026-06-09T00:01:00.000Z',
      version: '2.0.0',
    })
    const fetch = publicEventLogFetch([fixture.release.event, channelEvent])

    const result = await verifyEventLogFromRegistry({
      fetch,
      registry: 'https://registry.example',
    })

    expect(result.ok).toBe(false)
    expect(result.problems).toEqual([
      'Public event log package replay failed for npm:example.com/hello-regesta: Registry event channel target version does not exist: 2.0.0',
    ])
  })

  it('reports event log verification that stops before reaching the tail', async () => {
    const fixture = releaseFixture()
    const channelEvent = channelUpdatedEvent(fixture.release.event, {
      channel: 'beta',
      timestamp: '2026-06-09T00:01:00.000Z',
      version: fixture.release.manifest.version,
    })
    const fetch = publicEventLogFetch([fixture.release.event, channelEvent])

    const result = await verifyEventLogFromRegistry({
      fetch,
      limit: 1,
      maxPages: 1,
      registry: 'https://registry.example',
    })

    expect(result).toEqual({
      checkedEvents: 1,
      lastEventId: fixture.release.event.id,
      ok: false,
      packages: 1,
      problems: ['Public event log verification stopped before reaching tail'],
    })
  })

  it('rejects event log page limits outside the public API range', async () => {
    const result = await verifyEventLogFromRegistry({
      fetch: publicEventLogFetch([]),
      limit: 1000,
      registry: 'https://registry.example',
    })

    expect(result).toEqual({
      checkedEvents: 0,
      ok: false,
      packages: 0,
      problems: ['Event log page limit must be at most 999'],
    })
  })

  it('rejects event log pages larger than the requested limit', async () => {
    const fixture = releaseFixture()
    const channelEvent = channelUpdatedEvent(fixture.release.event, {
      channel: 'beta',
      timestamp: '2026-06-09T00:01:00.000Z',
      version: fixture.release.manifest.version,
    })

    const result = await verifyEventLogFromRegistry({
      fetch: publicEventLogFetch([fixture.release.event, channelEvent], {
        ignoreLimit: true,
      }),
      limit: 1,
      registry: 'https://registry.example',
    })

    expect(result).toEqual({
      checkedEvents: 0,
      ok: false,
      packages: 0,
      problems: ['Public event log page returned more events than requested'],
    })
  })

  it('rejects unknown public event log response fields', async () => {
    const result = await verifyEventLogFromRegistry({
      fetch: publicEventLogFetch([], {
        extraPageFields: {
          operatorHint: 'not verified',
        },
      }),
      registry: 'https://registry.example',
    })

    expect(result).toEqual({
      checkedEvents: 0,
      ok: false,
      packages: 0,
      problems: [
        'Public event log response must not include unknown field: operatorHint',
      ],
    })
  })
})

function releaseFixture(): {
  objects: Map<string, { bytes: Uint8Array; descriptor: ObjectDescriptor }>
  release: StoredRelease
} {
  const sourceBytes = bytes('source archive')
  const artifactBytes = bytes('install artifact')
  const source = descriptor(
    sourceBytes,
    'application/vnd.regesta.source-archive+tgz',
  )
  const artifact = {
    ...descriptor(artifactBytes, 'application/gzip'),
    filename: 'hello-regesta-1.0.0.tgz',
    format: 'npm-tarball',
    role: 'install',
  }
  const manifest: ReleaseManifest = {
    artifacts: [artifact],
    configDigest: sha256(bytes('config')),
    createdAt: '2026-06-09T00:00:00.000Z',
    ecosystem: 'npm',
    id: 'npm:example.com/hello-regesta',
    metadata: {
      description: 'Fixture package',
    },
    name: 'example.com/hello-regesta',
    object: 'regesta.release-manifest',
    provenance: {
      level: 'source-attached',
      verified: false,
    },
    source,
    specVersion: 0,
    version: '1.0.0',
  }
  const manifestBytes = bytes(`${canonicalJson(manifest)}\n`)
  const manifestDescriptor = descriptor(
    manifestBytes,
    'application/vnd.regesta.release-manifest.v0+json',
  )
  const eventPayload: Omit<PublishReleaseEvent, 'id'> = {
    artifactDigests: [artifact.digest],
    channel: defaultPackageChannel,
    eventType: 'release.published',
    object: 'regesta.event',
    release: {
      id: manifest.id,
      manifestDigest: manifestDescriptor.digest,
      version: manifest.version,
    },
    sourceDigest: source.digest,
    specVersion: 0,
    timestamp: manifest.createdAt,
  }
  const event: PublishReleaseEvent = {
    ...eventPayload,
    id: registryEventDigest(eventPayload),
  }
  const objects = new Map([
    [
      manifestDescriptor.digest,
      { bytes: manifestBytes, descriptor: manifestDescriptor },
    ],
    [source.digest, { bytes: sourceBytes, descriptor: source }],
    [artifact.digest, { bytes: artifactBytes, descriptor: artifact }],
  ])

  return {
    objects,
    release: {
      event,
      manifest,
      manifestDescriptor,
    },
  }
}

function channelUpdatedEvent(
  publishEvent: PublishReleaseEvent,
  options: {
    channel: string
    timestamp: string
    version: string
  },
): ChannelUpdatedEvent {
  const payload: Omit<ChannelUpdatedEvent, 'id'> = {
    channel: options.channel,
    eventType: 'channel.updated',
    object: 'regesta.event',
    package: publishEvent.release.id,
    specVersion: 0,
    timestamp: options.timestamp,
    version: options.version,
  }

  return {
    ...payload,
    id: registryEventDigest(payload),
  }
}

function descriptor(bytes: Uint8Array, mediaType: string): ObjectDescriptor {
  return {
    digest: sha256(bytes),
    mediaType,
    size: bytes.byteLength,
  }
}

function publicRegistryFetch(fixture: {
  objects: Map<string, { bytes: Uint8Array; descriptor: ObjectDescriptor }>
  release: StoredRelease
}): TestFetch {
  const headRequests: string[] = []
  const requests: string[] = []
  const fetchImpl = (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = String(input)
    requests.push(url)

    if (init?.method === 'HEAD') {
      headRequests.push(url)
    }

    if (url.includes('/verification')) {
      throw new Error(
        'verify command must not use the server verification endpoint',
      )
    }

    const { pathname } = new URL(url)

    if (
      pathname === '/packages/npm%3Aexample.com%2Fhello-regesta/releases/1.0.0'
    ) {
      return Promise.resolve(
        jsonResponse(fixture.release, {
          headers: {
            etag: `W/"${fixture.release.event.id}"`,
          },
        }),
      )
    }

    if (
      pathname ===
      `/events/sha256/${fixture.release.event.id.slice('sha256:'.length)}`
    ) {
      return Promise.resolve(
        jsonResponse(fixture.release.event, {
          headers: {
            etag: `"${fixture.release.event.id}"`,
          },
        }),
      )
    }

    if (pathname.startsWith('/objects/sha256/')) {
      const digest = `sha256:${pathname.split('/').pop()}`
      const object = fixture.objects.get(digest)

      if (!object) {
        return Promise.resolve(new Response('not found', { status: 404 }))
      }

      return Promise.resolve(
        new Response(init?.method === 'HEAD' ? null : object.bytes, {
          headers: {
            'content-length': String(object.descriptor.size),
            'content-type': object.descriptor.mediaType,
            etag: `"${object.descriptor.digest}"`,
          },
        }),
      )
    }

    return Promise.resolve(new Response('not found', { status: 404 }))
  }

  return Object.assign(fetchImpl, { headRequests, requests })
}

function publicEventLogFetch(
  events: RegistryEvent[],
  options: {
    eventEndpointEvents?: Map<string, RegistryEvent>
    extraPageFields?: Record<string, unknown>
    ignoreLimit?: boolean
  } = {},
): TestFetch {
  const headRequests: string[] = []
  const requests: string[] = []
  const fetchImpl = (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = String(input)
    requests.push(url)

    if (init?.method === 'HEAD') {
      headRequests.push(url)
    }

    const parsed = new URL(url)
    if (parsed.pathname.startsWith('/events/sha256/')) {
      const digest = `sha256:${parsed.pathname.split('/').pop()}`
      const event =
        options.eventEndpointEvents?.get(digest) ??
        events.find((item) => item.id === digest)

      if (!event) {
        return Promise.resolve(new Response('not found', { status: 404 }))
      }

      return Promise.resolve(
        jsonResponse(event, {
          headers: {
            etag: `"${event.id}"`,
          },
        }),
      )
    }

    if (parsed.pathname !== '/events') {
      return Promise.resolve(new Response('not found', { status: 404 }))
    }

    const after = parsed.searchParams.get('after')
    const limit = Number(parsed.searchParams.get('limit') ?? '999')
    const afterIndex = after
      ? events.findIndex((event) => event.id === after)
      : -1
    const startIndex = afterIndex + 1
    const pageEvents = options.ignoreLimit
      ? events.slice(startIndex)
      : events.slice(startIndex, startIndex + limit)
    const lastEvent = pageEvents.at(-1)

    return Promise.resolve(
      jsonResponse({
        events: pageEvents,
        ...options.extraPageFields,
        ...(lastEvent ? { nextAfter: lastEvent.id } : {}),
        schema: 'regesta.event-log.v0',
      }),
    )
  }

  return Object.assign(fetchImpl, { headRequests, requests })
}

function jsonResponse(value: unknown, init?: ResponseInit): Response {
  return Response.json(value, init)
}

function jsonFetch(value: unknown): typeof fetch {
  return () => {
    return Promise.resolve(jsonResponse(value))
  }
}

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value)
}
