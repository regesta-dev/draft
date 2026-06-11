import process from 'node:process'
import {
  ObjectCursorNotFoundError,
  PackageChannelConflictError,
  RegistryEventAlreadyExistsError,
  RegistryEventCursorNotFoundError,
  ReleaseAlreadyExistsError,
  ReleaseNotFoundError,
  WriteAuthorizationReplayError,
  type RegistryAdapters,
} from '@regesta/core'
import { Hono } from 'hono'
import { processNpmArtifacts } from './artifacts/npm.ts'
import { createPublishArtifactProcessor } from './artifacts/process.ts'
import {
  createCoreRegistryApp,
  type CoreRegistryAuditSink,
  type PublishUploadLimits,
} from './core/app.ts'
import { domainBindingFetchForRequest } from './dev/domain-binding.ts'
import { createNpmRegistryRoutes, type NpmRegistryReader } from './npm/app.ts'
import { RequestValidationError } from './request.ts'
import { createStorageReadinessCheck } from './storage/readiness.ts'
import { createTransportRoutes, type StatisticsRead } from './transport/app.ts'
import { createCorsMiddleware } from './transport/cors.ts'
import { createTransportErrorBoundary } from './transport/errors.ts'
import {
  createRequestIdMiddleware,
  createRequestLogger,
  type RequestLogSink,
} from './transport/logging.ts'
import { createPathNormalizationMiddleware } from './transport/path.ts'
import {
  createRequestSizeLimitMiddleware,
  type RequestSizeLimitOptions,
} from './transport/request-size.ts'
import { registryRoutePath } from './transport/routing.ts'
import { isWriteAuthorizationError } from './trust/errors.ts'
import { createTrustServices } from './trust/services.ts'

const deploymentStatisticsCacheTtlMs = 10_000

export interface RegestaAppOptions {
  auditLog?: CoreRegistryAuditSink
  npmUpstreamFetch?: typeof fetch
  publishUploadLimits?: PublishUploadLimits
  requestLog?: RequestLogSink
  requestSizeLimit?: RequestSizeLimitOptions
}

export function createRegestaApp(
  adapters: RegistryAdapters,
  options: RegestaAppOptions = {},
): Hono {
  const processPublishArtifacts = createPublishArtifactProcessor([
    processNpmArtifacts,
  ])
  const app = new Hono({
    getPath: (request) => registryRoutePath(request),
  })
  app.use(createRequestIdMiddleware())
  if (options.requestLog) {
    app.use(createRequestLogger(options.requestLog))
  }
  app.use(createPathNormalizationMiddleware())
  app.use(createCorsMiddleware())
  if (options.requestSizeLimit) {
    app.use(createRequestSizeLimitMiddleware(options.requestSizeLimit))
  }

  app.onError(
    createTransportErrorBoundary([
      {
        code: 'request_invalid',
        match: (error) => error instanceof RequestValidationError,
        status: 400,
      },
      {
        code: 'write_authorization_invalid',
        match: isWriteAuthorizationError,
        status: 401,
      },
      {
        code: 'write_authorization_replayed',
        match: (error) => error instanceof WriteAuthorizationReplayError,
        status: 409,
      },
      {
        code: 'registry_event_already_exists',
        match: (error) => error instanceof RegistryEventAlreadyExistsError,
        status: 409,
      },
      {
        code: 'event_cursor_not_found',
        match: (error) => error instanceof RegistryEventCursorNotFoundError,
        status: 404,
      },
      {
        code: 'object_cursor_not_found',
        match: (error) => error instanceof ObjectCursorNotFoundError,
        status: 404,
      },
      {
        code: 'package_channel_conflict',
        match: (error) => error instanceof PackageChannelConflictError,
        status: 409,
      },
      {
        code: 'release_already_exists',
        match: (error) => error instanceof ReleaseAlreadyExistsError,
        status: 409,
      },
      {
        code: 'release_not_found',
        match: (error) => error instanceof ReleaseNotFoundError,
        status: 404,
      },
    ]),
  )

  app.route(
    '/root',
    createTransportRoutes({
      readiness: createStorageReadinessCheck(adapters),
      statistics: createDeploymentStatisticsRead(adapters),
    }),
  )
  app.route(
    '/root',
    createCoreRegistryApp(
      adapters,
      {
        processPublishArtifacts,
        ...createTrustServices({
          domainBindingFetchForRequest,
        }),
      },
      {
        auditLog: options.auditLog,
        publishUploadLimits: options.publishUploadLimits,
      },
    ),
  )
  app.route(
    '/npm',
    createNpmRegistryRoutes(createNpmRegistryReader(adapters), {
      upstreamFetch: options.npmUpstreamFetch,
    }),
  )
  if (import.meta.dev || process.env.NODE_ENV === 'development') {
    const devApp = import('./dev/app.ts').then(({ createDevLocalhostRoutes }) =>
      createDevLocalhostRoutes(),
    )
    app.all('/dev/*', async (context) => (await devApp).fetch(context.req.raw))
  }

  return app
}

function createDeploymentStatisticsRead(
  adapters: RegistryAdapters,
): StatisticsRead {
  let cached:
    | {
        expiresAt: number
        value: Awaited<ReturnType<StatisticsRead>>
      }
    | undefined
  let pending: Promise<Awaited<ReturnType<StatisticsRead>>> | undefined

  return () => {
    const now = Date.now()

    if (cached && cached.expiresAt > now) {
      return cached.value
    }

    pending ??= adapters.database
      .countPackages()
      .then((packages) => {
        const value = { packages }
        cached = {
          expiresAt: Date.now() + deploymentStatisticsCacheTtlMs,
          value,
        }
        return value
      })
      .finally(() => {
        pending = undefined
      })

    return pending
  }
}

function createNpmRegistryReader(
  adapters: RegistryAdapters,
): NpmRegistryReader {
  return {
    database: {
      listPackageEvents: (packageId) => {
        return adapters.database.listPackageEvents(packageId)
      },
      listPackageReleases: (packageId) => {
        return adapters.database.listPackageReleases(packageId)
      },
    },
  }
}
