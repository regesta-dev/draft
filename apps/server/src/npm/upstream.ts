import { errorResponse } from '../responses.ts'
import type { Context } from 'hono'

export interface NpmUpstreamFallbackOptions {
  upstreamFetch?: typeof fetch
  upstreamTimeoutMs?: number
}

export interface NpmUpstreamFallback {
  distTags: (context: Context, packageName: string) => Promise<Response>
  packageManifest: (
    context: Context,
    packageName: string,
    tagOrVersion: string,
  ) => Promise<Response>
  packument: (context: Context, packageName: string) => Promise<Response>
  tarballUrl: (packageName: string, file: string) => string
}

const defaultUpstreamNpmFetchTimeoutMs = 10_000
const defaultUpstreamNpmMetadataAccept = 'application/json'
const upstreamNpmRequestMetadataHeaders = [
  'accept',
  'if-modified-since',
  'if-none-match',
] as const
const upstreamNpmResponseMetadataHeaders = [
  'cache-control',
  'content-type',
  'last-modified',
] as const

export function createNpmUpstreamFallback(
  options: NpmUpstreamFallbackOptions = {},
): NpmUpstreamFallback {
  const upstreamFetch = createBoundedUpstreamNpmFetch(
    options.upstreamFetch ?? fetch,
    options.upstreamTimeoutMs,
  )

  return {
    distTags: (context, packageName) => {
      return fetchUpstreamNpmDistTags(
        context,
        upstreamFetch,
        upstreamNpmDistTagsUrl(packageName),
      )
    },
    packageManifest: (context, packageName, tagOrVersion) => {
      return fetchUpstreamNpmJson(
        context,
        upstreamFetch,
        upstreamNpmPackageManifestUrl(packageName, tagOrVersion),
        isNpmVersionManifestProjection,
      )
    },
    packument: (context, packageName) => {
      return fetchUpstreamNpmJson(
        context,
        upstreamFetch,
        upstreamNpmPackumentUrl(packageName),
        isNpmPackumentProjection,
      )
    },
    tarballUrl: upstreamNpmTarballUrl,
  }
}

function createBoundedUpstreamNpmFetch(
  upstreamFetch: typeof fetch,
  timeoutMs: number | undefined,
): typeof fetch {
  const normalizedTimeoutMs = normalizeUpstreamNpmFetchTimeoutMs(timeoutMs)

  if (normalizedTimeoutMs === 0) {
    return upstreamFetch
  }

  return async (input, init = {}) => {
    const controller = new AbortController()
    const upstreamSignal = init.signal
    let timeout: ReturnType<typeof setTimeout> | undefined

    const abortFromUpstreamSignal = () => {
      controller.abort(upstreamSignal?.reason)
    }

    if (upstreamSignal?.aborted) {
      controller.abort(upstreamSignal.reason)
    } else {
      upstreamSignal?.addEventListener('abort', abortFromUpstreamSignal, {
        once: true,
      })
    }

    try {
      return await Promise.race([
        upstreamFetch(input, {
          ...init,
          signal: controller.signal,
        }),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => {
            const error = new Error('Upstream npm registry request timed out')
            controller.abort(error)
            reject(error)
          }, normalizedTimeoutMs)
        }),
      ])
    } finally {
      if (timeout) {
        clearTimeout(timeout)
      }
      upstreamSignal?.removeEventListener('abort', abortFromUpstreamSignal)
    }
  }
}

function normalizeUpstreamNpmFetchTimeoutMs(
  timeoutMs: number | undefined,
): number {
  const value = timeoutMs ?? defaultUpstreamNpmFetchTimeoutMs

  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(
      'Upstream npm fetch timeout must be a non-negative safe integer',
    )
  }

  return value
}

