import { replayPackageState } from '@regesta/core'
import {
  createNpmPackument,
  npmInstallArtifact,
  npmPackageIdFromName,
  type NpmPackument,
} from '@regesta/npm'
import { Hono, type Context } from 'hono'
import { decodeRequestComponent, requiredParam } from '../request.ts'
import { errorResponse, matchesIfNoneMatch } from '../responses.ts'
import type {
  PackageId,
  RegistryEvent,
  ReleaseManifest,
} from '@regesta/protocol'

export interface NpmRegistryReader {
  database: {
    listPackageReleases: (
      packageId: PackageId,
    ) => Promise<Array<{ event: RegistryEvent; manifest: ReleaseManifest }>>
    listPackageEvents: (packageId: PackageId) => Promise<RegistryEvent[]>
  }
}

export interface NpmRegistryRouteOptions {
  upstreamFetch?: typeof fetch
  upstreamTimeoutMs?: number
}

const defaultUpstreamNpmFetchTimeoutMs = 10_000

export function createNpmRegistryRoutes(
  adapters: NpmRegistryReader,
  options: NpmRegistryRouteOptions = {},
): Hono {
  const app = new Hono()
  const upstreamFetch = createBoundedUpstreamNpmFetch(
    options.upstreamFetch ?? fetch,
    options.upstreamTimeoutMs,
  )

  app.get('/-/ping', (context) => {
    return context.json({ ping: 'pong' })
  })

  app.on('HEAD', '/-/ping', () => {
    return new Response(null, {
      headers: {
        'content-type': 'application/json; charset=UTF-8',
      },
    })
  })

  app.get('/-/package/:scope/:name/dist-tags', (context) => {
    return serveNpmDistTags(
      context,
      adapters,
      upstreamFetch,
      scopedNpmPackageName(
        context.req.param('scope'),
        context.req.param('name'),
      ),
    )
  })

  app.on('HEAD', '/-/package/:scope/:name/dist-tags', (context) => {
    return serveNpmDistTags(
      context,
      adapters,
      upstreamFetch,
      scopedNpmPackageName(
        context.req.param('scope'),
        context.req.param('name'),
      ),
    )
  })

  app.get('/-/package/:encoded/dist-tags', (context) => {
    return serveNpmDistTags(
      context,
      adapters,
      upstreamFetch,
      encodedNpmPackageName(context.req.param('encoded')),
    )
  })

  app.on('HEAD', '/-/package/:encoded/dist-tags', (context) => {
    return serveNpmDistTags(
      context,
      adapters,
      upstreamFetch,
      encodedNpmPackageName(context.req.param('encoded')),
    )
  })

  app.get('/:scope/:name/-/:file', (context) => {
    return serveNpmTarball(
      context,
      scopedNpmPackageName(
        context.req.param('scope'),
        context.req.param('name'),
      ),
    )
  })

  app.on('HEAD', '/:scope/:name/-/:file', (context) => {
    return serveNpmTarball(
      context,
      scopedNpmPackageName(
        context.req.param('scope'),
        context.req.param('name'),
      ),
    )
  })

  app.get('/:name/-/:file', (context) => {
    return serveNpmTarball(
      context,
      encodedNpmPackageName(context.req.param('name')),
    )
  })

  app.on('HEAD', '/:name/-/:file', (context) => {
    return serveNpmTarball(
      context,
      encodedNpmPackageName(context.req.param('name')),
    )
  })

  app.get('/:scope/:name/:tagOrVersion', (context) => {
    return serveNpmPackageManifest(
      context,
      adapters,
      upstreamFetch,
      scopedNpmPackageName(
        context.req.param('scope'),
        context.req.param('name'),
      ),
      context.req.param('tagOrVersion'),
    )
  })

  app.on('HEAD', '/:scope/:name/:tagOrVersion', (context) => {
    return serveNpmPackageManifest(
      context,
      adapters,
      upstreamFetch,
      scopedNpmPackageName(
        context.req.param('scope'),
        context.req.param('name'),
      ),
      context.req.param('tagOrVersion'),
    )
  })

  app.get('/:scope/:name', (context) => {
    const scope = context.req.param('scope')
    const name = context.req.param('name')

    if (!scope.startsWith('@')) {
      return serveNpmPackageManifest(
        context,
        adapters,
        upstreamFetch,
        encodedNpmPackageName(scope),
        name,
      )
    }

    return serveNpmPackument(
      context,
      adapters,
      upstreamFetch,
      scopedNpmPackageName(scope, name),
    )
  })

  app.on('HEAD', '/:scope/:name', (context) => {
    const scope = context.req.param('scope')
    const name = context.req.param('name')

    if (!scope.startsWith('@')) {
      return serveNpmPackageManifest(
        context,
        adapters,
        upstreamFetch,
        encodedNpmPackageName(scope),
        name,
      )
    }

    return serveNpmPackument(
      context,
      adapters,
      upstreamFetch,
      scopedNpmPackageName(scope, name),
    )
  })

  app.get('/:encoded', (context) => {
    return serveNpmPackument(
      context,
      adapters,
      upstreamFetch,
      encodedNpmPackageName(context.req.param('encoded')),
    )
  })

  app.on('HEAD', '/:encoded', (context) => {
    return serveNpmPackument(
      context,
      adapters,
      upstreamFetch,
      encodedNpmPackageName(context.req.param('encoded')),
    )
  })

  app.get('/', (context) => {
    return context.json({})
  })

  app.on('HEAD', '/', () => {
    return new Response(null, {
      headers: {
        'content-type': 'application/json; charset=UTF-8',
      },
    })
  })

  return app
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

async function serveNpmDistTags(
  context: Context,
  adapters: NpmRegistryReader,
  upstreamFetch: typeof fetch,
  packageName: string,
): Promise<Response> {
  const packageId = localNpmPackageId(packageName)
  const releases = packageId
    ? await adapters.database.listPackageReleases(packageId)
    : []

  if (packageId && releases.length > 0) {
    const state = await npmPackageProjectionState(adapters, packageId, releases)
    return serveNpmProjectionJson(
      context,
      createNpmPackument(
        packageId,
        releases,
        new URL(context.req.url).origin,
        state.channels,
      )['dist-tags'],
      state.etag,
    )
  }

  return fetchUpstreamNpmDistTags(
    context,
    upstreamFetch,
    upstreamNpmDistTagsUrl(packageName),
  )
}

async function serveNpmPackageManifest(
  context: Context,
  adapters: NpmRegistryReader,
  upstreamFetch: typeof fetch,
  packageName: string,
  rawTagOrVersion: string,
): Promise<Response> {
  const tagOrVersion = decodeRequestComponent(rawTagOrVersion)
  const packageId = localNpmPackageId(packageName)
  const releases = packageId
    ? await adapters.database.listPackageReleases(packageId)
    : []

  if (packageId && releases.length > 0) {
    const state = await npmPackageProjectionState(adapters, packageId, releases)
    const packument = createLocalNpmPackument(
      context,
      packageId,
      releases,
      state.channels,
      state.modifiedAt,
    )
    const taggedVersion = packument['dist-tags'][tagOrVersion]
    const version = taggedVersion ?? tagOrVersion
    const manifest = packument.versions[version]

    if (!manifest) {
      return context.json(
        errorResponse('package_version_not_found', 'Package version not found'),
        404,
      )
    }

    if (taggedVersion) {
      return serveNpmProjectionJson(context, manifest, state.etag)
    }

    const release = releases.find((candidate) => {
      return candidate.manifest.version === version
    })

    if (!release) {
      throw new Error('Release projection is inconsistent')
    }

    return serveNpmProjectionJson(
      context,
      manifest,
      versionManifestEtag(release.event.id),
      'public, max-age=31536000, immutable',
    )
  }

  return fetchUpstreamNpmJson(
    context,
    upstreamFetch,
    upstreamNpmPackageManifestUrl(packageName, tagOrVersion),
    isNpmVersionManifestProjection,
  )
}

async function serveNpmPackument(
  context: Context,
  adapters: NpmRegistryReader,
  upstreamFetch: typeof fetch,
  packageName: string,
): Promise<Response> {
  const packageId = localNpmPackageId(packageName)
  const releases = packageId
    ? await adapters.database.listPackageReleases(packageId)
    : []

  if (packageId && releases.length > 0) {
    const state = await npmPackageProjectionState(adapters, packageId, releases)
    return serveNpmProjectionJson(
      context,
      createLocalNpmPackument(
        context,
        packageId,
        releases,
        state.channels,
        state.modifiedAt,
      ),
      state.etag,
    )
  }

  return fetchUpstreamNpmPackument(context, upstreamFetch, packageName)
}

function fetchUpstreamNpmPackument(
  context: Context,
  upstreamFetch: typeof fetch,
  packageName: string,
): Promise<Response> {
  return fetchUpstreamNpmJson(
    context,
    upstreamFetch,
    upstreamNpmPackumentUrl(packageName),
    isNpmPackumentProjection,
  )
}

async function fetchUpstreamNpmDistTags(
  context: Context,
  upstreamFetch: typeof fetch,
  url: string,
): Promise<Response> {
  let response: Response

  try {
    const requestHeaders = new Headers()
    requestHeaders.set(
      'accept',
      context.req.header('accept') ?? 'application/json',
    )
    copyHeader(context.req.raw.headers, requestHeaders, 'if-modified-since')
    copyHeader(context.req.raw.headers, requestHeaders, 'if-none-match')

    response = await upstreamFetch(url, {
      credentials: 'omit',
      headers: requestHeaders,
      method: context.req.method === 'HEAD' ? 'HEAD' : 'GET',
      redirect: 'error',
    })
  } catch (error) {
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

  if (response.status >= 500) {
    return unavailableUpstreamNpmResponse(context, url, response)
  }

  if (context.req.method === 'HEAD' || response.status !== 200) {
    return upstreamNpmResponse(context, response)
  }

  const bytes = new Uint8Array(await response.arrayBuffer())
  const text = new TextDecoder().decode(bytes)
  let body: unknown

  try {
    body = JSON.parse(text)
  } catch (error) {
    return invalidUpstreamNpmJsonResponse(context, url, error)
  }

  if (!isStringRecord(body)) {
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
    const requestHeaders = new Headers()
    requestHeaders.set(
      'accept',
      context.req.header('accept') ?? 'application/json',
    )
    copyHeader(context.req.raw.headers, requestHeaders, 'if-modified-since')
    copyHeader(context.req.raw.headers, requestHeaders, 'if-none-match')

    response = await upstreamFetch(url, {
      credentials: 'omit',
      headers: requestHeaders,
      method: context.req.method === 'HEAD' ? 'HEAD' : 'GET',
      redirect: 'error',
    })
  } catch (error) {
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

  if (response.status >= 500) {
    return unavailableUpstreamNpmResponse(context, url, response)
  }

  if (context.req.method === 'HEAD' || response.status !== 200) {
    return upstreamNpmResponse(context, response)
  }

  const bytes = new Uint8Array(await response.arrayBuffer())
  const text = new TextDecoder().decode(bytes)
  let body: unknown

  try {
    body = JSON.parse(text)
  } catch (error) {
    return invalidUpstreamNpmJsonResponse(context, url, error)
  }

  if (!isProjectedMetadata(body)) {
    return invalidUpstreamNpmMetadataResponse(context, url)
  }

  return serveValidatedUpstreamNpmMetadata(bytes, response)
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

  return new Response(context.req.method === 'HEAD' ? null : response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  })
}

function upstreamNpmResponseHeaders(
  response: Response,
  copyEtag: boolean,
): Headers {
  const headers = new Headers()

  copyHeader(response.headers, headers, 'cache-control')
  copyHeader(response.headers, headers, 'content-type')
  if (copyEtag) {
    copyHeader(response.headers, headers, 'etag')
  }
  copyHeader(response.headers, headers, 'last-modified')

  return headers
}

function requestId(context: Context): string | undefined {
  return (
    context.res.headers.get('x-request-id') ??
    context.req.header('x-request-id')
  )
}

function serveNpmProjectionJson(
  context: Context,
  body: unknown,
  etag: string,
  cacheControl = 'no-cache',
): Response {
  const bytes = new TextEncoder().encode(JSON.stringify(body))
  const headers = {
    'cache-control': cacheControl,
    'content-length': String(bytes.byteLength),
    'content-type': 'application/json; charset=UTF-8',
    etag,
  }

  if (matchesIfNoneMatch(context.req.header('if-none-match'), etag)) {
    const conditionalHeaders = new Headers(headers)
    conditionalHeaders.delete('content-length')

    return new Response(null, {
      headers: conditionalHeaders,
      status: 304,
    })
  }

  return context.req.method === 'HEAD'
    ? new Response(null, { headers })
    : new Response(bytes, { headers })
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

function versionManifestEtag(releaseEventId: string): string {
  return `W/"regesta.npm-version:${releaseEventId}"`
}

function serveNpmTarball(context: Context, packageName: string): Response {
  const file = requiredParam(context.req.param('file'), 'file')

  return redirectToTarball(upstreamNpmTarballUrl(packageName, file))
}

function redirectToTarball(location: string): Response {
  return new Response(null, {
    headers: {
      'cache-control': 'no-cache',
      location,
    },
    status: 302,
  })
}

function createLocalNpmPackument(
  context: Context,
  packageId: PackageId,
  releases: Array<{ manifest: ReleaseManifest }>,
  channels: Record<string, string>,
  modifiedAt?: string,
): NpmPackument {
  return rewriteLocalNpmTarballUrls(
    context,
    createNpmPackument(
      packageId,
      releases,
      new URL(context.req.url).origin,
      channels,
      modifiedAt,
    ),
    releases,
  )
}

function rewriteLocalNpmTarballUrls(
  context: Context,
  packument: NpmPackument,
  releases: Array<{ manifest: ReleaseManifest }>,
): NpmPackument {
  const tarballUrls = new Map(
    releases.map((release) => [
      release.manifest.version,
      coreObjectUrl(context, npmInstallArtifact(release.manifest).digest),
    ]),
  )

  return {
    ...packument,
    versions: Object.fromEntries(
      Object.entries(packument.versions).map(([version, manifest]) => {
        const tarball = tarballUrls.get(version)

        return [
          version,
          tarball === undefined
            ? manifest
            : {
                ...manifest,
                dist: {
                  ...manifest.dist,
                  tarball,
                },
              },
        ]
      }),
    ),
  }
}

function coreObjectUrl(context: Context, digest: string): string {
  const url = new URL(context.req.url)
  url.hostname = coreRegistryHostname(url.hostname)
  url.pathname = `/objects/${digest}`
  url.search = ''
  url.hash = ''

  return url.toString()
}

function coreRegistryHostname(hostname: string): string {
  const labels = hostname.split('.')

  if (labels[0] !== 'npm') {
    return hostname
  }

  if (labels.length === 2 && labels[1] === 'localhost') {
    return 'localhost'
  }

  if (labels[1] === 'registry') {
    return labels.slice(1).join('.')
  }

  return ['registry', ...labels.slice(1)].join('.')
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

function scopedNpmPackageName(scope: string, name: string): string {
  return `${scope}/${name}`
}

function encodedNpmPackageName(encoded: string): string {
  return decodeRequestComponent(encoded)
}

function localNpmPackageId(packageName: string): PackageId | undefined {
  try {
    return npmPackageIdFromName(packageName)
  } catch {
    return undefined
  }
}

async function npmPackageProjectionState(
  adapters: NpmRegistryReader,
  packageId: PackageId,
  releases: Array<{ manifest: { createdAt: string } }>,
): Promise<{
  channels: Record<string, string>
  etag: string
  modifiedAt: string
}> {
  const releaseTimestamps = releases.map(
    (release) => release.manifest.createdAt,
  )
  const events = await adapters.database.listPackageEvents(packageId)
  const state = replayPackageState(events, packageId)
  const eventTimestamps = events.map((event) => event.timestamp)
  const lastEventId = events.at(-1)?.id ?? 'empty'

  return {
    channels: state.channels ?? {},
    etag: `W/"regesta.npm-projection:${lastEventId}"`,
    modifiedAt:
      [...releaseTimestamps, ...eventTimestamps].toSorted().at(-1) ?? '',
  }
}
