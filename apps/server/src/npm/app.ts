import { Hono, type Context } from 'hono'
import {
  decodeRequestComponent,
  publicRequestUrl,
  requiredParam,
} from '../request.ts'
import {
  errorResponse,
  httpDate,
  matchesIfModifiedSince,
  matchesIfNoneMatch,
} from '../responses.ts'
import {
  createLocalNpmPackageProjectionCache,
  createLocalNpmVersionManifest,
  localNpmPackageId,
  localNpmTarballObjectUrl,
  npmDistTagsEtag,
  npmPackumentEtag,
  npmVersionManifestEtag,
  readLocalNpmPackageProjection,
  readLocalNpmPackageProjectionHead,
} from './projection.ts'
import {
  createNpmUpstreamFallback,
  type NpmUpstreamFallback,
  type NpmUpstreamFallbackOptions,
} from './upstream.ts'
import type { NpmRegistryReader } from './reader.ts'
import type { PackageId } from '@regesta/protocol'

export type NpmRegistryRouteOptions = NpmUpstreamFallbackOptions

export function createNpmRegistryRoutes(
  adapters: NpmRegistryReader,
  options: NpmRegistryRouteOptions = {},
): Hono {
  const app = new Hono()
  const upstream = createNpmUpstreamFallback(options)
  const projectionCache = createLocalNpmPackageProjectionCache()

  app.get('/-/ping', (context) => {
    return serveNpmUtilityJson(context, { ping: 'pong' })
  })

  app.on('HEAD', '/-/ping', (context) => {
    return serveNpmUtilityJson(context, { ping: 'pong' })
  })

  app.get('/-/package/:scope/:name/dist-tags', (context) => {
    return serveNpmDistTags(
      context,
      adapters,
      upstream,
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
      upstream,
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
      upstream,
      encodedNpmPackageName(context.req.param('encoded')),
    )
  })

  app.on('HEAD', '/-/package/:encoded/dist-tags', (context) => {
    return serveNpmDistTags(
      context,
      adapters,
      upstream,
      encodedNpmPackageName(context.req.param('encoded')),
    )
  })

  app.get('/:scope/:name/-/:file', (context) => {
    return serveNpmTarball(
      context,
      adapters,
      upstream,
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
      upstream,
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
      upstream,
      encodedNpmPackageName(context.req.param('name')),
    )
  })

  app.on('HEAD', '/:name/-/:file', (context) => {
    return serveNpmTarball(
      context,
      adapters,
      upstream,
      encodedNpmPackageName(context.req.param('name')),
    )
  })

  app.get('/:scope/:name/:tagOrVersion', (context) => {
    return serveNpmPackageManifest(
      context,
      adapters,
      upstream,
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
      upstream,
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
        upstream,
        encodedNpmPackageName(scope),
        name,
      )
    }

    return serveNpmPackument(
      context,
      adapters,
      upstream,
      scopedNpmPackageName(scope, name),
      projectionCache,
    )
  })

  app.on('HEAD', '/:scope/:name', (context) => {
    const scope = context.req.param('scope')
    const name = context.req.param('name')

    if (!scope.startsWith('@')) {
      return serveNpmPackageManifest(
        context,
        adapters,
        upstream,
        encodedNpmPackageName(scope),
        name,
      )
    }

    return serveNpmPackument(
      context,
      adapters,
      upstream,
      scopedNpmPackageName(scope, name),
      projectionCache,
    )
  })

  app.get('/:encoded', (context) => {
    return serveNpmPackument(
      context,
      adapters,
      upstream,
      encodedNpmPackageName(context.req.param('encoded')),
      projectionCache,
    )
  })

  app.on('HEAD', '/:encoded', (context) => {
    return serveNpmPackument(
      context,
      adapters,
      upstream,
      encodedNpmPackageName(context.req.param('encoded')),
      projectionCache,
    )
  })

  app.get('/', (context) => {
    return serveNpmUtilityJson(context, {})
  })

  app.on('HEAD', '/', (context) => {
    return serveNpmUtilityJson(context, {})
  })

  return app
}

