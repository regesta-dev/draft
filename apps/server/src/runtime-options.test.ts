import { describe, expect, it } from 'vitest'
import {
  runtimeOptionsFromEnv,
  type RuntimeEnvironment,
} from './runtime-options.ts'

describe('runtimeOptionsFromEnv', () => {
  it('returns no optional runtime limits when environment variables are unset', () => {
    expect(runtimeOptionsFromEnv({})).toEqual({
      deploymentStatistics: undefined,
      npmArtifactProcessing: undefined,
      npmProjection: undefined,
      npmUpstream: undefined,
      publishUploadLimits: undefined,
      readiness: undefined,
      requestSizeLimit: undefined,
      trust: undefined,
    })
  })

  it('parses server runtime limits from environment variables', () => {
    expect(
      runtimeOptionsFromEnv({
        REGESTA_MAX_PUBLISH_ARTIFACT_BYTES: '100',
        REGESTA_MAX_PUBLISH_SOURCE_BYTES: '200',
        REGESTA_MAX_REQUEST_BYTES: '300',
        REGESTA_DOMAIN_BINDING_TIMEOUT_MS: '325',
        REGESTA_NPM_ARTIFACT_PROCESSING: 'false',
        REGESTA_NPM_PROJECTION: 'false',
        REGESTA_NPM_UPSTREAM_FALLBACK: 'false',
        REGESTA_NPM_UPSTREAM_TIMEOUT_MS: '350',
        REGESTA_READINESS_TIMEOUT_MS: '400',
        REGESTA_STATISTICS_CACHE_TTL_MS: '500',
      }),
    ).toEqual({
      deploymentStatistics: {
        cacheTtlMs: 500,
      },
      npmArtifactProcessing: false,
      npmProjection: false,
      npmUpstream: {
        upstreamFallback: false,
        upstreamTimeoutMs: 350,
      },
      publishUploadLimits: {
        artifactBytes: 100,
        sourceBytes: 200,
      },
      readiness: {
        timeoutMs: 400,
      },
      requestSizeLimit: {
        maxBytes: 300,
      },
      trust: {
        domainBindingFetchTimeoutMs: 325,
      },
    })
  })

  it('allows zero for non-negative byte and statistics limits', () => {
    expect(
      runtimeOptionsFromEnv({
        REGESTA_MAX_PUBLISH_ARTIFACT_BYTES: '0',
        REGESTA_MAX_PUBLISH_SOURCE_BYTES: '0',
        REGESTA_MAX_REQUEST_BYTES: '0',
        REGESTA_DOMAIN_BINDING_TIMEOUT_MS: '0',
        REGESTA_NPM_UPSTREAM_TIMEOUT_MS: '0',
        REGESTA_STATISTICS_CACHE_TTL_MS: '0',
      }),
    ).toEqual({
      deploymentStatistics: {
        cacheTtlMs: 0,
      },
      npmArtifactProcessing: undefined,
      npmProjection: undefined,
      npmUpstream: {
        upstreamTimeoutMs: 0,
      },
      publishUploadLimits: {
        artifactBytes: 0,
        sourceBytes: 0,
      },
      readiness: undefined,
      requestSizeLimit: {
        maxBytes: 0,
      },
      trust: {
        domainBindingFetchTimeoutMs: 0,
      },
    })
  })

  it('parses explicit npm projection enablement', () => {
    expect(
      runtimeOptionsFromEnv({
        REGESTA_NPM_PROJECTION: 'true',
      }),
    ).toMatchObject({
      npmProjection: true,
    })
  })

  it('parses explicit npm artifact processing enablement', () => {
    expect(
      runtimeOptionsFromEnv({
        REGESTA_NPM_ARTIFACT_PROCESSING: 'true',
      }),
    ).toMatchObject({
      npmArtifactProcessing: true,
    })
  })

  it('parses explicit npm upstream fallback enablement', () => {
    expect(
      runtimeOptionsFromEnv({
        REGESTA_NPM_UPSTREAM_FALLBACK: 'true',
      }),
    ).toMatchObject({
      npmUpstream: {
        upstreamFallback: true,
      },
    })
  })

  it.each([
    ['REGESTA_MAX_PUBLISH_ARTIFACT_BYTES', '-1', 'non-negative safe integer'],
    ['REGESTA_MAX_PUBLISH_SOURCE_BYTES', '1.5', 'non-negative safe integer'],
    ['REGESTA_MAX_REQUEST_BYTES', 'Infinity', 'non-negative safe integer'],
    ['REGESTA_DOMAIN_BINDING_TIMEOUT_MS', '-1', 'non-negative safe integer'],
    ['REGESTA_DOMAIN_BINDING_TIMEOUT_MS', '1.0', 'non-negative safe integer'],
    ['REGESTA_NPM_UPSTREAM_TIMEOUT_MS', '-1', 'non-negative safe integer'],
    ['REGESTA_NPM_UPSTREAM_TIMEOUT_MS', ' 10', 'non-negative safe integer'],
    ['REGESTA_NPM_ARTIFACT_PROCESSING', '0', 'boolean value: true or false'],
    [
      'REGESTA_NPM_ARTIFACT_PROCESSING',
      'FALSE',
      'boolean value: true or false',
    ],
    ['REGESTA_NPM_PROJECTION', '0', 'boolean value: true or false'],
    ['REGESTA_NPM_PROJECTION', 'FALSE', 'boolean value: true or false'],
    ['REGESTA_NPM_UPSTREAM_FALLBACK', '0', 'boolean value: true or false'],
    ['REGESTA_NPM_UPSTREAM_FALLBACK', 'FALSE', 'boolean value: true or false'],
    ['REGESTA_STATISTICS_CACHE_TTL_MS', '-1', 'non-negative safe integer'],
    ['REGESTA_STATISTICS_CACHE_TTL_MS', '1.0', 'non-negative safe integer'],
    [
      'REGESTA_STATISTICS_CACHE_TTL_MS',
      '9007199254740992',
      'non-negative safe integer',
    ],
    ['REGESTA_READINESS_TIMEOUT_MS', '0', 'positive safe integer'],
    ['REGESTA_READINESS_TIMEOUT_MS', '01', 'positive safe integer'],
  ] satisfies Array<[keyof RuntimeEnvironment, string, string]>)(
    'rejects invalid %s values',
    (name, value, message) => {
      expect(() =>
        runtimeOptionsFromEnv({
          [name]: value,
        }),
      ).toThrow(`${name} must be a ${message}`)
    },
  )
})
