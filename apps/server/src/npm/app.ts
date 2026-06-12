import { parsePackageChannels, type PackageId } from '@regesta/protocol'
import { Hono, type Context } from 'hono'
import {
  decodeRequestComponent,
  publicRequestUrl,
  requiredParam,
} from '../request.ts'
import {
  errorResponse,
  httpDate,
  jsonResponse,
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
    const releaseHead = await adapters.database.getPackageReleaseHead(packageId)

    if (releaseHead.releaseCount > 0) {
      const channels = parsePackageChannels(
        await adapters.database.getPackageChannels(packageId),
        'Adapter package channels',
      )
      const etag = npmDistTagsEtag(channels)

      if (context.req.method === 'HEAD') {
        return serveNpmProjectionHead(context, etag)
      }

      return serveNpmProjectionJson(context, channels, etag)
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
    const releaseHead = await adapters.database.getPackageReleaseHead(packageId)

    if (releaseHead.releaseCount === 0) {
      return upstream.packageManifest(context, packageName, tagOrVersion)
    }

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
      const responseOptions: NpmProjectionJsonOptions = {
        cacheControl,
        ...(taggedVersion === undefined
          ? { lastModified: release.manifest.createdAt }
          : {}),
      }
      const etag = npmVersionManifestEtag(release.event.id)
      const conditionalResponse = serveConditionalNpmProjectionJson(
        context,
        etag,
        responseOptions,
      )

      if (conditionalResponse) {
        return conditionalResponse
      }

      if (context.req.method === 'HEAD') {
        return serveNpmProjectionHead(context, etag, responseOptions)
      }

      return serveNpmProjectionJson(
        context,
        createLocalNpmVersionManifest(
          publicRequestUrl(context.req.url, context.req.header('host')),
          packageId,
          {
            manifest: release.manifest,
          },
        ),
        etag,
        responseOptions,
      )
    }

    if (releaseHead.releaseCount > 0) {
      return jsonResponse(
        context.req.method,
        errorResponse('package_version_not_found', 'Package version not found'),
        { status: 404 },
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
    if (context.req.method === 'HEAD') {
      const headResponse = await serveNpmPackumentHead(
        context,
        adapters,
        upstream,
        packageName,
        packageId,
      )

      if (headResponse) {
        return headResponse
      }
    }

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

async function serveNpmPackumentHead(
  context: Context,
  adapters: NpmRegistryReader,
  upstream: NpmUpstreamFallback,
  packageName: string,
  packageId: PackageId,
): Promise<Response | undefined> {
  const releaseHead = await adapters.database.getPackageReleaseHead(packageId)

  if (releaseHead.releaseCount === 0) {
    return upstream.packument(context, packageName)
  }

  const eventHead = await adapters.database.getPackageEventHead(packageId)

  if (
    !eventHead.lastEventId ||
    eventHead.releaseCount === 0 ||
    releaseHead.releaseCount !== eventHead.releaseCount
  ) {
    return undefined
  }

  const etag = npmPackumentEtag(eventHead.lastEventId)

  return serveNpmProjectionHead(context, etag, {
    lastModified: eventHead.modifiedAt,
  })
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

function serveNpmProjectionHead(
  context: Context,
  etag: string,
  options: NpmProjectionJsonOptions = {},
): Response {
  const conditionalResponse = serveConditionalNpmProjectionJson(
    context,
    etag,
    options,
  )

  if (conditionalResponse) {
    return conditionalResponse
  }

  return new Response(null, {
    headers: npmProjectionJsonHeaders(etag, options),
  })
}

function serveNpmProjectionJson(
  context: Context,
  body: unknown,
  etag: string,
  options: NpmProjectionJsonOptions = {},
): Response {
  const conditionalResponse = serveConditionalNpmProjectionJson(
    context,
    etag,
    options,
  )

  if (conditionalResponse) {
    return conditionalResponse
  }

  return jsonResponse(context.req.method, body, {
    headers: npmProjectionJsonHeaders(etag, options),
  })
}

function serveConditionalNpmProjectionJson(
  context: Context,
  etag: string,
  options: NpmProjectionJsonOptions,
): Response | undefined {
  const headers = npmProjectionJsonHeaders(etag, options)

  const ifNoneMatch = context.req.header('if-none-match')
  return matchesIfNoneMatch(ifNoneMatch, etag) ||
    (!ifNoneMatch &&
      matchesIfModifiedSince(
        context.req.header('if-modified-since'),
        headers.get('last-modified') ?? undefined,
      ))
    ? npmProjectionNotModified(headers)
    : undefined
}

function npmProjectionJsonHeaders(
  etag: string,
  options: NpmProjectionJsonOptions,
  contentLength?: number,
): Headers {
  const headers = new Headers({
    'cache-control': options.cacheControl ?? 'no-cache',
    'content-type': 'application/json; charset=UTF-8',
    etag,
  })

  if (contentLength !== undefined) {
    headers.set('content-length', String(contentLength))
  }

  if (options.lastModified) {
    headers.set('last-modified', httpDate(options.lastModified))
  }

  return headers
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
  return npmProjectionJsonHeaders(etag, options)
}

interface NpmProjectionJsonOptions {
  cacheControl?: string
  lastModified?: string
}

function serveNpmUtilityJson(context: Context, body: unknown): Response {
  return jsonResponse(context.req.method, body, {
    headers: {
      'cache-control': 'no-cache',
    },
  })
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