async function fetchUpstreamNpmDistTags(
  context: Context,
  upstreamFetch: typeof fetch,
  url: string,
): Promise<Response> {
  let response: Response

  try {
    response = await fetchUpstreamNpmMetadata(context, upstreamFetch, url)
  } catch (error) {
    return upstreamNpmFetchFailureResponse(context, url, error)
  }

  if (response.status >= 500) {
    return unavailableUpstreamNpmResponse(context, url, response)
  }

  if (context.req.method === 'HEAD' || response.status !== 200) {
    return upstreamNpmResponse(context, response)
  }

  const bytes = new Uint8Array(await response.arrayBuffer())
  const body = await parseUpstreamNpmJson(context, url, bytes)

  if (!body.ok) {
    return body.response
  }

  if (!isStringRecord(body.value)) {
    return invalidUpstreamNpmMetadataResponse(context, url)
  }

  return serveValidatedUpstreamNpmMetadata(bytes, response)
}

async function fetchUpstreamNpmJson(
  context: Context,
  upstreamFetch: typeof fetch,
  url: string,
  isProjectedMetadata: (value: unknown) => boolean,
): Promise<Response> {
  let response: Response

  try {
    response = await fetchUpstreamNpmMetadata(context, upstreamFetch, url)
  } catch (error) {
    return upstreamNpmFetchFailureResponse(context, url, error)
  }

  if (response.status >= 500) {
    return unavailableUpstreamNpmResponse(context, url, response)
  }

  if (context.req.method === 'HEAD' || response.status !== 200) {
    return upstreamNpmResponse(context, response)
  }

  const bytes = new Uint8Array(await response.arrayBuffer())
  const body = await parseUpstreamNpmJson(context, url, bytes)

  if (!body.ok) {
    return body.response
  }

  if (!isProjectedMetadata(body.value)) {
    return invalidUpstreamNpmMetadataResponse(context, url)
  }

  return serveValidatedUpstreamNpmMetadata(bytes, response)
}

function fetchUpstreamNpmMetadata(
  context: Context,
  upstreamFetch: typeof fetch,
  url: string,
): Promise<Response> {
  return upstreamFetch(url, {
    credentials: 'omit',
    headers: upstreamNpmRequestHeaders(context.req.raw.headers),
    method: context.req.method === 'HEAD' ? 'HEAD' : 'GET',
    redirect: 'error',
  })
}

function upstreamNpmRequestHeaders(inputHeaders: Headers): Headers {
  const headers = new Headers()
  copyHeaders(inputHeaders, headers, upstreamNpmRequestMetadataHeaders)

  if (!headers.has('accept')) {
    headers.set('accept', defaultUpstreamNpmMetadataAccept)
  }

  return headers
}

function parseUpstreamNpmJson(
  context: Context,
  url: string,
  bytes: Uint8Array,
):
  | {
      ok: true
      value: unknown
    }
  | {
      ok: false
      response: Response
    } {
  const text = new TextDecoder().decode(bytes)

  try {
    return {
      ok: true,
      value: JSON.parse(text),
    }
  } catch (error) {
    return {
      ok: false,
      response: invalidUpstreamNpmJsonResponse(context, url, error),
    }
  }
}

function upstreamNpmFetchFailureResponse(
  context: Context,
  url: string,
  error: unknown,
): Response {
  const id = requestId(context)

  console.error('Upstream npm registry request failed', {
    error,
    kind: 'regesta.npm-upstream-failure',
    ...(id ? { requestId: id } : {}),
    url,
  })
  return context.json(
    errorResponse(
      'upstream_npm_registry_unavailable',
      'Upstream npm registry unavailable',
    ),
    502,
  )
}

function invalidUpstreamNpmJsonResponse(
  context: Context,
  url: string,
  error: unknown,
): Response {
  const id = requestId(context)

  console.error('Upstream npm registry response was not valid JSON', {
    error,
    kind: 'regesta.npm-upstream-invalid-json',
    ...(id ? { requestId: id } : {}),
    url,
  })

  return context.json(
    errorResponse(
      'upstream_npm_registry_unavailable',
      'Upstream npm registry unavailable',
    ),
    502,
  )
}

