import { replayPackageState } from '@regesta/core'
import {
  createNpmPackument,
  npmInstallArtifact,
  npmPackageIdFromName,
  tarballFileName,
} from '@regesta/npm'
import { Hono, type Context } from 'hono'
import { assertObjectResponseIntegrity } from '../object-integrity.ts'
import { decodeRequestComponent, requiredParam } from '../request.ts'
import {
  errorResponse,
  immutableBytesResponse,
  immutableDescriptorHeaders,
  immutableDescriptorResponse,
  matchesIfNoneMatch,
  parseSingleByteRange,
} from '../responses.ts'
import type {
  ObjectDescriptor,
  PackageId,
  RegistryEvent,
  ReleaseManifest,
  Sha256Digest,
} from '@regesta/protocol'

interface NpmRegistryReader {
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
  objects: {
    get: (digest: Sha256Digest) => Promise<
      | {
          bytes: Uint8Array
          descriptor: ObjectDescriptor
        }
      | undefined
    >
    getDescriptor: (
      digest: Sha256Digest,
    ) => Promise<ObjectDescriptor | undefined>
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

  return fetchUpstreamNpm(
    context,
    upstreamFetch,
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
  return fetchUpstreamNpm(
    context,
    upstreamFetch,
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

  const headers = new Headers()

  copyHeader(response.headers, headers, 'cache-control')
  copyHeader(response.headers, headers, 'content-type')
  copyHeader(response.headers, headers, 'etag')
  copyHeader(response.headers, headers, 'last-modified')

  return new Response(context.req.method === 'HEAD' ? null : response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  })
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

function copyHeader(source: Headers, target: Headers, name: string): void {
  const value = source.get(name)

  if (value) {
    target.set(name, value)
  }
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

function versionManifestEtag(releaseEventId: string): string {
  return `W/"regesta.npm-version:${releaseEventId}"`
}

async function serveNpmTarball(
  context: Context,
  adapters: NpmRegistryReader,
  packageName: string,
): Promise<Response> {
  const packageId = localNpmPackageId(packageName)

  if (!packageId) {
    return context.json(
      errorResponse('tarball_not_found', 'Tarball not found'),
      404,
    )
  }

  const version = versionFromTarballFile(
    requiredParam(context.req.param('file'), 'file'),
    packageId,
  )

  if (!version) {
    return context.json(
      errorResponse('invalid_tarball_path', 'Invalid tarball path'),
      404,
    )
  }

  const release = await adapters.database.getRelease(packageId, version)
  const digest = release
    ? npmInstallArtifact(release.manifest).digest
    : undefined
  const descriptor = digest
    ? await adapters.objects.getDescriptor(digest)
    : undefined

  if (!descriptor) {
    return context.json(
      errorResponse('tarball_not_found', 'Tarball not found'),
      404,
    )
  }

  const etag = `"${descriptor.digest}"`
  const headers = tarballDescriptorHeaders(descriptor, etag)

  if (matchesIfNoneMatch(context.req.header('if-none-match'), etag)) {
    headers.delete('content-length')

    return new Response(null, {
      headers,
      status: 304,
    })
  }

  if (context.req.method === 'HEAD') {
    return tarballDescriptorResponse(
      descriptor,
      etag,
      context.req.header('range'),
    )
  }

  const rangeHeader = context.req.header('range')
  if (rangeHeader && !parseSingleByteRange(rangeHeader, descriptor.size)) {
    return tarballDescriptorResponse(descriptor, etag, rangeHeader)
  }

  const object = await adapters.objects.get(descriptor.digest)

  if (!object) {
    return context.json(
      errorResponse('tarball_not_found', 'Tarball not found'),
      404,
    )
  }

  assertObjectResponseIntegrity({
    actual: object,
    digest: descriptor.digest,
    expected: descriptor,
    label: 'npm tarball object',
  })

  return immutableBytesResponse({
    bytes: object.bytes,
    cacheControl: 'public, max-age=31536000, immutable',
    contentType: object.descriptor.mediaType,
    etag,
    includeBody: context.req.method !== 'HEAD',
    rangeHeader,
  })
}

function tarballDescriptorHeaders(
  descriptor: ObjectDescriptor,
  etag: string,
): Headers {
  return immutableDescriptorHeaders({
    cacheControl: 'public, max-age=31536000, immutable',
    contentLength: descriptor.size,
    contentType: descriptor.mediaType,
    etag,
  })
}

function tarballDescriptorResponse(
  descriptor: ObjectDescriptor,
  etag: string,
  rangeHeader: string | undefined,
): Response {
  return immutableDescriptorResponse({
    cacheControl: 'public, max-age=31536000, immutable',
    contentLength: descriptor.size,
    contentType: descriptor.mediaType,
    etag,
    rangeHeader,
  })
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
