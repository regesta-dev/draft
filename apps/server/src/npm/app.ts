import { replayPackageState } from '@regesta/core'
import {
  createNpmPackument,
  npmInstallArtifact,
  npmPackageIdFromName,
  tarballFileName,
} from '@regesta/npm'
import {
  sha256,
  type PackageId,
  type RegistryEvent,
  type ReleaseManifest,
  type Sha256Digest,
} from '@regesta/protocol'
import { Hono, type Context } from 'hono'
import { decodeRequestComponent, requiredParam } from '../request.ts'
import { errorResponse, matchesIfNoneMatch } from '../responses.ts'

export interface NpmRegistryReader {
  database: {
    getRelease: (
      packageId: PackageId,
      version: string,
    ) => Promise<
      { event: RegistryEvent; manifest: ReleaseManifest } | undefined
    >
    listPackageReleases: (
      packageId: PackageId,
    ) => Promise<Array<{ event: RegistryEvent; manifest: ReleaseManifest }>>
    listPackageEvents: (packageId: PackageId) => Promise<RegistryEvent[]>
  }
}

export interface NpmRegistryRouteOptions {
  upstreamFetch?: typeof fetch
}

export function createNpmRegistryRoutes(
  adapters: NpmRegistryReader,
  options: NpmRegistryRouteOptions = {},
): Hono {
  const app = new Hono()
  const upstreamFetch = options.upstreamFetch ?? fetch

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
      adapters,
      scopedNpmPackageName(
        context.req.param('scope'),
        context.req.param('name'),
      ),
    )
  })

  app.on('HEAD', '/:scope/:name/-/:file', (context) => {
    return serveNpmTarball(
      context,
      adapters,
      scopedNpmPackageName(
        context.req.param('scope'),
        context.req.param('name'),
      ),
    )
  })

  app.get('/:name/-/:file', (context) => {
    return serveNpmTarball(
      context,
      adapters,
      encodedNpmPackageName(context.req.param('name')),
    )
  })

  app.on('HEAD', '/:name/-/:file', (context) => {
    return serveNpmTarball(
      context,
      adapters,
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

  return app
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

  return fetchUpstreamNpm(
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
    const packument = createNpmPackument(
      packageId,
      releases,
      new URL(context.req.url).origin,
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

  return fetchUpstreamNpmJsonWithTarballRedirects(
    context,
    upstreamFetch,
    packageName,
    upstreamNpmPackageManifestUrl(packageName, tagOrVersion),
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
      createNpmPackument(
        packageId,
        releases,
        new URL(context.req.url).origin,
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
  return fetchUpstreamNpmJsonWithTarballRedirects(
    context,
    upstreamFetch,
    packageName,
    upstreamNpmPackumentUrl(packageName),
  )
}

async function fetchUpstreamNpm(
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
      headers: requestHeaders,
      method: context.req.method === 'HEAD' ? 'HEAD' : 'GET',
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

  return upstreamNpmResponse(context, response)
}

async function fetchUpstreamNpmJsonWithTarballRedirects(
  context: Context,
  upstreamFetch: typeof fetch,
  packageName: string,
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

    response = await upstreamFetch(url, {
      headers: requestHeaders,
      method: context.req.method === 'HEAD' ? 'HEAD' : 'GET',
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

  if (context.req.method === 'HEAD' || response.status !== 200) {
    return upstreamNpmResponse(context, response, false)
  }

  const text = await response.text()
  let body: unknown

  try {
    body = JSON.parse(text)
  } catch {
    return upstreamNpmTextResponse(context, response, text, false)
  }

  return serveTransformedUpstreamNpmJson(
    context,
    rewriteNpmTarballUrls(body, packageName, new URL(context.req.url).origin),
    response,
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

function upstreamNpmTextResponse(
  context: Context,
  response: Response,
  text: string,
  copyEtag = true,
): Response {
  const bytes = new TextEncoder().encode(text)
  const headers = upstreamNpmResponseHeaders(response, copyEtag)
  headers.set('content-length', String(bytes.byteLength))

  return new Response(context.req.method === 'HEAD' ? null : bytes, {
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

function serveTransformedUpstreamNpmJson(
  context: Context,
  body: unknown,
  upstreamResponse: Response,
): Response {
  const bytes = new TextEncoder().encode(JSON.stringify(body))
  const etag = `W/"regesta.npm-fallback:${sha256(bytes).slice(
    'sha256:'.length,
  )}"`
  const headers = upstreamNpmResponseHeaders(upstreamResponse, false)
  headers.set('content-length', String(bytes.byteLength))
  headers.set('content-type', 'application/json; charset=UTF-8')
  headers.set('etag', etag)

  if (matchesIfNoneMatch(context.req.header('if-none-match'), etag)) {
    headers.delete('content-length')

    return new Response(null, {
      headers,
      status: 304,
    })
  }

  return new Response(bytes, {
    headers,
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
  })
}

function versionManifestEtag(releaseEventId: string): string {
  return `W/"regesta.npm-version:${releaseEventId}"`
}

async function serveNpmTarball(
  context: Context,
  adapters: NpmRegistryReader,
  packageName: string,
): Promise<Response> {
  const file = requiredParam(context.req.param('file'), 'file')
  const packageId = localNpmPackageId(packageName)

  if (!packageId) {
    return redirectToTarball(upstreamNpmTarballUrl(packageName, file))
  }

  const releases = await adapters.database.listPackageReleases(packageId)
  if (releases.length === 0) {
    return redirectToTarball(upstreamNpmTarballUrl(packageName, file))
  }

  const version = versionFromTarballFile(file, packageId)

  if (!version) {
    return context.json(
      errorResponse('invalid_tarball_path', 'Invalid tarball path'),
      404,
    )
  }

  const release = await adapters.database.getRelease(packageId, version)
  if (!release) {
    return context.json(
      errorResponse('tarball_not_found', 'Tarball not found'),
      404,
    )
  }

  const digest = npmInstallArtifact(release.manifest).digest
  return redirectToTarball(coreObjectUrl(context, digest))
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

function coreObjectUrl(context: Context, digest: Sha256Digest): string {
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

function rewriteNpmTarballUrls(
  value: unknown,
  packageName: string,
  registryBaseUrl: string,
): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => {
      return rewriteNpmTarballUrls(item, packageName, registryBaseUrl)
    })
  }

  if (!isRecord(value)) {
    return value
  }

  const result: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    result[key] = rewriteNpmTarballUrls(item, packageName, registryBaseUrl)
  }

  if (isRecord(result.dist) && typeof result.dist.tarball === 'string') {
    const tarballFile = npmTarballFileFromUrl(result.dist.tarball)
    if (tarballFile) {
      result.dist = {
        ...result.dist,
        tarball: npmProjectionTarballUrl(
          packageName,
          tarballFile,
          registryBaseUrl,
        ),
      }
    }
  }

  return result
}

function npmTarballFileFromUrl(value: string): string | undefined {
  const marker = '/-/'
  let path = value

  try {
    path = new URL(value).pathname
  } catch {
    // npm packuments normally use absolute tarball URLs, but custom upstream
    // registries may return relative URLs with the same path shape.
  }

  const markerIndex = path.lastIndexOf(marker)
  if (markerIndex === -1) {
    return undefined
  }

  const encodedFile = path.slice(markerIndex + marker.length)
  if (!encodedFile || encodedFile.includes('/')) {
    return undefined
  }

  return decodeRequestComponent(encodedFile)
}

function npmProjectionTarballUrl(
  packageName: string,
  file: string,
  registryBaseUrl: string,
): string {
  const baseUrl = registryBaseUrl.endsWith('/')
    ? registryBaseUrl.slice(0, -1)
    : registryBaseUrl

  return `${baseUrl}/${packageName}/-/${encodeURIComponent(file)}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
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

function versionFromTarballFile(
  file: string,
  packageId: PackageId,
): string | undefined {
  const prefix = tarballFileName(packageId, '')
  const packageName = prefix.slice(0, -'.tgz'.length)

  if (!file.startsWith(packageName) || !file.endsWith('.tgz')) {
    return undefined
  }

  return file.slice(packageName.length, -'.tgz'.length)
}
