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
import type { PublishArtifactProcessor } from './artifacts/process.ts'
import type { RegistryAdapters } from '@regesta/core'
import type { Hono } from 'hono'

export { createPublishArtifactProcessor } from './artifacts/process.ts'
export type {
  ProcessPublishArtifactsInput,
  ProcessPublishArtifactsOutput,
  PublishArtifactForProcessing,
  PublishArtifactProcessor,
} from './artifacts/process.ts'
export type { DeploymentStatisticsReadOptions } from './transport/app.ts'

export type NpmUpstreamOptions = Pick<
  NpmRegistryRouteOptions,
  'upstreamFallback' | 'upstreamTimeoutMs'
>

export interface RegestaAppOptions {
  auditLog?: CoreRegistryAuditSink
  deploymentStatistics?: DeploymentStatisticsReadOptions
  npmProjection?: boolean
  npmUpstream?: NpmUpstreamOptions
  npmUpstreamFetch?: typeof fetch
  processPublishArtifacts?: PublishArtifactProcessor
  publishUploadLimits?: PublishUploadLimits
  requestLog?: RequestLogSink
  readiness?: StorageReadinessCheckOptions
  requestSizeLimit?: RequestSizeLimitOptions
  trust?: TrustOptions
}

export interface TrustOptions {
  domainBindingFetchTimeoutMs?: number
}

export function createRegestaApp(
  adapters: RegistryAdapters,
  options: RegestaAppOptions = {},
): Hono {
  const processPublishArtifacts =
    options.processPublishArtifacts ?? createDefaultPublishArtifactProcessor()
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
          ...(options.trust?.domainBindingFetchTimeoutMs === undefined
            ? {}
            : {
                domainBindingFetchTimeoutMs:
                  options.trust.domainBindingFetchTimeoutMs,
              }),
        }),
      },
      {
        auditLog: options.auditLog,
        publishUploadLimits: options.publishUploadLimits,
      },
    ),
  )
  if (options.npmProjection !== false) {
    app.route(
      '/npm',
      createNpmProjectionApp(
        {
          database: adapters.database,
        },
        {
          upstreamFallback: options.npmUpstream?.upstreamFallback,
          upstreamFetch: options.npmUpstreamFetch,
          upstreamTimeoutMs: options.npmUpstream?.upstreamTimeoutMs,
        },
      ),
    )
  }
  mountDevLocalhostRoutes(app)

  return app
}
