import { createDefaultPublishArtifactProcessor } from './artifacts/app.ts'
import {
  createCoreRegistryApp,
  type CoreRegistryAuditSink,
  type PublishUploadLimits,
} from './core/app.ts'
import { coreRegistryKnownErrors } from './core/errors.ts'
import { domainBindingFetchForRequest } from './dev/domain-binding.ts'
import { mountDevLocalhostRoutes } from './dev/mount.ts'
import {
  createNpmProjectionApp,
  type NpmRegistryRouteOptions,
} from './npm/projection-app.ts'
import { requestKnownErrors } from './request.ts'
import {
  createStorageReadinessCheck,
  type StorageReadinessCheckOptions,
} from './storage/readiness.ts'
import {
  createDeploymentStatisticsRead,
  createTransportApp,
  createTransportRoutes,
  type DeploymentStatisticsReadOptions,
  type RequestLogSink,
  type RequestSizeLimitOptions,
} from './transport/app.ts'
import { trustKnownErrors } from './trust/errors.ts'
import { createTrustServices } from './trust/services.ts'
import type { RegistryAdapters } from '@regesta/core'
import type { Hono } from 'hono'

export type { DeploymentStatisticsReadOptions } from './transport/app.ts'

export type NpmUpstreamOptions = Pick<
  NpmRegistryRouteOptions,
  'upstreamTimeoutMs'
>

export interface RegestaAppOptions {
  auditLog?: CoreRegistryAuditSink
  deploymentStatistics?: DeploymentStatisticsReadOptions
  npmUpstream?: NpmUpstreamOptions
  npmUpstreamFetch?: typeof fetch
  publishUploadLimits?: PublishUploadLimits
  requestLog?: RequestLogSink
  readiness?: StorageReadinessCheckOptions
  requestSizeLimit?: RequestSizeLimitOptions
}

export function createRegestaApp(
  adapters: RegistryAdapters,
  options: RegestaAppOptions = {},
): Hono {
  const processPublishArtifacts = createDefaultPublishArtifactProcessor()
  const app = createTransportApp({
    knownErrors: [
      ...requestKnownErrors,
      ...trustKnownErrors,
      ...coreRegistryKnownErrors,
    ],
    requestLog: options.requestLog,
    requestSizeLimit: options.requestSizeLimit,
  })

  app.route(
    '/root',
    createTransportRoutes({
      readiness: createStorageReadinessCheck(adapters, options.readiness),
      statistics: createDeploymentStatisticsRead(
        adapters.database,
        options.deploymentStatistics,
      ),
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
    createNpmProjectionApp(adapters, {
      upstreamFetch: options.npmUpstreamFetch,
      upstreamTimeoutMs: options.npmUpstream?.upstreamTimeoutMs,
    }),
  )
  mountDevLocalhostRoutes(app)

  return app
}
