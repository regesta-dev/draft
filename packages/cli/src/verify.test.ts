import { Buffer } from 'node:buffer'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { replayPackageState, type StoredRelease } from '@regesta/core'
import {
  canonicalJson,
  defaultPackageChannel,
  registryEventDigest,
  sha256,
  type ChannelUpdatedEvent,
  type ObjectDescriptor,
  type PackageId,
  type PackageState,
  type PublishReleaseEvent,
  type RegistryEvent,
  type ReleaseManifest,
  type WriteAuthorizationProof,
} from '@regesta/protocol'
import * as tar from 'tar'
import { describe, expect, it } from 'vitest'
import {
  compareEventLogsFromRegistries,
  verifyEventLogFromRegistry,
  verifyPackageStateFromRegistry,
  verifyReleaseFromRegistry,
} from './verify.ts'

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

  it('uses isolated request options while reading public registry data', async () => {
    const fixture = releaseFixture()
    const baseFetch = publicRegistryFetch(fixture)
    const requestInits: Array<RequestInit | undefined> = []
    const fetch = Object.assign(
      (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        requestInits.push(init)
        return baseFetch(input, init)
      },
      {
        headRequests: baseFetch.headRequests,
        requests: baseFetch.requests,
      },
    )

    const result = await verifyReleaseFromRegistry({
      fetch,
      packageId: fixture.release.manifest.id,
      registry: 'https://registry.example/',
      version: fixture.release.manifest.version,
    })

    expect(result.ok).toBe(true)
    expect(requestInits).toHaveLength(8)
    expect(requestInits.every((init) => init?.redirect === 'error')).toBe(true)
    expect(requestInits.every((init) => init?.cache === 'no-store')).toBe(true)
    expect(requestInits.every((init) => init?.credentials === 'omit')).toBe(
      true,
    )
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
      `Source object read failed: Public object body digest does not match URL: https://registry.example/objects/sha256/${fixture.release.manifest.source.digest.slice('sha256:'.length)}`,
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
                'cache-control': 'public, max-age=31536000, immutable',
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
                'cache-control': 'public, max-age=31536000, immutable',
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
                'cache-control': 'public, max-age=31536000, immutable',
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
                'cache-control': 'public, max-age=31536000, immutable',
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
                'cache-control': 'public, max-age=31536000, immutable',
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
                'cache-control': 'public, max-age=31536000, immutable',
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
                'cache-control': 'public, max-age=31536000, immutable',
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
                'cache-control': 'public, max-age=31536000, immutable',
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

  it('reports weak public object ETags as verification problems', async () => {
    const fixture = releaseFixture()
    const sourceDigest = fixture.release.manifest.source.digest
    const fetch = publicRegistryFetch(fixture)
    const weakObjectEtagFetch = Object.assign(
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
                'cache-control': 'public, max-age=31536000, immutable',
                'content-length': String(source?.descriptor.size),
                'content-type':
                  source?.descriptor.mediaType ?? 'application/octet-stream',
                etag: `W/"${sourceDigest}"`,
              },
            }),
          )
        }

        return fetch(input, init)
      },
      { headRequests: fetch.headRequests, requests: fetch.requests },
    )

    const result = await verifyReleaseFromRegistry({
      fetch: weakObjectEtagFetch,
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
                'cache-control': 'public, max-age=31536000, immutable',
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
                'cache-control': 'public, max-age=31536000, immutable',
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

  it('reports missing public object HEAD Cache-Control headers as verification problems', async () => {
    const fixture = releaseFixture()
    const sourceDigest = fixture.release.manifest.source.digest
    const fetch = publicRegistryFetch(fixture)
    const missingObjectCacheFetch = Object.assign(
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
      fetch: missingObjectCacheFetch,
      packageId: fixture.release.manifest.id,
      registry: 'https://registry.example',
      version: fixture.release.manifest.version,
    })

    expect(result.ok).toBe(false)
    expect(result.problems).toContain(
      `Source object descriptor read failed: Missing object Cache-Control header: https://registry.example/objects/sha256/${sourceDigest.slice('sha256:'.length)}`,
    )
  })

  it('reports public object GET Cache-Control responses without immutable as verification problems', async () => {
    const fixture = releaseFixture()
    const sourceDigest = fixture.release.manifest.source.digest
    const fetch = publicRegistryFetch(fixture)
    const mutableObjectCacheFetch = Object.assign(
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
                'cache-control': 'public, max-age=60',
                'content-length': String(source?.descriptor.size),
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
      fetch: mutableObjectCacheFetch,
      packageId: fixture.release.manifest.id,
      registry: 'https://registry.example',
      version: fixture.release.manifest.version,
    })

    expect(result.ok).toBe(false)
    expect(result.problems).toContain(
      `Source object read failed: Object Cache-Control must include immutable: https://registry.example/objects/sha256/${sourceDigest.slice('sha256:'.length)}`,
    )
  })

  it('reports public object HEAD responses without Accept-Ranges headers as verification problems', async () => {
    const fixture = releaseFixture()
    const sourceDigest = fixture.release.manifest.source.digest
    const fetch = publicRegistryFetch(fixture)
    const missingObjectAcceptRangesFetch = Object.assign(
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
                'cache-control': 'public, max-age=31536000, immutable',
                'content-length': String(source?.descriptor.size),
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
      fetch: missingObjectAcceptRangesFetch,
      packageId: fixture.release.manifest.id,
      registry: 'https://registry.example',
      version: fixture.release.manifest.version,
    })

    expect(result.ok).toBe(false)
    expect(result.problems).toContain(
      `Source object descriptor read failed: Missing object Accept-Ranges header: https://registry.example/objects/sha256/${sourceDigest.slice('sha256:'.length)}`,
    )
  })

  it('reports public object GET responses with non-byte Accept-Ranges headers as verification problems', async () => {
    const fixture = releaseFixture()
    const sourceDigest = fixture.release.manifest.source.digest
    const fetch = publicRegistryFetch(fixture)
    const invalidObjectAcceptRangesFetch = Object.assign(
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
                'accept-ranges': 'none',
                'cache-control': 'public, max-age=31536000, immutable',
                'content-length': String(source?.descriptor.size),
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
      fetch: invalidObjectAcceptRangesFetch,
      packageId: fixture.release.manifest.id,
      registry: 'https://registry.example',
      version: fixture.release.manifest.version,
    })

    expect(result.ok).toBe(false)
    expect(result.problems).toContain(
      `Source object read failed: Object Accept-Ranges must be bytes: https://registry.example/objects/sha256/${sourceDigest.slice('sha256:'.length)}`,
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

  it('reports non-canonical public release response bodies', async () => {
    const fixture = releaseFixture()
    const result = await verifyReleaseFromRegistry({
      fetch: () =>
        Promise.resolve(
          jsonResponse(fixture.release, {
            headers: {
              etag: `"${fixture.release.event.id}"`,
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
        'Public release request failed: Response body is not canonical JSON: https://registry.example/packages/npm%3Aexample.com%2Fhello-regesta/releases/1.0.0',
      ],
    })
  })

  it('reports missing public release Content-Length headers', async () => {
    const fixture = releaseFixture()
    const result = await verifyReleaseFromRegistry({
      fetch: () =>
        Promise.resolve(
          new Response(`${canonicalJson(fixture.release)}\n`, {
            headers: {
              'content-type': 'application/json; charset=utf-8',
              etag: `"${fixture.release.event.id}"`,
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
        'Public release request failed: Missing canonical JSON Content-Length header: https://registry.example/packages/npm%3Aexample.com%2Fhello-regesta/releases/1.0.0',
      ],
    })
  })

  it('reports public release Content-Length mismatches', async () => {
    const fixture = releaseFixture()
    const result = await verifyReleaseFromRegistry({
      fetch: () =>
        Promise.resolve(
          canonicalJsonResponse(fixture.release, {
            headers: {
              'content-length': '1',
              etag: `"${fixture.release.event.id}"`,
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
        'Public release request failed: Canonical JSON Content-Length does not match body: https://registry.example/packages/npm%3Aexample.com%2Fhello-regesta/releases/1.0.0',
      ],
    })
  })

  it('reports missing immutable public release Cache-Control headers', async () => {
    const fixture = releaseFixture()
    const result = await verifyReleaseFromRegistry({
      fetch: () =>
        Promise.resolve(
          new Response(`${canonicalJson(fixture.release)}\n`, {
            headers: {
              'content-length': String(
                bytes(`${canonicalJson(fixture.release)}\n`).byteLength,
              ),
              'content-type': 'application/json; charset=utf-8',
              etag: `"${fixture.release.event.id}"`,
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
        'Public release request failed: Missing immutable JSON Cache-Control header: https://registry.example/packages/npm%3Aexample.com%2Fhello-regesta/releases/1.0.0',
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

  it('reports public release manifest descriptor digest mismatches', async () => {
    const fixture = releaseFixture()
    fixture.release.manifest.metadata = {
      description: 'Tampered release metadata',
    }

    const result = await verifyReleaseFromRegistry({
      fetch: publicRegistryFetch(fixture),
      packageId: fixture.release.manifest.id,
      registry: 'https://registry.example',
      version: fixture.release.manifest.version,
    })

    expect(result.ok).toBe(false)
    expect(result.problems).toContain(
      'Release manifest digest does not match stored descriptor',
    )
  })

  it('reports public release authorization proof problems', async () => {
    const fixture = releaseFixture()
    const authorization = authorizationProof({
      domain: 'other.example.com',
      signedAt: '2026-06-09T00:01:00.000Z',
    })
    const { id: _id, ...eventPayload } = fixture.release.event
    const authorizedEventPayload = {
      ...eventPayload,
      authorization,
    } satisfies Omit<PublishReleaseEvent, 'id'>
    fixture.release.event = {
      ...authorizedEventPayload,
      id: registryEventDigest(authorizedEventPayload),
    }

    const result = await verifyReleaseFromRegistry({
      fetch: publicRegistryFetch(fixture),
      packageId: fixture.release.manifest.id,
      registry: 'https://registry.example',
      version: fixture.release.manifest.version,
    })

    expect(result.ok).toBe(false)
    expect(result.problems).toEqual([
      'Public event response is invalid: Registry event authorization domain does not match package owner',
    ])
  })

  it('reports npm artifact metadata that cannot be reproduced from artifact bytes', async () => {
    const fixture = releaseFixture()
    replaceInstallArtifact(fixture, {
      bytes: await npmPackageTarball({
        dependencies: {
          '@example.com/base': '^1.0.0',
        },
        description: 'Fixture package',
        name: '@example.com/hello-regesta',
        version: '1.0.0',
      }),
      ecosystemMetadata: {
        npm: {
          dependencies: {
            '@example.com/base': '^2.0.0',
          },
        },
      },
    })

    const result = await verifyReleaseFromRegistry({
      fetch: publicRegistryFetch(fixture),
      packageId: fixture.release.manifest.id,
      registry: 'https://registry.example',
      version: fixture.release.manifest.version,
    })

    expect(result).toMatchObject({
      ok: false,
      problems: [
        'npm artifact ecosystemMetadata does not match install artifact',
      ],
    })
  })

  it('reports release descriptions that cannot be reproduced from npm install artifacts', async () => {
    const fixture = releaseFixture()
    replaceInstallArtifact(fixture, {
      bytes: await npmPackageTarball({
        description: 'Artifact description',
        name: '@example.com/hello-regesta',
        version: '1.0.0',
      }),
    })
    fixture.release.manifest.metadata = {
      description: 'Tampered release metadata',
    }
    refreshReleaseFixtureDerivedObjects(fixture)

    const result = await verifyReleaseFromRegistry({
      fetch: publicRegistryFetch(fixture),
      packageId: fixture.release.manifest.id,
      registry: 'https://registry.example',
      version: fixture.release.manifest.version,
    })

    expect(result).toMatchObject({
      ok: false,
      problems: [
        'npm release metadata.description does not match install artifact',
      ],
    })
  })

  it('reports invalid npm install artifacts even without declared npm metadata', async () => {
    const fixture = releaseFixture()
    replaceInstallArtifact(fixture, {
      bytes: bytes('not a tarball'),
    })

    const result = await verifyReleaseFromRegistry({
      fetch: publicRegistryFetch(fixture),
      packageId: fixture.release.manifest.id,
      registry: 'https://registry.example',
      version: fixture.release.manifest.version,
    })

    expect(result).toMatchObject({
      ok: false,
      problems: [
        'npm install artifact verification failed: npm install artifact must include package/package.json',
      ],
    })
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
            canonicalJsonResponse(fixture.release, {
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
      fetch: () => Promise.resolve(canonicalJsonResponse(fixture.release)),
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
            canonicalJsonResponse(fixture.release.event, {
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

  it('rejects public release events that differ from immutable event responses', async () => {
    const fixture = releaseFixture()
    const fetch = publicRegistryFetch(fixture)
    const tamperedRelease: StoredRelease = {
      ...fixture.release,
      event: {
        ...fixture.release.event,
        channel: 'beta',
      },
    }
    const mismatchedReleaseEventFetch = Object.assign(
      (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = String(input)
        if (url.includes('/packages/')) {
          fetch.requests.push(url)

          return Promise.resolve(
            canonicalJsonResponse(tamperedRelease, {
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
      fetch: mismatchedReleaseEventFetch,
      packageId: fixture.release.manifest.id,
      registry: 'https://registry.example',
      version: fixture.release.manifest.version,
    })

    expect(result).toEqual({
      manifest: fixture.release.manifest,
      ok: false,
      problems: ['Public release event does not match public event response'],
    })
    expect(fetch.requests.every((url) => !url.includes('/objects/'))).toBe(true)
  })

  it('reports missing public event ETag headers as verification problems', async () => {
    const fixture = releaseFixture()
    const fetch = publicRegistryFetch(fixture)
    const missingEventEtagFetch = Object.assign(
      (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = String(input)
        if (url.includes('/events/')) {
          fetch.requests.push(url)

          return Promise.resolve(canonicalJsonResponse(fixture.release.event))
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

  it('reports non-canonical public event response bodies', async () => {
    const fixture = releaseFixture()
    const fetch = publicRegistryFetch(fixture)
    const nonCanonicalEventFetch = Object.assign(
      (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = String(input)
        if (url.includes('/events/')) {
          fetch.requests.push(url)

          return Promise.resolve(
            jsonResponse(fixture.release.event, {
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
      fetch: nonCanonicalEventFetch,
      packageId: fixture.release.manifest.id,
      registry: 'https://registry.example',
      version: fixture.release.manifest.version,
    })

    expect(result.ok).toBe(false)
    expect(result.problems).toEqual([
      `Public event request failed: Response body is not canonical JSON: https://registry.example/events/sha256/${fixture.release.event.id.slice('sha256:'.length)}`,
    ])
  })

  it('reports missing public event Content-Length headers', async () => {
    const fixture = releaseFixture()
    const fetch = publicRegistryFetch(fixture)
    const missingContentLengthFetch = Object.assign(
      (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = String(input)
        if (url.includes('/events/')) {
          fetch.requests.push(url)

          return Promise.resolve(
            new Response(`${canonicalJson(fixture.release.event)}\n`, {
              headers: {
                'content-type': 'application/json; charset=utf-8',
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
      fetch: missingContentLengthFetch,
      packageId: fixture.release.manifest.id,
      registry: 'https://registry.example',
      version: fixture.release.manifest.version,
    })

    expect(result.ok).toBe(false)
    expect(result.problems).toEqual([
      `Public event request failed: Missing canonical JSON Content-Length header: https://registry.example/events/sha256/${fixture.release.event.id.slice('sha256:'.length)}`,
    ])
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
            canonicalJsonResponse(mismatchedEvent, {
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
            canonicalJsonResponse(
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

  it('uses isolated request options while reading public event logs', async () => {
    const fixture = releaseFixture()
    const channelEvent = channelUpdatedEvent(fixture.release.event, {
      channel: 'beta',
      timestamp: '2026-06-09T00:01:00.000Z',
      version: fixture.release.manifest.version,
    })
    const baseFetch = publicEventLogFetch([fixture.release.event, channelEvent])
    const requestInits: Array<RequestInit | undefined> = []
    const fetch = Object.assign(
      (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        requestInits.push(init)
        return baseFetch(input, init)
      },
      {
        headRequests: baseFetch.headRequests,
        requests: baseFetch.requests,
      },
    )

    const result = await verifyEventLogFromRegistry({
      fetch,
      limit: 1,
      registry: 'https://registry.example/',
    })

    expect(result.ok).toBe(true)
    expect(requestInits).toHaveLength(5)
    expect(requestInits.every((init) => init?.cache === 'no-store')).toBe(true)
    expect(requestInits.every((init) => init?.credentials === 'omit')).toBe(
      true,
    )
    expect(requestInits.every((init) => init?.redirect === 'error')).toBe(true)
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

  it('rejects non-canonical immutable event endpoint responses', async () => {
    const fixture = releaseFixture()
    const baseFetch = publicEventLogFetch([fixture.release.event])
    const fetch = Object.assign(
      (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = String(input)

        if (url.includes('/events/sha256/')) {
          baseFetch.requests.push(url)
          return Promise.resolve(
            jsonResponse(fixture.release.event, {
              headers: {
                etag: `"${fixture.release.event.id}"`,
              },
            }),
          )
        }

        return baseFetch(input, init)
      },
      {
        headRequests: baseFetch.headRequests,
        requests: baseFetch.requests,
      },
    )

    const result = await verifyEventLogFromRegistry({
      fetch,
      registry: 'https://registry.example',
    })

    expect(result).toEqual({
      checkedEvents: 0,
      ok: false,
      packages: 0,
      problems: [
        `Public event endpoint request failed: Response body is not canonical JSON: https://registry.example/events/sha256/${fixture.release.event.id.slice('sha256:'.length)}`,
      ],
    })
  })

  it('rejects immutable event endpoint Content-Length mismatches', async () => {
    const fixture = releaseFixture()
    const baseFetch = publicEventLogFetch([fixture.release.event])
    const fetch = Object.assign(
      (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = String(input)

        if (url.includes('/events/sha256/')) {
          baseFetch.requests.push(url)
          return Promise.resolve(
            canonicalJsonResponse(fixture.release.event, {
              headers: {
                'cache-control': 'public, max-age=31536000, immutable',
                'content-length': '1',
                etag: `"${fixture.release.event.id}"`,
              },
            }),
          )
        }

        return baseFetch(input, init)
      },
      {
        headRequests: baseFetch.headRequests,
        requests: baseFetch.requests,
      },
    )

    const result = await verifyEventLogFromRegistry({
      fetch,
      registry: 'https://registry.example',
    })

    expect(result).toEqual({
      checkedEvents: 0,
      ok: false,
      packages: 0,
      problems: [
        `Public event endpoint request failed: Canonical JSON Content-Length does not match body: https://registry.example/events/sha256/${fixture.release.event.id.slice('sha256:'.length)}`,
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

  it('reports invalid channel authorization proofs in public event logs', async () => {
    const fixture = releaseFixture()
    const channelEvent = channelUpdatedEvent(fixture.release.event, {
      authorization: authorizationProof({
        domain: 'other.example.com',
        signedAt: '2026-06-09T00:01:00.000Z',
      }),
      channel: 'beta',
      timestamp: '2026-06-09T00:01:00.000Z',
      version: fixture.release.manifest.version,
    })
    const result = await verifyEventLogFromRegistry({
      fetch: publicEventLogFetch([fixture.release.event, channelEvent]),
      registry: 'https://registry.example',
    })

    expect(result.ok).toBe(false)
    expect(result.problems).toEqual([
      'Public event log event is invalid: Registry event authorization domain does not match package owner',
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

  it('rejects empty event log pages that include nextAfter', async () => {
    const result = await verifyEventLogFromRegistry({
      fetch: publicEventLogFetch([], {
        emptyPageNextAfter: sha256(bytes('unexpected cursor')),
      }),
      registry: 'https://registry.example',
    })

    expect(result).toEqual({
      checkedEvents: 0,
      ok: false,
      packages: 0,
      problems: ['Public event log empty page must not include nextAfter'],
    })
  })

  it('rejects event log pages whose nextAfter does not match the last event', async () => {
    const fixture = releaseFixture()

    const result = await verifyEventLogFromRegistry({
      fetch: publicEventLogFetch([fixture.release.event], {
        pageNextAfter: sha256(bytes('different cursor')),
      }),
      registry: 'https://registry.example',
    })

    expect(result).toEqual({
      checkedEvents: 0,
      ok: false,
      packages: 0,
      problems: ['Public event log nextAfter must match last event id'],
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

  it('reports event log pages without ETags', async () => {
    const fixture = releaseFixture()

    const result = await verifyEventLogFromRegistry({
      fetch: publicEventLogFetch([fixture.release.event], {
        omitPageEtag: true,
      }),
      registry: 'https://registry.example',
    })

    expect(result).toEqual({
      checkedEvents: 0,
      ok: false,
      packages: 0,
      problems: ['Public event log response is missing ETag'],
    })
  })

  it('reports event log page ETag mismatches', async () => {
    const fixture = releaseFixture()

    const result = await verifyEventLogFromRegistry({
      fetch: publicEventLogFetch([fixture.release.event], {
        pageEtag: `W/"regesta.event-log:sha256:${'0'.repeat(64)}:1"`,
      }),
      registry: 'https://registry.example',
    })

    expect(result).toEqual({
      checkedEvents: 0,
      ok: false,
      packages: 0,
      problems: ['Public event log response ETag does not match page cursor'],
    })
  })

  it('reports event log pages without Cache-Control', async () => {
    const fixture = releaseFixture()

    const result = await verifyEventLogFromRegistry({
      fetch: publicEventLogFetch([fixture.release.event], {
        omitPageCacheControl: true,
      }),
      registry: 'https://registry.example',
    })

    expect(result).toEqual({
      checkedEvents: 0,
      ok: false,
      packages: 0,
      problems: ['Public event log response is missing Cache-Control'],
    })
  })

  it('reports event log pages without no-cache directives', async () => {
    const fixture = releaseFixture()

    const result = await verifyEventLogFromRegistry({
      fetch: publicEventLogFetch([fixture.release.event], {
        pageCacheControl: 'public, max-age=60',
      }),
      registry: 'https://registry.example',
    })

    expect(result).toEqual({
      checkedEvents: 0,
      ok: false,
      packages: 0,
      problems: [
        'Public event log response Cache-Control must include no-cache',
      ],
    })
  })

  it('reports event log pages without Content-Length headers', async () => {
    const fixture = releaseFixture()

    const result = await verifyEventLogFromRegistry({
      fetch: publicEventLogFetch([fixture.release.event], {
        omitPageContentLength: true,
      }),
      registry: 'https://registry.example',
    })

    expect(result).toEqual({
      checkedEvents: 0,
      ok: false,
      packages: 0,
      problems: [
        'Public event log request failed: Missing JSON Content-Length header: https://registry.example/events?limit=999',
      ],
    })
  })

  it('reports event log page Content-Length mismatches', async () => {
    const fixture = releaseFixture()

    const result = await verifyEventLogFromRegistry({
      fetch: publicEventLogFetch([fixture.release.event], {
        pageContentLength: '1',
      }),
      registry: 'https://registry.example',
    })

    expect(result).toEqual({
      checkedEvents: 0,
      ok: false,
      packages: 0,
      problems: [
        'Public event log request failed: JSON Content-Length does not match body: https://registry.example/events?limit=999',
      ],
    })
  })
})

describe('compareEventLogsFromRegistries', () => {
  it('compares matching public event log views', async () => {
    const fixture = releaseFixture()
    const channelEvent = channelUpdatedEvent(fixture.release.event, {
      channel: 'beta',
      timestamp: '2026-06-09T00:01:00.000Z',
      version: fixture.release.manifest.version,
    })
    const events = [fixture.release.event, channelEvent]

    const result = await compareEventLogsFromRegistries({
      fetch: eventLogComparisonFetch({
        left: publicEventLogFetch(events),
        right: publicEventLogFetch(events),
      }),
      leftRegistry: 'https://left.example/',
      limit: 1,
      rightRegistry: 'https://right.example/',
    })

    expect(result).toEqual({
      checkedEvents: 2,
      left: {
        checkedEvents: 2,
        lastEventId: channelEvent.id,
        packages: 1,
        registry: 'https://left.example',
      },
      ok: true,
      problems: [],
      right: {
        checkedEvents: 2,
        lastEventId: channelEvent.id,
        packages: 1,
        registry: 'https://right.example',
      },
    })
  })

  it('reports the first divergent public event log entry', async () => {
    const fixture = releaseFixture()
    const leftChannelEvent = channelUpdatedEvent(fixture.release.event, {
      channel: 'beta',
      timestamp: '2026-06-09T00:01:00.000Z',
      version: fixture.release.manifest.version,
    })
    const rightChannelEvent = channelUpdatedEvent(fixture.release.event, {
      channel: 'canary',
      timestamp: '2026-06-09T00:01:00.000Z',
      version: fixture.release.manifest.version,
    })

    const result = await compareEventLogsFromRegistries({
      fetch: eventLogComparisonFetch({
        left: publicEventLogFetch([fixture.release.event, leftChannelEvent]),
        right: publicEventLogFetch([fixture.release.event, rightChannelEvent]),
      }),
      leftRegistry: 'https://left.example',
      rightRegistry: 'https://right.example',
    })

    expect(result.ok).toBe(false)
    expect(result.problems).toEqual([
      `Registry event logs diverge at index 1: left ${leftChannelEvent.id}, right ${rightChannelEvent.id}`,
    ])
  })

  it('prefixes side-specific public event log verification failures', async () => {
    const fixture = releaseFixture()
    const channelEvent = channelUpdatedEvent(fixture.release.event, {
      channel: 'beta',
      timestamp: '2026-06-09T00:01:00.000Z',
      version: fixture.release.manifest.version,
    })
    const events = [fixture.release.event, channelEvent]

    const result = await compareEventLogsFromRegistries({
      fetch: eventLogComparisonFetch({
        left: publicEventLogFetch(events),
        right: publicEventLogFetch(events),
      }),
      leftRegistry: 'https://left.example',
      limit: 1,
      maxPages: 1,
      rightRegistry: 'https://right.example',
    })

    expect(result.ok).toBe(false)
    expect(result.problems).toEqual([
      'Left registry event log failed: Public event log verification stopped before reaching tail',
      'Right registry event log failed: Public event log verification stopped before reaching tail',
    ])
  })
})

describe('verifyPackageStateFromRegistry', () => {
  it('verifies public package state against event log replay', async () => {
    const fixture = releaseFixture()
    const channelEvent = channelUpdatedEvent(fixture.release.event, {
      channel: 'beta',
      timestamp: '2026-06-09T00:01:00.000Z',
      version: fixture.release.manifest.version,
    })
    const events = [fixture.release.event, channelEvent]
    const fetch = publicPackageStateFetch(fixture.release.manifest.id, events)

    const result = await verifyPackageStateFromRegistry({
      fetch,
      limit: 1,
      packageId: fixture.release.manifest.id,
      registry: 'https://registry.example/',
    })

    expect(result).toEqual({
      checkedEvents: 2,
      lastEventId: channelEvent.id,
      ok: true,
      problems: [],
      state: replayPackageState(events, fixture.release.manifest.id),
    })
    expect(fetch.requests).toEqual([
      'https://registry.example/packages/npm%3Aexample.com%2Fhello-regesta',
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

  it('uses isolated request options while verifying package state', async () => {
    const fixture = releaseFixture()
    const channelEvent = channelUpdatedEvent(fixture.release.event, {
      channel: 'beta',
      timestamp: '2026-06-09T00:01:00.000Z',
      version: fixture.release.manifest.version,
    })
    const baseFetch = publicPackageStateFetch(fixture.release.manifest.id, [
      fixture.release.event,
      channelEvent,
    ])
    const requestInits: Array<RequestInit | undefined> = []
    const fetch = Object.assign(
      (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        requestInits.push(init)
        return baseFetch(input, init)
      },
      {
        headRequests: baseFetch.headRequests,
        requests: baseFetch.requests,
      },
    )

    const result = await verifyPackageStateFromRegistry({
      fetch,
      limit: 1,
      packageId: fixture.release.manifest.id,
      registry: 'https://registry.example/',
    })

    expect(result.ok).toBe(true)
    expect(requestInits).toHaveLength(6)
    expect(requestInits.every((init) => init?.cache === 'no-store')).toBe(true)
    expect(requestInits.every((init) => init?.credentials === 'omit')).toBe(
      true,
    )
    expect(requestInits.every((init) => init?.redirect === 'error')).toBe(true)
  })

  it('reports public package states that do not match event log replay', async () => {
    const fixture = releaseFixture()
    const expected = replayPackageState(
      [fixture.release.event],
      fixture.release.manifest.id,
    )
    const state: PackageState = {
      ...expected,
      channels: {
        latest: '9.9.9',
      },
    }

    const result = await verifyPackageStateFromRegistry({
      fetch: publicPackageStateFetch(
        fixture.release.manifest.id,
        [fixture.release.event],
        {
          state,
        },
      ),
      packageId: fixture.release.manifest.id,
      registry: 'https://registry.example',
    })

    expect(result.ok).toBe(false)
    expect(result.problems).toEqual([
      'Public package state does not match public event log replay',
    ])
  })

  it('reports public package state responses without Content-Length headers', async () => {
    const fixture = releaseFixture()

    const result = await verifyPackageStateFromRegistry({
      fetch: publicPackageStateFetch(
        fixture.release.manifest.id,
        [fixture.release.event],
        {
          stateResponseInit: {
            omitContentLength: true,
          },
        },
      ),
      packageId: fixture.release.manifest.id,
      registry: 'https://registry.example',
    })

    expect(result).toEqual({
      checkedEvents: 0,
      ok: false,
      problems: [
        'Public package state request failed: Missing JSON Content-Length header: https://registry.example/packages/npm%3Aexample.com%2Fhello-regesta',
      ],
    })
  })

  it('reports invalid public package state Content-Type headers', async () => {
    const fixture = releaseFixture()

    const result = await verifyPackageStateFromRegistry({
      fetch: publicPackageStateFetch(
        fixture.release.manifest.id,
        [fixture.release.event],
        {
          stateResponseInit: {
            headers: {
              'content-type': 'text/plain',
            },
          },
        },
      ),
      packageId: fixture.release.manifest.id,
      registry: 'https://registry.example',
    })

    expect(result).toEqual({
      checkedEvents: 0,
      ok: false,
      problems: [
        'Public package state request failed: Invalid JSON Content-Type header: https://registry.example/packages/npm%3Aexample.com%2Fhello-regesta',
      ],
    })
  })

  it('reports public package state responses without Cache-Control headers', async () => {
    const fixture = releaseFixture()

    const result = await verifyPackageStateFromRegistry({
      fetch: publicPackageStateFetch(
        fixture.release.manifest.id,
        [fixture.release.event],
        {
          stateCacheControl: null,
        },
      ),
      packageId: fixture.release.manifest.id,
      registry: 'https://registry.example',
    })

    expect(result.ok).toBe(false)
    expect(result.problems).toEqual([
      'Public package state response is missing Cache-Control',
    ])
  })

  it('reports public package state responses without no-cache directives', async () => {
    const fixture = releaseFixture()

    const result = await verifyPackageStateFromRegistry({
      fetch: publicPackageStateFetch(
        fixture.release.manifest.id,
        [fixture.release.event],
        {
          stateCacheControl: 'public, max-age=60',
        },
      ),
      packageId: fixture.release.manifest.id,
      registry: 'https://registry.example',
    })

    expect(result.ok).toBe(false)
    expect(result.problems).toEqual([
      'Public package state response Cache-Control must include no-cache',
    ])
  })

  it('reports public package state identity mismatches once', async () => {
    const fixture = releaseFixture()
    const state: PackageState = {
      ...replayPackageState(
        [fixture.release.event],
        fixture.release.manifest.id,
      ),
      id: 'npm:example.com/other-regesta',
    }

    const result = await verifyPackageStateFromRegistry({
      fetch: publicPackageStateFetch(
        fixture.release.manifest.id,
        [fixture.release.event],
        {
          state,
        },
      ),
      packageId: fixture.release.manifest.id,
      registry: 'https://registry.example',
    })

    expect(result).toEqual({
      checkedEvents: 0,
      ok: false,
      problems: ['Public package state response id does not match package id'],
    })
  })

  it('reports package event histories that cannot replay public package state', async () => {
    const fixture = releaseFixture()
    const channelEvent = channelUpdatedEvent(fixture.release.event, {
      channel: 'beta',
      timestamp: '2026-06-09T00:01:00.000Z',
      version: '2.0.0',
    })

    const result = await verifyPackageStateFromRegistry({
      fetch: publicPackageStateFetch(
        fixture.release.manifest.id,
        [fixture.release.event, channelEvent],
        {
          state: replayPackageState(
            [fixture.release.event],
            fixture.release.manifest.id,
          ),
        },
      ),
      packageId: fixture.release.manifest.id,
      registry: 'https://registry.example',
    })

    expect(result.ok).toBe(false)
    expect(result.problems).toEqual([
      'Public package state replay failed: Registry event channel target version does not exist: 2.0.0',
    ])
  })

  it('reports public package state ETags that do not match package events', async () => {
    const fixture = releaseFixture()

    const result = await verifyPackageStateFromRegistry({
      fetch: publicPackageStateFetch(
        fixture.release.manifest.id,
        [fixture.release.event],
        {
          stateEtag: `W/"sha256:${'0'.repeat(64)}"`,
        },
      ),
      packageId: fixture.release.manifest.id,
      registry: 'https://registry.example',
    })

    expect(result.ok).toBe(false)
    expect(result.problems).toEqual([
      'Public package state response ETag does not match last package event id',
    ])
  })
})

function releaseFixture(): {
  objects: Map<string, { bytes: Uint8Array; descriptor: ObjectDescriptor }>
  release: StoredRelease
} {
  const sourceBytes = bytes('source archive')
  const artifactBytes = validNpmInstallArtifactBytes()
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

function validNpmInstallArtifactBytes(): Uint8Array {
  return Buffer.from(
    'H4sIAAAAAAAAE+3SvQqDMBQFYOc+Rbiz1ZuoEZw69T2CvVjrTyRREUrfvVhLcehQqNAO+ZaTCwnkhHQqr1RBYbdkcLG69TaGiDKO2ZypTB6JYplnPELm8URwEcs0kdxDLkU079v6Iu8MtlfGQ6xoLL9pvnRhr/wD6zddr9eucCKbm7LrS91CBsdy6gdD7PkfwIdWNQQZHGhSTVdTkOsmPFNd672hgmyvwIeRjF3O8wADhNvuZ6Udx3Gcj9wB7R39EAAIAAA=',
    'base64',
  )
}

function replaceInstallArtifact(
  fixture: {
    objects: Map<string, { bytes: Uint8Array; descriptor: ObjectDescriptor }>
    release: StoredRelease
  },
  input: {
    bytes: Uint8Array
    ecosystemMetadata?: Record<string, unknown>
  },
): void {
  const artifact = {
    ...descriptor(input.bytes, 'application/gzip'),
    ...(input.ecosystemMetadata
      ? { ecosystemMetadata: input.ecosystemMetadata }
      : {}),
    filename: 'hello-regesta-1.0.0.tgz',
    format: 'npm-tarball',
    role: 'install',
  }
  fixture.release.manifest.artifacts = [artifact]
  fixture.objects.set(artifact.digest, {
    bytes: input.bytes,
    descriptor: artifact,
  })
  refreshReleaseFixtureDerivedObjects(fixture)
}

function refreshReleaseFixtureDerivedObjects(fixture: {
  objects: Map<string, { bytes: Uint8Array; descriptor: ObjectDescriptor }>
  release: StoredRelease
}): void {
  const { manifest } = fixture.release
  const manifestBytes = bytes(`${canonicalJson(manifest)}\n`)
  const manifestDescriptor = descriptor(
    manifestBytes,
    'application/vnd.regesta.release-manifest.v0+json',
  )
  const eventPayload: Omit<PublishReleaseEvent, 'id'> = {
    artifactDigests: manifest.artifacts.map((artifact) => artifact.digest),
    channel: defaultPackageChannel,
    eventType: 'release.published',
    object: 'regesta.event',
    release: {
      id: manifest.id,
      manifestDigest: manifestDescriptor.digest,
      version: manifest.version,
    },
    sourceDigest: manifest.source.digest,
    timestamp: manifest.createdAt,
  }

  fixture.release.manifestDescriptor = manifestDescriptor
  fixture.release.event = {
    ...eventPayload,
    id: registryEventDigest(eventPayload),
  }
  fixture.objects.set(manifestDescriptor.digest, {
    bytes: manifestBytes,
    descriptor: manifestDescriptor,
  })
}

async function npmPackageTarball(
  packageJson: Record<string, unknown>,
): Promise<Uint8Array> {
  const root = await mkdtemp(join(tmpdir(), 'regesta-cli-verify-npm-'))

  try {
    await mkdir(join(root, 'package'))
    await writeFile(
      join(root, 'package', 'package.json'),
      `${JSON.stringify(packageJson)}\n`,
    )
    await tar.c(
      {
        cwd: root,
        file: join(root, 'package.tgz'),
        gzip: true,
      },
      ['package/package.json'],
    )

    return readFile(join(root, 'package.tgz'))
  } finally {
    await rm(root, { force: true, recursive: true })
  }
}

function channelUpdatedEvent(
  publishEvent: PublishReleaseEvent,
  options: {
    authorization?: WriteAuthorizationProof
    channel: string
    timestamp: string
    version: string
  },
): ChannelUpdatedEvent {
  const payload: Omit<ChannelUpdatedEvent, 'id'> = {
    ...(options.authorization ? { authorization: options.authorization } : {}),
    channel: options.channel,
    eventType: 'channel.updated',
    object: 'regesta.event',
    package: publishEvent.release.id,
    timestamp: options.timestamp,
    version: options.version,
  }

  return {
    ...payload,
    id: registryEventDigest(payload),
  }
}

function authorizationProof(input: {
  domain: string
  signedAt: string
}): WriteAuthorizationProof {
  return {
    alg: 'EdDSA',
    domain: input.domain,
    kid: 'ed25519:test',
    object: 'regesta.authorization-proof',
    payloadDigest: sha256(bytes('authorization payload')),
    publicKeyJwk: {
      crv: 'Ed25519',
      kty: 'OKP',
      x: Buffer.alloc(32).toString('base64url'),
    },
    signature: Buffer.alloc(64).toString('base64url'),
    signedAt: input.signedAt,
    wellKnownDigest: sha256(bytes('well-known')),
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
        canonicalJsonResponse(fixture.release, {
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
        canonicalJsonResponse(fixture.release.event, {
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
            'accept-ranges': 'bytes',
            'cache-control': 'public, max-age=31536000, immutable',
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
    emptyPageNextAfter?: string
    eventEndpointEvents?: Map<string, RegistryEvent>
    extraPageFields?: Record<string, unknown>
    ignoreLimit?: boolean
    omitPageCacheControl?: boolean
    omitPageContentLength?: boolean
    omitPageEtag?: boolean
    pageCacheControl?: string
    pageContentLength?: string
    pageEtag?: string
    pageNextAfter?: string
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
        canonicalJsonResponse(event, {
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
    const pageEtag =
      options.pageEtag ??
      `W/"regesta.event-log:${lastEvent?.id ?? after ?? 'head'}:${pageEvents.length}"`
    const nextAfter = lastEvent
      ? (options.pageNextAfter ?? lastEvent.id)
      : options.emptyPageNextAfter
    const headers = new Headers()
    if (!options.omitPageCacheControl) {
      headers.set('cache-control', options.pageCacheControl ?? 'no-cache')
    }
    if (!options.omitPageEtag) {
      headers.set('etag', pageEtag)
    }
    if (options.pageContentLength !== undefined) {
      headers.set('content-length', options.pageContentLength)
    }

    return Promise.resolve(
      jsonResponse(
        {
          events: pageEvents,
          ...options.extraPageFields,
          ...(nextAfter ? { nextAfter } : {}),
        },
        {
          headers,
          omitContentLength: options.omitPageContentLength,
        },
      ),
    )
  }

  return Object.assign(fetchImpl, { headRequests, requests })
}

function eventLogComparisonFetch(input: {
  left: TestFetch
  right: TestFetch
}): TestFetch {
  const headRequests: string[] = []
  const requests: string[] = []
  const fetchImpl = (
    request: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = String(request)
    const target = url.startsWith('https://left.example')
      ? input.left
      : input.right

    requests.push(url)
    if (init?.method === 'HEAD') {
      headRequests.push(url)
    }

    return target(request, init)
  }

  return Object.assign(fetchImpl, { headRequests, requests })
}

function publicPackageStateFetch(
  packageId: PackageId,
  events: RegistryEvent[],
  options: {
    stateCacheControl?: string | null
    state?: PackageState
    stateEtag?: string
    stateResponseInit?: ResponseInit & { omitContentLength?: boolean }
  } = {},
): TestFetch {
  const eventLogFetch = publicEventLogFetch(events)
  const requests = eventLogFetch.requests
  const headRequests = eventLogFetch.headRequests
  const fetchImpl = (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = String(input)
    const parsed = new URL(url)

    if (parsed.pathname === `/packages/${encodeURIComponent(packageId)}`) {
      requests.push(url)
      const packageEvents = events.filter((event) => {
        return event.eventType === 'release.published'
          ? event.release.id === packageId
          : event.package === packageId
      })
      const lastPackageEvent = packageEvents.at(-1)

      if (!lastPackageEvent) {
        return Promise.resolve(new Response('not found', { status: 404 }))
      }

      const headers = new Headers(options.stateResponseInit?.headers)
      if (options.stateCacheControl !== undefined) {
        if (options.stateCacheControl === null) {
          headers.delete('cache-control')
        } else {
          headers.set('cache-control', options.stateCacheControl)
        }
      } else if (!headers.has('cache-control')) {
        headers.set('cache-control', 'no-cache')
      }
      if (!headers.has('etag')) {
        headers.set('etag', options.stateEtag ?? `W/"${lastPackageEvent.id}"`)
      }

      return Promise.resolve(
        jsonResponse(
          options.state ?? replayPackageState(packageEvents, packageId),
          {
            ...options.stateResponseInit,
            headers,
          },
        ),
      )
    }

    return eventLogFetch(input, init)
  }

  return Object.assign(fetchImpl, { headRequests, requests })
}

function jsonResponse(
  value: unknown,
  init?: ResponseInit & { omitContentLength?: boolean },
): Response {
  const body = JSON.stringify(value)
  const headers = new Headers(init?.headers)
  if (!headers.has('content-length') && !init?.omitContentLength) {
    headers.set('content-length', String(bytes(body).byteLength))
  }
  if (!headers.has('content-type')) {
    headers.set('content-type', 'application/json; charset=UTF-8')
  }

  return new Response(body, {
    ...init,
    headers,
  })
}

function canonicalJsonResponse(value: unknown, init?: ResponseInit): Response {
  const body = `${canonicalJson(value)}\n`
  const headers = new Headers(init?.headers)
  if (!headers.has('cache-control')) {
    headers.set('cache-control', 'public, max-age=31536000, immutable')
  }
  if (!headers.has('content-length')) {
    headers.set('content-length', String(bytes(body).byteLength))
  }
  if (!headers.has('content-type')) {
    headers.set('content-type', 'application/json; charset=utf-8')
  }

  return new Response(body, {
    ...init,
    headers,
  })
}

function jsonFetch(value: unknown): typeof fetch {
  return () => {
    return Promise.resolve(canonicalJsonResponse(value))
  }
}

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value)
}