async function serveNpmDistTags(
  context: Context,
  adapters: NpmRegistryReader,
  upstream: NpmUpstreamFallback,
  packageName: string,
): Promise<Response> {
  const packageId = localNpmPackageId(packageName)

  if (packageId) {
    const channels = await adapters.database.getPackageChannels(packageId)

    if (
      Object.keys(channels).length > 0 ||
      (await adapters.database.hasPackage(packageId))
    ) {
      return serveNpmProjectionJson(
        context,
        channels,
        npmDistTagsEtag(channels),
      )
    }
  }

  return upstream.distTags(context, packageName)
}

async function serveNpmPackageManifest(
  context: Context,
  adapters: NpmRegistryReader,
  upstream: NpmUpstreamFallback,
  packageName: string,
  rawTagOrVersion: string,
): Promise<Response> {
  const tagOrVersion = decodeRequestComponent(rawTagOrVersion)
  const packageId = localNpmPackageId(packageName)

  if (packageId) {
    const taggedVersion = await adapters.database.getPackageChannelVersion(
      packageId,
      tagOrVersion,
    )
    const version = taggedVersion ?? tagOrVersion
    const release = await adapters.database.getRelease(packageId, version)

    if (release) {
      const cacheControl =
        taggedVersion === undefined
          ? 'public, max-age=31536000, immutable'
          : 'no-cache'
      return serveNpmProjectionJson(
        context,
        createLocalNpmVersionManifest(
          publicRequestUrl(context.req.url, context.req.header('host')),
          packageId,
          {
            manifest: release.manifest,
          },
        ),
        npmVersionManifestEtag(release.event.id),
        {
          cacheControl,
          ...(taggedVersion === undefined
            ? { lastModified: release.manifest.createdAt }
            : {}),
        },
      )
    }

    if (await adapters.database.hasPackage(packageId)) {
      return context.json(
        errorResponse('package_version_not_found', 'Package version not found'),
        404,
      )
    }
  }

  return upstream.packageManifest(context, packageName, tagOrVersion)
}

async function serveNpmPackument(
  context: Context,
  adapters: NpmRegistryReader,
  upstream: NpmUpstreamFallback,
  packageName: string,
  projectionCache: ReturnType<typeof createLocalNpmPackageProjectionCache>,
): Promise<Response> {
  const packageId = localNpmPackageId(packageName)

  if (packageId) {
    const conditionalResponse = await serveConditionalNpmPackument(
      context,
      adapters,
      packageId,
    )

    if (conditionalResponse) {
      return conditionalResponse
    }

    const projection = await readLocalNpmPackageProjection(
      adapters,
      packageId,
      publicRequestUrl(context.req.url, context.req.header('host')),
      projectionCache,
    )

    if (projection) {
      return serveNpmProjectionJson(
        context,
        projection.packument,
        projection.etag,
        {
          lastModified: projection.modifiedAt,
        },
      )
    }
  }

  return upstream.packument(context, packageName)
}

async function serveConditionalNpmPackument(
  context: Context,
  adapters: NpmRegistryReader,
  packageId: PackageId,
): Promise<Response | undefined> {
  const ifNoneMatch = context.req.header('if-none-match')
  const ifModifiedSince = context.req.header('if-modified-since')

  if (!ifNoneMatch && !ifModifiedSince) {
    return undefined
  }

  const head = await readLocalNpmPackageProjectionHead(adapters, packageId)

  if (!head) {
    return undefined
  }

  if (!head.lastEventId) {
    return undefined
  }

  const etag = npmPackumentEtag(head.lastEventId)

  if (ifNoneMatch) {
    return matchesIfNoneMatch(ifNoneMatch, etag)
      ? npmProjectionNotModified(etag, {
          lastModified: head.modifiedAt,
        })
      : undefined
  }

  const lastModified = head.modifiedAt ? httpDate(head.modifiedAt) : undefined

  if (!matchesIfModifiedSince(ifModifiedSince, lastModified)) {
    return undefined
  }

  return npmProjectionNotModified(etag, {
    lastModified: head.modifiedAt,
  })
}

