import {
  base64ToBytes,
  createNpmPackument,
  publishRelease,
  tarballFileName,
  verifyRelease,
} from '@regesta/core'
import { parsePackageCoordinate } from '@regesta/protocol'
import { Hono } from 'hono'
import type { RegistryAdapters } from '@regesta/adapters'

interface PublishRequestBody {
  config: unknown
  createdAt?: string
  npmTarballBase64: string
  sourceArchiveBase64: string
}

export function createRegestaApp(adapters: RegistryAdapters): Hono {
  const app = new Hono()

  app.get('/health', (context) => {
    return context.json({ ok: true })
  })

  app.post('/api/v0/publish', async (context) => {
    const body = await context.req.json<PublishRequestBody>()
    const result = await publishRelease(
      {
        config: body.config as never,
        createdAt: body.createdAt,
        npmTarball: base64ToBytes(body.npmTarballBase64),
        sourceArchive: base64ToBytes(body.sourceArchiveBase64),
      },
      adapters,
    )

    return context.json(result, 201)
  })

  app.get('/api/v0/events', async (context) => {
    return context.json({
      events: await adapters.database.getEventLog(),
      schema: 'regesta.event-log.v0',
    })
  })

  app.get('/api/v0/objects/:digest', async (context) => {
    const object = await adapters.objects.get(
      context.req.param('digest') as never,
    )

    if (!object) {
      return context.json({ error: 'Object not found' }, 404)
    }

    return new Response(object.bytes, {
      headers: {
        'content-length': String(object.descriptor.size),
        'content-type': object.descriptor.mediaType,
      },
    })
  })

  app.get('/api/v0/releases/:scope/:name/:version', async (context) => {
    const coordinate = parsePackageCoordinate(
      `@${context.req.param('scope')}/${context.req.param('name')}`,
    ).coordinate
    const release = await adapters.database.getRelease(
      coordinate,
      context.req.param('version'),
    )

    if (!release) {
      return context.json({ error: 'Release not found' }, 404)
    }

    return context.json(release)
  })

  app.get('/api/v0/releases/:scope/:name/:version/verify', async (context) => {
    const coordinate = parsePackageCoordinate(
      `@${context.req.param('scope')}/${context.req.param('name')}`,
    ).coordinate
    const verification = await verifyRelease(
      adapters,
      coordinate,
      context.req.param('version'),
      { registryBaseUrl: new URL(context.req.url).origin },
    )

    return context.json(verification, verification.ok ? 200 : 422)
  })

  app.get('/:scope/:name/-/:file', async (context) => {
    const coordinate = parsePackageCoordinate(
      `${context.req.param('scope')}/${context.req.param('name')}`,
    ).coordinate
    const version = versionFromTarballFile(
      context.req.param('file'),
      coordinate,
    )

    if (!version) {
      return context.json({ error: 'Invalid tarball path' }, 404)
    }

    const release = await adapters.database.getRelease(coordinate, version)
    const digest = release?.manifest.artifacts.npmTarball.digest
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
  })

  app.get('/:encoded', async (context) => {
    const coordinate = parsePackageCoordinate(
      decodeURIComponent(context.req.param('encoded')),
    ).coordinate
    const releases = await adapters.database.listPackageReleases(coordinate)

    if (releases.length === 0) {
      return context.json({ error: 'Package not found' }, 404)
    }

    return context.json(
      createNpmPackument(coordinate, releases, new URL(context.req.url).origin),
    )
  })

  app.get('/:scope/:name', async (context) => {
    const coordinate = parsePackageCoordinate(
      `${context.req.param('scope')}/${context.req.param('name')}`,
    ).coordinate
    const releases = await adapters.database.listPackageReleases(coordinate)

    if (releases.length === 0) {
      return context.json({ error: 'Package not found' }, 404)
    }

    return context.json(
      createNpmPackument(coordinate, releases, new URL(context.req.url).origin),
    )
  })

  return app
}

function versionFromTarballFile(
  file: string,
  coordinate: `@${string}/${string}`,
): string | undefined {
  const prefix = tarballFileName(coordinate, '')
  const packageName = prefix.slice(0, -'.tgz'.length)

  if (!file.startsWith(packageName) || !file.endsWith('.tgz')) {
    return undefined
  }

  return file.slice(packageName.length, -'.tgz'.length)
}
