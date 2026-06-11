import { Hono, type Context } from 'hono'
import { decodeRequestComponent, requiredParam } from '../request.ts'
import { errorResponse, matchesIfNoneMatch } from '../responses.ts'
import {
  createLocalNpmVersionManifest,
  localNpmPackageId,
  npmDistTagsEtag,
  npmVersionManifestEtag,
  readLocalNpmPackageProjection,
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
      upstream,
      encodedNpmPackageName(context.req.param('name')),
    )
  })

  app.on('HEAD', '/:name/-/:file', (context) => {
    return serveNpmTarball(
      context,
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
    )
  })

  app.get('/:encoded', (context) => {
    return serveNpmPackument(
      context,
      adapters,
      upstream,
      encodedNpmPackageName(context.req.param('encoded')),
    )
  })

  app.on('HEAD', '/:encoded', (context) => {
    return serveNpmPackument(
      context,
      adapters,
      upstream,
      encodedNpmPackageName(context.req.param('encoded')),
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
    const channels = await adapters.database.getPackageChannels(packageId)
    const taggedVersion = channels[tagOrVersion]
    const version = taggedVersion ?? tagOrVersion
    const release = await adapters.database.getRelease(packageId, version)

    if (release) {
      const cacheControl =
        taggedVersion === undefined
          ? 'public, max-age=31536000, immutable'
          : 'no-cache'
      return serveNpmProjectionJson(
        context,
        createLocalNpmVersionManifest(new URL(context.req.url), packageId, {
          manifest: release.manifest,
        }),
        npmVersionManifestEtag(release.event.id),
        {
          cacheControl,
          ...(taggedVersion === undefined
            ? { lastModified: release.manifest.createdAt }
            : {}),
        },
      )
    }

    if (
      Object.keys(channels).length > 0 ||
      (await adapters.database.hasPackage(packageId))
    ) {
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
): Promise<Response> {
  const packageId = localNpmPackageId(packageName)
  const releases = packageId
    ? await adapters.database.listPackageReleases(packageId)
    : []

  if (packageId && releases.length > 0) {
    const projection = await readLocalNpmPackageProjection(
      adapters,
      packageId,
      releases,
      new URL(context.req.url),
    )
    return serveNpmProjectionJson(
      context,
      projection.packument,
      projection.etag,
      {
        lastModified: projection.modifiedAt,
      },
    )
  }

  return upstream.packument(context, packageName)
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

    return new Response(null, {
      headers: conditionalHeaders,
      status: 304,
    })
  }

  return context.req.method === 'HEAD'
    ? new Response(null, { headers })
    : new Response(bytes, { headers })
}

interface NpmProjectionJsonOptions {
  cacheControl?: string
  lastModified?: string
}

function httpDate(timestamp: string): string {
  const time = Date.parse(timestamp)

  if (!Number.isFinite(time)) {
    throw new TypeError('npm projection timestamp must be valid')
  }

  return new Date(time).toUTCString()
}

function matchesIfModifiedSince(
  header: string | undefined,
  lastModified: string | undefined,
): boolean {
  if (!header || !lastModified) {
    return false
  }

  const since = Date.parse(header)
  const modified = Date.parse(lastModified)

  if (!Number.isFinite(since) || !Number.isFinite(modified)) {
    return false
  }

  return modified <= since
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

function serveNpmTarball(
  context: Context,
  upstream: NpmUpstreamFallback,
  packageName: string,
): Response {
  const file = requiredParam(context.req.param('file'), 'file')

  return redirectToTarball(upstream.tarballUrl(packageName, file))
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