function serveNpmProjectionJson(
  context: Context,
  body: unknown,
  etag: string,
  options: NpmProjectionJsonOptions = {},
): Response {
  const bytes = new TextEncoder().encode(JSON.stringify(body))
  const headers: Record<string, string> = {
    'cache-control': options.cacheControl ?? 'no-cache',
    'content-length': String(bytes.byteLength),
    'content-type': 'application/json; charset=UTF-8',
    etag,
  }
  if (options.lastModified) {
    headers['last-modified'] = httpDate(options.lastModified)
  }

  const ifNoneMatch = context.req.header('if-none-match')
  if (
    matchesIfNoneMatch(ifNoneMatch, etag) ||
    (!ifNoneMatch &&
      matchesIfModifiedSince(
        context.req.header('if-modified-since'),
        headers['last-modified'],
      ))
  ) {
    const conditionalHeaders = new Headers(headers)
    conditionalHeaders.delete('content-length')

    return npmProjectionNotModified(conditionalHeaders)
  }

  return context.req.method === 'HEAD'
    ? new Response(null, { headers })
    : new Response(bytes, { headers })
}

function npmProjectionNotModified(
  etagOrHeaders: Headers | string,
  options: NpmProjectionJsonOptions = {},
): Response {
  const headers =
    etagOrHeaders instanceof Headers
      ? etagOrHeaders
      : npmProjectionNotModifiedHeaders(etagOrHeaders, options)

  return new Response(null, {
    headers,
    status: 304,
  })
}

function npmProjectionNotModifiedHeaders(
  etag: string,
  options: NpmProjectionJsonOptions,
): Headers {
  const headers = new Headers({
    'cache-control': options.cacheControl ?? 'no-cache',
    etag,
  })

  if (options.lastModified) {
    headers.set('last-modified', httpDate(options.lastModified))
  }

  return headers
}

interface NpmProjectionJsonOptions {
  cacheControl?: string
  lastModified?: string
}

function serveNpmUtilityJson(context: Context, body: unknown): Response {
  const bytes = new TextEncoder().encode(JSON.stringify(body))
  const headers = {
    'cache-control': 'no-cache',
    'content-length': String(bytes.byteLength),
    'content-type': 'application/json; charset=UTF-8',
  }

  return context.req.method === 'HEAD'
    ? new Response(null, { headers })
    : new Response(bytes, { headers })
}

async function serveNpmTarball(
  context: Context,
  adapters: NpmRegistryReader,
  upstream: NpmUpstreamFallback,
  packageName: string,
): Promise<Response> {
  const file = requiredParam(context.req.param('file'), 'file')
  const packageId = localNpmPackageId(packageName)

  if (packageId) {
    const version = npmTarballVersion(packageName, file)
    const release = version
      ? await adapters.database.getRelease(packageId, version)
      : undefined
    const objectUrl = release
      ? localNpmTarballObjectUrl(
          publicRequestUrl(context.req.url, context.req.header('host')),
          packageId,
          { manifest: release.manifest },
          file,
        )
      : undefined

    if (objectUrl) {
      return redirectToTarball(objectUrl)
    }
  }

  return redirectToTarball(upstream.tarballUrl(packageName, file))
}

function npmTarballVersion(
  packageName: string,
  file: string,
): string | undefined {
  const name = packageName.split('/').at(-1)
  if (!name) {
    return undefined
  }

  const prefix = `${name}-`
  const suffix = '.tgz'
  if (!file.startsWith(prefix) || !file.endsWith(suffix)) {
    return undefined
  }

  const version = file.slice(prefix.length, -suffix.length)
  return version || undefined
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

function scopedNpmPackageName(scope: string, name: string): string {
  return `${scope}/${name}`
}

function encodedNpmPackageName(encoded: string): string {
  return decodeRequestComponent(encoded)
}