function unavailableUpstreamNpmResponse(
  context: Context,
  url: string,
  response: Response,
): Response {
  const id = requestId(context)

  console.error('Upstream npm registry returned an unavailable response', {
    kind: 'regesta.npm-upstream-unavailable',
    ...(id ? { requestId: id } : {}),
    status: response.status,
    statusText: response.statusText,
    url,
  })

  return context.json(
    errorResponse(
      'upstream_npm_registry_unavailable',
      'Upstream npm registry unavailable',
    ),
    502,
  )
}

function invalidUpstreamNpmMetadataResponse(
  context: Context,
  url: string,
): Response {
  const id = requestId(context)

  console.error(
    'Upstream npm registry response did not match projection shape',
    {
      kind: 'regesta.npm-upstream-invalid-metadata',
      ...(id ? { requestId: id } : {}),
      url,
    },
  )

  return context.json(
    errorResponse(
      'upstream_npm_registry_unavailable',
      'Upstream npm registry unavailable',
    ),
    502,
  )
}

function upstreamNpmPackumentUrl(packageName: string): string {
  return `https://registry.npmjs.org/${encodeURIComponent(packageName)}`
}

function upstreamNpmPackageManifestUrl(
  packageName: string,
  tagOrVersion: string,
): string {
  return `${upstreamNpmPackumentUrl(packageName)}/${encodeURIComponent(
    tagOrVersion,
  )}`
}

function upstreamNpmDistTagsUrl(packageName: string): string {
  return `https://registry.npmjs.org/-/package/${encodeURIComponent(
    packageName,
  )}/dist-tags`
}

function upstreamNpmTarballUrl(packageName: string, file: string): string {
  return `${upstreamNpmPackumentUrl(packageName)}/-/${encodeURIComponent(file)}`
}

function copyHeader(source: Headers, target: Headers, name: string): void {
  const value = source.get(name)

  if (value) {
    target.set(name, value)
  }
}

function upstreamNpmResponse(
  context: Context,
  response: Response,
  copyEtag = true,
): Response {
  const headers = upstreamNpmResponseHeaders(response, copyEtag)

  return new Response(
    context.req.method === 'HEAD' || response.status === 304
      ? null
      : response.body,
    {
      headers,
      status: response.status,
      statusText: response.statusText,
    },
  )
}

function upstreamNpmResponseHeaders(
  response: Response,
  copyEtag: boolean,
): Headers {
  const headers = new Headers()

  copyHeaders(response.headers, headers, upstreamNpmResponseMetadataHeaders)
  if (copyEtag) {
    copyHeader(response.headers, headers, 'etag')
  }

  return headers
}

function copyHeaders(
  source: Headers,
  target: Headers,
  names: readonly string[],
): void {
  for (const name of names) {
    copyHeader(source, target, name)
  }
}

function requestId(context: Context): string | undefined {
  return (
    context.res.headers.get('x-request-id') ??
    context.req.header('x-request-id')
  )
}

function serveValidatedUpstreamNpmMetadata(
  bytes: Uint8Array,
  upstreamResponse: Response,
): Response {
  const headers = upstreamNpmResponseHeaders(upstreamResponse, true)
  headers.set('content-length', String(bytes.byteLength))

  return new Response(bytes, {
    headers,
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    isRecord(value) &&
    Object.values(value).every((item) => {
      return typeof item === 'string'
    })
  )
}

function isNpmPackumentProjection(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.name === 'string' &&
    isStringRecord(value['dist-tags']) &&
    isRecord(value.versions) &&
    Object.values(value.versions).every(isNpmVersionManifestProjection)
  )
}

function isNpmVersionManifestProjection(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.name === 'string' &&
    typeof value.version === 'string' &&
    isRecord(value.dist) &&
    typeof value.dist.tarball === 'string'
  )
}
