import {
  createNpmPackument,
  npmInstallArtifact,
  tarballFileName,
} from '@regesta/npm'
import {
  parsePackageId,
  type PackageId,
  type RegistryEvent,
} from '@regesta/protocol'
import { Hono, type Context } from 'hono'
import { decodeRequestComponent, requiredParam } from './request.ts'
import type { RegistryAdapters } from '@regesta/adapters'

export function createNpmRegistryRoutes(adapters: RegistryAdapters): Hono {
  const app = new Hono()

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

  app.get('/:name/-/:file', (context) => {
    return serveNpmTarball(
      context,
      adapters,
      encodedNpmPackageName(context.req.param('name')),
    )
  })

  app.get('/:scope/:name', (context) => {
    return serveNpmPackument(
      context,
      adapters,
      scopedNpmPackageName(
        context.req.param('scope'),
        context.req.param('name'),
      ),
    )
  })

  app.get('/:encoded', (context) => {
    return serveNpmPackument(
      context,
      adapters,
      encodedNpmPackageName(context.req.param('encoded')),
    )
  })

  return app
}

async function serveNpmPackument(
  context: Context,
  adapters: RegistryAdapters,
  packageName: string,
): Promise<Response> {
  const packageId = localNpmPackageId(packageName)
  const releases = packageId
    ? await adapters.database.listPackageReleases(packageId)
    : []

  if (packageId && releases.length > 0) {
    return context.json(
      createNpmPackument(
        packageId,
        releases,
        new URL(context.req.url).origin,
        await adapters.database.getPackageChannels(packageId),
        await npmPackageModifiedAt(adapters, packageId, releases),
      ),
    )
  }

  return fetchUpstreamNpmPackument(context, packageName)
}

async function fetchUpstreamNpmPackument(
  context: Context,
  packageName: string,
): Promise<Response> {
  let response: Response

  try {
    response = await fetch(upstreamNpmPackumentUrl(packageName), {
      headers: {
        accept: context.req.header('accept') ?? 'application/json',
      },
    })
  } catch {
    return context.json({ error: 'Upstream npm registry unavailable' }, 502)
  }

  const headers = new Headers()

  copyHeader(response.headers, headers, 'content-type')
  copyHeader(response.headers, headers, 'etag')
  copyHeader(response.headers, headers, 'last-modified')

  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  })
}

function upstreamNpmPackumentUrl(packageName: string): string {
  return `https://registry.npmjs.org/${encodeURIComponent(packageName)}`
}

function copyHeader(source: Headers, target: Headers, name: string): void {
  const value = source.get(name)

  if (value) {
    target.set(name, value)
  }
}

async function serveNpmTarball(
  context: Context,
  adapters: RegistryAdapters,
  packageName: string,
): Promise<Response> {
  const packageId = localNpmPackageId(packageName)

  if (!packageId) {
    return context.json({ error: 'Tarball not found' }, 404)
  }

  const version = versionFromTarballFile(
    requiredParam(context.req.param('file'), 'file'),
    packageId,
  )

  if (!version) {
    return context.json({ error: 'Invalid tarball path' }, 404)
  }

  const release = await adapters.database.getRelease(packageId, version)
  const digest = release
    ? npmInstallArtifact(release.manifest).digest
    : undefined
  const object = digest ? await adapters.objects.get(digest) : undefined

  if (!object) {
    return context.json({ error: 'Tarball not found' }, 404)
  }

  return new Response(object.bytes, {
    headers: {
      'content-length': String(object.descriptor.size),
      'content-type': 'application/octet-stream',
    },
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
    return parsePackageId(`npm:${packageName}`).id
  } catch {
    return undefined
  }
}

async function npmPackageModifiedAt(
  adapters: RegistryAdapters,
  packageId: PackageId,
  releases: Array<{ manifest: { createdAt: string } }>,
): Promise<string> {
  const releaseTimestamps = releases.map(
    (release) => release.manifest.createdAt,
  )
  const eventTimestamps = (await adapters.database.getEventLog())
    .filter((event) => eventPackageId(event) === packageId)
    .map((event) => event.timestamp)

  return [...releaseTimestamps, ...eventTimestamps].toSorted().at(-1) ?? ''
}

function eventPackageId(event: RegistryEvent): PackageId {
  switch (event.eventType) {
    case 'release.published':
      return event.release.id
    case 'channel.deleted':
    case 'channel.updated':
      return event.package
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
