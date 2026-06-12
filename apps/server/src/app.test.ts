import { Buffer } from 'node:buffer'
import { execFile } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { createServer, type IncomingHttpHeaders } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'
import { gzipSync } from 'node:zlib'
import {
  createLocalRegistryAdapters,
  createMemoryRegistryAdapters,
} from '@regesta/adapters'
import {
  createChannelDeleteIntent,
  createChannelUpdateIntent,
  createReleasePublishIntent,
  createWriteAuthorization,
  releasePublishArtifactDescriptorDigest,
  type DomainBinding,
  type Ed25519PrivateKeyJwk,
  type Ed25519PublicKeyJwk,
  type WriteIntent,
} from '@regesta/auth'
import {
  configDigest,
  normalizeRegestaConfig,
  PackageChannelConflictError,
  publishRelease,
  RegistryEventAlreadyExistsError,
  updatePackageChannel,
} from '@regesta/core'
import {
  canonicalJson,
  parsePackageId,
  sha256,
  type RegestaConfig,
} from '@regesta/protocol'
import { describe, expect, it, vi } from 'vitest'
import { createRegestaApp } from './app.ts'
import {
  devLocalhostDomainBinding,
  devLocalhostKeyId,
  devLocalhostPrivateKeyFile,
} from './dev/keys.ts'
import type { CoreRegistryAuditEntry } from './core/app.ts'

const execFileAsync = promisify(execFile)

describe('createRegestaApp', () => {
  it('serves deployment info at the root path', async () => {
    const app = createRegestaApp(createMemoryRegistryAdapters())
    const response = await app.request('/')
    const head = await app.request('/', {
      method: 'HEAD',
    })
    const health = await app.request('/health')
    const healthHead = await app.request('/health', {
      method: 'HEAD',
    })
    const ready = await app.request('/ready')
    const readyHead = await app.request('/ready', {
      method: 'HEAD',
    })
    const deploymentInfoText = await response.clone().text()
    const healthText = await health.clone().text()
    const readyText = await ready.clone().text()

    expect(response.status).toBe(200)
    expect(response.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/u)
    expect(response.headers.get('content-length')).toBe(
      String(Buffer.byteLength(deploymentInfoText)),
    )
    expect(response.headers.get('cache-control')).toBe('no-store')
    const deploymentInfo = await response.json()
    expect(deploymentInfo).not.toHaveProperty('api')
    expect(deploymentInfo).toEqual({
      build: {
        time: '2026-06-08T00:00:00.000Z',
      },
      git: {
        dirty: false,
        sha: 'test-git-sha',
      },
      object: 'regesta.deployment-info',
      runtime: {
        name: 'node',
        version: process.versions.node,
      },
      service: '@regesta/server',
      statistics: {
        packages: 0,
      },
      version: '0.0.0',
    })
    expect(head.status).toBe(200)
    expect(head.headers.get('content-type')).toBe(
      'application/json; charset=UTF-8',
    )
    expect(head.headers.get('content-length')).toBeNull()
    expect(head.headers.get('cache-control')).toBe('no-store')
    expect(await head.text()).toBe('')
    expect(health.status).toBe(200)
    expect(health.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/u)
    expect(health.headers.get('cache-control')).toBe('no-store')
    expect(health.headers.get('content-length')).toBe(
      String(Buffer.byteLength(healthText)),
    )
    await expect(health.json()).resolves.toEqual({ ok: true })
    expect(healthHead.status).toBe(200)
    expect(healthHead.headers.get('content-type')).toBe(
      'application/json; charset=UTF-8',
    )
    expect(healthHead.headers.get('content-length')).toBe(
      String(Buffer.byteLength(healthText)),
    )
    expect(healthHead.headers.get('cache-control')).toBe('no-store')
    expect(await healthHead.text()).toBe('')
    expect(ready.status).toBe(200)
    expect(ready.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/u)
    expect(ready.headers.get('cache-control')).toBe('no-store')
    expect(ready.headers.get('content-length')).toBe(
      String(Buffer.byteLength(readyText)),
    )
    await expect(ready.json()).resolves.toEqual({
      checks: {
        checkpoints: true,
        database: true,
        objects: true,
        queue: true,
        signer: true,
      },
      kind: 'regesta.readiness',
      ok: true,
    })
    expect(readyHead.status).toBe(200)
    expect(readyHead.headers.get('cache-control')).toBe('no-store')
    expect(readyHead.headers.get('content-type')).toBe(
      'application/json; charset=UTF-8',
    )
    expect(readyHead.headers.get('content-length')).toBe(
      String(Buffer.byteLength(readyText)),
    )
    expect(await readyHead.text()).toBe('')
  })

  it('serves host-specific root responses without mixing core and npm roots', async () => {
    const adapters = createMemoryRegistryAdapters()
    const countPackages = vi.fn(() => Promise.resolve(3))
    adapters.database.countPackages = countPackages
    const app = createRegestaApp(adapters)

    const npmRoot = await app.request('http://npm.registry.test/')
    const npmHead = await app.request('http://npm.registry.test/', {
      method: 'HEAD',
    })
    const coreRoot = await app.request('http://registry.test/')
    const coreRootText = await coreRoot.clone().text()

    expect(npmRoot.status).toBe(200)
    expect(npmRoot.headers.get('cache-control')).toBe('no-cache')
    expect(npmRoot.headers.get('content-length')).toBe('2')
    expect(npmRoot.headers.get('content-type')).toBe(
      'application/json; charset=UTF-8',
    )
    await expect(npmRoot.json()).resolves.toEqual({})

    expect(npmHead.status).toBe(200)
    expect(npmHead.headers.get('cache-control')).toBe('no-cache')
    expect(npmHead.headers.get('content-length')).toBe('2')
    expect(npmHead.headers.get('content-type')).toBe(
      'application/json; charset=UTF-8',
    )
    await expect(npmHead.text()).resolves.toBe('')

    expect(coreRoot.status).toBe(200)
    expect(coreRoot.headers.get('cache-control')).toBe('no-store')
    expect(coreRoot.headers.get('content-length')).toBe(
      String(Buffer.byteLength(coreRootText)),
    )
    await expect(coreRoot.json()).resolves.toMatchObject({
      object: 'regesta.deployment-info',
      statistics: {
        packages: 3,
      },
    })
    expect(countPackages).toHaveBeenCalledTimes(1)
  })

  it('caches deployment statistics between root path reads', async () => {
    const adapters = createMemoryRegistryAdapters()
    const countPackages = vi.fn(() => Promise.resolve(7))
    adapters.database.countPackages = countPackages
    const app = createRegestaApp(adapters)

    const first = await app.request('/')
    const second = await app.request('/')

    expect(first.status).toBe(200)
    await expect(first.json()).resolves.toMatchObject({
      statistics: {
        packages: 7,
      },
    })
    expect(second.status).toBe(200)
    await expect(second.json()).resolves.toMatchObject({
      statistics: {
        packages: 7,
      },
    })
    expect(countPackages).toHaveBeenCalledTimes(1)
  })

  it('serves root HEAD without reading deployment statistics', async () => {
    const adapters = createMemoryRegistryAdapters()
    const countPackages = vi.fn(() => {
      throw new Error('root HEAD must not read deployment statistics')
    })
    adapters.database.countPackages = countPackages
    const app = createRegestaApp(adapters)

    const response = await app.request('http://registry.test/', {
      method: 'HEAD',
    })

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe(
      'application/json; charset=UTF-8',
    )
    expect(response.headers.get('cache-control')).toBe('no-store')
    await expect(response.text()).resolves.toBe('')
    expect(countPackages).not.toHaveBeenCalled()
  })

  it('serves health without touching storage adapters or statistics', async () => {
    const adapters = createMemoryRegistryAdapters()
    const countPackages = vi.fn(() => {
      throw new Error('health must not read deployment statistics')
    })
    const databaseReadiness = vi.fn(() => {
      throw new Error('health must not probe database readiness')
    })
    const objectReadiness = vi.fn(() => {
      throw new Error('health must not probe object readiness')
    })
    const queueReadiness = vi.fn(() => {
      throw new Error('health must not probe queue readiness')
    })
    const signerReadiness = vi.fn(() => {
      throw new Error('health must not probe signer readiness')
    })

    adapters.database.countPackages = countPackages
    adapters.database.checkReadiness = databaseReadiness
    adapters.objects.checkReadiness = objectReadiness
    adapters.queue.checkReadiness = queueReadiness
    adapters.signer.checkReadiness = signerReadiness

    const app = createRegestaApp(adapters)
    const health = await app.request('/health')
    const healthHead = await app.request('/health', {
      method: 'HEAD',
    })

    expect(health.status).toBe(200)
    await expect(health.json()).resolves.toEqual({ ok: true })
    expect(healthHead.status).toBe(200)
    await expect(healthHead.text()).resolves.toBe('')

    expect(countPackages).not.toHaveBeenCalled()
    expect(databaseReadiness).not.toHaveBeenCalled()
    expect(objectReadiness).not.toHaveBeenCalled()
    expect(queueReadiness).not.toHaveBeenCalled()
    expect(signerReadiness).not.toHaveBeenCalled()
  })

  it('keeps root statistics and readiness probes on separate hot paths', async () => {
    const adapters = createMemoryRegistryAdapters()
    const countPackages = vi.fn(() => Promise.resolve(5))
    const databaseReadiness = vi.fn(() => Promise.resolve())
    const objectReadiness = vi.fn(() => Promise.resolve())
    const queueReadiness = vi.fn(() => Promise.resolve())
    const signerReadiness = vi.fn(() => Promise.resolve())

    adapters.database.countPackages = countPackages
    adapters.database.checkReadiness = databaseReadiness
    adapters.objects.checkReadiness = objectReadiness
    adapters.queue.checkReadiness = queueReadiness
    adapters.signer.checkReadiness = signerReadiness

    const app = createRegestaApp(adapters)
    const root = await app.request('/')

    expect(root.status).toBe(200)
    await expect(root.json()).resolves.toMatchObject({
      statistics: {
        packages: 5,
      },
    })
    expect(countPackages).toHaveBeenCalledTimes(1)
    expect(databaseReadiness).not.toHaveBeenCalled()
    expect(objectReadiness).not.toHaveBeenCalled()
    expect(queueReadiness).not.toHaveBeenCalled()
    expect(signerReadiness).not.toHaveBeenCalled()

    const ready = await app.request('/ready')

    expect(ready.status).toBe(200)
    await expect(ready.json()).resolves.toMatchObject({
      kind: 'regesta.readiness',
      ok: true,
    })
    expect(countPackages).toHaveBeenCalledTimes(1)
    expect(databaseReadiness).toHaveBeenCalledTimes(1)
    expect(objectReadiness).toHaveBeenCalledTimes(1)
    expect(queueReadiness).toHaveBeenCalledTimes(1)
    expect(signerReadiness).toHaveBeenCalledTimes(1)
  })

  it('coalesces concurrent deployment statistics reads', async () => {
    const pendingCount = deferred<number>()
    const adapters = createMemoryRegistryAdapters()
    const countPackages = vi.fn(() => pendingCount.promise)
    adapters.database.countPackages = countPackages
    const app = createRegestaApp(adapters)

    const first = app.request('/')
    const second = app.request('/')

    await Promise.resolve()
    expect(countPackages).toHaveBeenCalledTimes(1)

    pendingCount.resolve(11)
    const responses = await Promise.all([first, second])

    for (const response of responses) {
      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toMatchObject({
        statistics: {
          packages: 11,
        },
      })
    }
    expect(countPackages).toHaveBeenCalledTimes(1)
  })

  it('refreshes deployment statistics after the cache ttl expires', async () => {
    const dateNow = vi.spyOn(Date, 'now').mockReturnValue(1_000)
    const adapters = createMemoryRegistryAdapters()
    const countPackages = vi.fn(() =>
      Promise.resolve(countPackages.mock.calls.length),
    )
    adapters.database.countPackages = countPackages
    const app = createRegestaApp(adapters)

    try {
      const first = await app.request('/')
      dateNow.mockReturnValue(10_999)
      const cached = await app.request('/')
      dateNow.mockReturnValue(11_000)
      const refreshed = await app.request('/')

      await expect(first.json()).resolves.toMatchObject({
        statistics: {
          packages: 1,
        },
      })
      await expect(cached.json()).resolves.toMatchObject({
        statistics: {
          packages: 1,
        },
      })
      await expect(refreshed.json()).resolves.toMatchObject({
        statistics: {
          packages: 2,
        },
      })
      expect(countPackages).toHaveBeenCalledTimes(2)
    } finally {
      dateNow.mockRestore()
    }
  })

  it('uses the configured deployment statistics cache ttl', async () => {
    const dateNow = vi.spyOn(Date, 'now').mockReturnValue(1_000)
    const adapters = createMemoryRegistryAdapters()
    const countPackages = vi.fn(() =>
      Promise.resolve(countPackages.mock.calls.length),
    )
    adapters.database.countPackages = countPackages
    const app = createRegestaApp(adapters, {
      deploymentStatistics: {
        cacheTtlMs: 25,
      },
    })

    try {
      const first = await app.request('/')
      dateNow.mockReturnValue(1_024)
      const cached = await app.request('/')
      dateNow.mockReturnValue(1_025)
      const refreshed = await app.request('/')

      await expect(first.json()).resolves.toMatchObject({
        statistics: {
          packages: 1,
        },
      })
      await expect(cached.json()).resolves.toMatchObject({
        statistics: {
          packages: 1,
        },
      })
      await expect(refreshed.json()).resolves.toMatchObject({
        statistics: {
          packages: 2,
        },
      })
      expect(countPackages).toHaveBeenCalledTimes(2)
    } finally {
      dateNow.mockRestore()
    }
  })

  it('serves stale cached deployment statistics when a refresh read fails', async () => {
    const dateNow = vi.spyOn(Date, 'now').mockReturnValue(1_000)
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const refreshError = new Error('statistics store unavailable')
    const adapters = createMemoryRegistryAdapters()
    const countPackages = vi
      .fn<() => Promise<number>>()
      .mockResolvedValueOnce(3)
      .mockRejectedValueOnce(refreshError)
      .mockResolvedValueOnce(4)
    adapters.database.countPackages = countPackages
    const app = createRegestaApp(adapters, {
      deploymentStatistics: {
        cacheTtlMs: 25,
      },
    })

    try {
      const first = await app.request('http://registry.test/')
      dateNow.mockReturnValue(1_025)
      const stale = await app.request('http://registry.test/')
      dateNow.mockReturnValue(1_026)
      const recovered = await app.request('http://registry.test/')

      expect(first.status).toBe(200)
      await expect(first.json()).resolves.toMatchObject({
        statistics: {
          packages: 3,
        },
      })
      expect(stale.status).toBe(200)
      await expect(stale.json()).resolves.toMatchObject({
        statistics: {
          packages: 3,
        },
      })
      expect(recovered.status).toBe(200)
      await expect(recovered.json()).resolves.toMatchObject({
        statistics: {
          packages: 4,
        },
      })
      expect(countPackages).toHaveBeenCalledTimes(3)
      expect(consoleError).toHaveBeenCalledWith(
        'Deployment statistics refresh failed; serving cached value',
        {
          error: refreshError,
          kind: 'regesta.deployment-statistics-refresh-failure',
        },
      )
    } finally {
      consoleError.mockRestore()
      dateNow.mockRestore()
    }
  })

  it('does not serve stale statistics for schema-invalid refreshes', async () => {
    const dateNow = vi.spyOn(Date, 'now').mockReturnValue(1_000)
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const adapters = createMemoryRegistryAdapters()
    const countPackages = vi
      .fn<() => Promise<number>>()
      .mockResolvedValueOnce(3)
      .mockResolvedValueOnce(-1)
    adapters.database.countPackages = countPackages
    const app = createRegestaApp(adapters, {
      deploymentStatistics: {
        cacheTtlMs: 25,
      },
    })

    try {
      const first = await app.request('http://registry.test/')
      dateNow.mockReturnValue(1_025)
      const invalid = await app.request('http://registry.test/', {
        headers: {
          'x-request-id': 'invalid-stale-statistics-001',
        },
      })

      expect(first.status).toBe(200)
      await expect(first.json()).resolves.toMatchObject({
        statistics: {
          packages: 3,
        },
      })
      expect(invalid.status).toBe(500)
      await expect(invalid.json()).resolves.toEqual({
        code: 'internal_server_error',
        error: 'Internal Server Error',
        message: 'Internal Server Error',
      })
      expect(countPackages).toHaveBeenCalledTimes(2)
      expect(consoleError).toHaveBeenCalledWith(
        'Unexpected transport error',
        expect.objectContaining({
          error: expect.objectContaining({
            message:
              'Deployment package statistics must be a non-negative safe integer',
          }),
          kind: 'regesta.unexpected-error',
          requestId: 'invalid-stale-statistics-001',
        }),
      )
    } finally {
      consoleError.mockRestore()
      dateNow.mockRestore()
    }
  })

  it('can disable deployment statistics caching between requests', async () => {
    const adapters = createMemoryRegistryAdapters()
    const countPackages = vi.fn(() =>
      Promise.resolve(countPackages.mock.calls.length),
    )
    adapters.database.countPackages = countPackages
    const app = createRegestaApp(adapters, {
      deploymentStatistics: {
        cacheTtlMs: 0,
      },
    })

    const first = await app.request('/')
    const second = await app.request('/')

    await expect(first.json()).resolves.toMatchObject({
      statistics: {
        packages: 1,
      },
    })
    await expect(second.json()).resolves.toMatchObject({
      statistics: {
        packages: 2,
      },
    })
    expect(countPackages).toHaveBeenCalledTimes(2)
  })

  it('still coalesces concurrent deployment statistics reads when caching is disabled', async () => {
    const pendingCount = deferred<number>()
    const adapters = createMemoryRegistryAdapters()
    const countPackages = vi.fn(() => pendingCount.promise)
    adapters.database.countPackages = countPackages
    const app = createRegestaApp(adapters, {
      deploymentStatistics: {
        cacheTtlMs: 0,
      },
    })

    const first = app.request('/')
    const second = app.request('/')

    await Promise.resolve()
    expect(countPackages).toHaveBeenCalledTimes(1)

    pendingCount.resolve(19)
    const responses = await Promise.all([first, second])

    for (const response of responses) {
      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toMatchObject({
        statistics: {
          packages: 19,
        },
      })
    }
    expect(countPackages).toHaveBeenCalledTimes(1)

    await app.request('/')

    expect(countPackages).toHaveBeenCalledTimes(2)
  })

  it('rejects invalid deployment statistics cache configuration', () => {
    expect(() =>
      createRegestaApp(createMemoryRegistryAdapters(), {
        deploymentStatistics: {
          cacheTtlMs: -1,
        },
      }),
    ).toThrow(
      'Deployment statistics cache TTL must be a non-negative safe integer',
    )
  })

  it('does not cache failed deployment statistics reads', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const adapters = createMemoryRegistryAdapters()
    const countPackages = vi
      .fn<() => Promise<number>>()
      .mockRejectedValueOnce(new Error('transient statistics failure'))
      .mockResolvedValueOnce(13)
    adapters.database.countPackages = countPackages
    const app = createRegestaApp(adapters)

    try {
      const failed = await app.request('http://registry.test/', {
        headers: {
          'x-request-id': 'transient-statistics-failure-001',
        },
      })
      const recovered = await app.request('http://registry.test/')

      expect(failed.status).toBe(500)
      await expect(failed.json()).resolves.toEqual({
        code: 'internal_server_error',
        error: 'Internal Server Error',
        message: 'Internal Server Error',
      })
      expect(recovered.status).toBe(200)
      await expect(recovered.json()).resolves.toMatchObject({
        statistics: {
          packages: 13,
        },
      })
      expect(countPackages).toHaveBeenCalledTimes(2)
      expect(consoleError).toHaveBeenCalledWith(
        'Unexpected transport error',
        expect.objectContaining({
          error: expect.objectContaining({
            message: 'transient statistics failure',
          }),
          kind: 'regesta.unexpected-error',
          requestId: 'transient-statistics-failure-001',
        }),
      )
    } finally {
      consoleError.mockRestore()
    }
  })

  it('logs schema-invalid deployment statistics at the transport boundary', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const adapters = createMemoryRegistryAdapters()
    const countPackages = vi
      .fn<() => Promise<number>>()
      .mockResolvedValueOnce(-1)
      .mockResolvedValueOnce(17)
    adapters.database.countPackages = countPackages
    const app = createRegestaApp(adapters)

    try {
      const response = await app.request('http://registry.test/', {
        headers: {
          'x-request-id': 'invalid-deployment-statistics-001',
        },
      })

      expect(response.status).toBe(500)
      expect(response.headers.get('x-request-id')).toBe(
        'invalid-deployment-statistics-001',
      )
      await expect(response.json()).resolves.toEqual({
        code: 'internal_server_error',
        error: 'Internal Server Error',
        message: 'Internal Server Error',
      })
      expect(consoleError).toHaveBeenCalledWith(
        'Unexpected transport error',
        expect.objectContaining({
          error: expect.objectContaining({
            message:
              'Deployment package statistics must be a non-negative safe integer',
          }),
          kind: 'regesta.unexpected-error',
          requestId: 'invalid-deployment-statistics-001',
        }),
      )
      const recovered = await app.request('http://registry.test/')

      expect(recovered.status).toBe(200)
      await expect(recovered.json()).resolves.toMatchObject({
        statistics: {
          packages: 17,
        },
      })
      expect(countPackages).toHaveBeenCalledTimes(2)
    } finally {
      consoleError.mockRestore()
    }
  })

  it('returns 503 when persistent storage is not ready', async () => {
    const adapters = createMemoryRegistryAdapters()
    adapters.database.checkReadiness = () => {
      throw new Error('database unavailable')
    }
    const app = createRegestaApp(adapters)

    const ready = await app.request('/ready')
    const readyHead = await app.request('/ready', {
      method: 'HEAD',
    })

    expect(ready.status).toBe(503)
    expect(ready.headers.get('cache-control')).toBe('no-store')
    await expect(ready.json()).resolves.toEqual({
      checks: {
        checkpoints: true,
        database: false,
        objects: true,
        queue: true,
        signer: true,
      },
      kind: 'regesta.readiness',
      ok: false,
    })
    expect(readyHead.status).toBe(503)
    expect(readyHead.headers.get('cache-control')).toBe('no-store')
    expect(await readyHead.text()).toBe('')
  })

  it('applies configured readiness probe timeouts to ready checks', async () => {
    vi.useFakeTimers()
    const adapters = createMemoryRegistryAdapters()
    adapters.database.checkReadiness = () => new Promise<void>(() => {})
    const app = createRegestaApp(adapters, {
      readiness: {
        timeoutMs: 50,
      },
    })

    try {
      const ready = app.request('/ready')

      await vi.advanceTimersByTimeAsync(50)

      const response = await ready
      expect(response.status).toBe(503)
      expect(response.headers.get('cache-control')).toBe('no-store')
      await expect(response.json()).resolves.toMatchObject({
        checks: {
          checkpoints: true,
          database: false,
          objects: true,
          queue: true,
          signer: true,
        },
        kind: 'regesta.readiness',
        ok: false,
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('checks database readiness without scanning the event log', async () => {
    const adapters = createMemoryRegistryAdapters()
    adapters.database.listEvents = () => {
      throw new Error('readiness should use database readiness probe')
    }
    const app = createRegestaApp(adapters)

    const ready = await app.request('/ready')

    expect(ready.status).toBe(200)
    await expect(ready.json()).resolves.toEqual({
      checks: {
        checkpoints: true,
        database: true,
        objects: true,
        queue: true,
        signer: true,
      },
      kind: 'regesta.readiness',
      ok: true,
    })
  })

  it('returns 503 when object storage is not ready', async () => {
    const adapters = createMemoryRegistryAdapters()
    adapters.objects.checkReadiness = () => {
      throw new Error('object storage unavailable')
    }
    const app = createRegestaApp(adapters)

    const ready = await app.request('/ready')
    const readyHead = await app.request('/ready', {
      method: 'HEAD',
    })

    expect(ready.status).toBe(503)
    expect(ready.headers.get('cache-control')).toBe('no-store')
    await expect(ready.json()).resolves.toEqual({
      checks: {
        checkpoints: true,
        database: true,
        objects: false,
        queue: true,
        signer: true,
      },
      kind: 'regesta.readiness',
      ok: false,
    })
    expect(readyHead.status).toBe(503)
    expect(readyHead.headers.get('cache-control')).toBe('no-store')
    expect(await readyHead.text()).toBe('')
  })

  it('returns 503 when checkpoint storage is not ready', async () => {
    const adapters = createMemoryRegistryAdapters()
    const checkpoints = adapters.checkpoints
    if (!checkpoints) {
      throw new Error(
        'Expected memory registry adapters to include checkpoints',
      )
    }
    checkpoints.checkReadiness = () => {
      throw new Error('checkpoint storage unavailable')
    }
    const app = createRegestaApp(adapters)

    const ready = await app.request('/ready')

    expect(ready.status).toBe(503)
    expect(ready.headers.get('cache-control')).toBe('no-store')
    await expect(ready.json()).resolves.toEqual({
      checks: {
        checkpoints: false,
        database: true,
        objects: true,
        queue: true,
        signer: true,
      },
      kind: 'regesta.readiness',
      ok: false,
    })
  })

  it('returns 503 when queue storage is not ready', async () => {
    const adapters = createMemoryRegistryAdapters()
    adapters.queue.checkReadiness = () => {
      throw new Error('queue unavailable')
    }
    const app = createRegestaApp(adapters)

    const ready = await app.request('/ready')
    const readyHead = await app.request('/ready', {
      method: 'HEAD',
    })

    expect(ready.status).toBe(503)
    expect(ready.headers.get('cache-control')).toBe('no-store')
    await expect(ready.json()).resolves.toEqual({
      checks: {
        checkpoints: true,
        database: true,
        objects: true,
        queue: false,
        signer: true,
      },
      kind: 'regesta.readiness',
      ok: false,
    })
    expect(readyHead.status).toBe(503)
    expect(readyHead.headers.get('cache-control')).toBe('no-store')
    expect(await readyHead.text()).toBe('')
  })

  it('returns 503 when signer service is not ready', async () => {
    const adapters = createMemoryRegistryAdapters()
    adapters.signer.checkReadiness = () => {
      throw new Error('signer unavailable')
    }
    const app = createRegestaApp(adapters)

    const ready = await app.request('/ready')
    const readyHead = await app.request('/ready', {
      method: 'HEAD',
    })

    expect(ready.status).toBe(503)
    expect(ready.headers.get('cache-control')).toBe('no-store')
    await expect(ready.json()).resolves.toEqual({
      checks: {
        checkpoints: true,
        database: true,
        objects: true,
        queue: true,
        signer: false,
      },
      kind: 'regesta.readiness',
      ok: false,
    })
    expect(readyHead.status).toBe(503)
    expect(readyHead.headers.get('cache-control')).toBe('no-store')
    expect(await readyHead.text()).toBe('')
  })

  it('keeps future ecosystem projection hosts out of core routes', async () => {
    const app = createRegestaApp(createMemoryRegistryAdapters())

    for (const host of [
      'cargo.registry.test',
      'go.registry.test',
      'oci.registry.test',
      'pypi.registry.test',
    ]) {
      const response = await app.request(`http://${host}/`)

      expect(response.status).toBe(404)
    }
  })

  it('supports CORS for arbitrary origins and hosts', async () => {
    const app = createRegestaApp(createMemoryRegistryAdapters())
    const response = await app.request('http://any.registry.test/', {
      headers: {
        origin: 'https://client.example',
      },
    })

    expect(response.status).toBe(200)
    expect(response.headers.get('access-control-allow-origin')).toBe('*')

    for (const url of [
      'http://random.registry.test/releases',
      'http://npm.registry.test/@example.com/hello-regesta',
      'http://pypi.registry.test/simple/hello-regesta/',
    ]) {
      const preflight = await app.request(url, {
        headers: {
          'access-control-request-headers': 'content-type,x-regesta-test',
          'access-control-request-method': 'POST',
          origin: 'https://another-client.example',
        },
        method: 'OPTIONS',
      })

      expect(preflight.status).toBe(204)
      expect(preflight.headers.get('access-control-allow-origin')).toBe('*')
      expect(preflight.headers.get('access-control-allow-methods')).toContain(
        'POST',
      )
      expect(preflight.headers.get('access-control-allow-methods')).toContain(
        'OPTIONS',
      )
      expect(preflight.headers.get('access-control-allow-headers')).toBe(
        'content-type,x-regesta-test',
      )
    }
  })

  it('logs requests at the transport layer when configured', async () => {
    const entries: Array<{
      durationMs: number
      host: string
      kind: 'regesta.request'
      method: string
      path: string
      requestId: string
      status: number
    }> = []
    const app = createRegestaApp(createMemoryRegistryAdapters(), {
      requestLog: (entry) => {
        entries.push(entry)
      },
    })

    const response = await app.request('http://registry.test/health', {
      headers: {
        'x-request-id': 'health-check-001',
      },
    })

    expect(response.status).toBe(200)
    expect(response.headers.get('x-request-id')).toBe('health-check-001')
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      host: 'registry.test',
      kind: 'regesta.request',
      method: 'GET',
      path: '/health',
      requestId: 'health-check-001',
      status: 200,
    })
    expect(entries[0]!.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('logs unexpected server errors at the transport boundary', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const adapters = createMemoryRegistryAdapters()
    adapters.database.listEvents = () => {
      throw new Error('database credentials leaked in exception')
    }
    const app = createRegestaApp(adapters)

    try {
      const response = await app.request('http://registry.test/events', {
        headers: {
          'x-request-id': 'unexpected-500-001',
        },
      })

      expect(response.status).toBe(500)
      expect(response.headers.get('x-request-id')).toBe('unexpected-500-001')
      await expect(response.json()).resolves.toEqual({
        code: 'internal_server_error',
        error: 'Internal Server Error',
        message: 'Internal Server Error',
      })
      expect(consoleError).toHaveBeenCalledWith(
        'Unexpected transport error',
        expect.objectContaining({
          error: expect.any(Error),
          kind: 'regesta.unexpected-error',
          requestId: 'unexpected-500-001',
        }),
      )
    } finally {
      consoleError.mockRestore()
    }
  })

  it('logs accepted publish events to the operator audit sink when configured', async () => {
    const entries: CoreRegistryAuditEntry[] = []
    const app = createRegestaApp(createMemoryRegistryAdapters(), {
      auditLog: (entry) => {
        entries.push(entry)
      },
    })
    const auth = createTestDomainAuth()
    const timestamp = new Date().toISOString()
    const source = bytes('source archive')
    const artifacts = [
      {
        bytes: bytes('install artifact'),
        format: 'generic-archive',
        mediaType: 'application/gzip',
        role: 'install',
      },
    ]
    const config: RegestaConfig = {
      id: 'demo:example.com/audit-regesta',
      provenance: {
        level: 'source-attached',
      },
      source: {
        include: ['regesta.json'],
      },
      version: '0.0.1',
    }
    const normalizedConfig = normalizeRegestaConfig(config)
    const form = new FormData()

    form.set('config', JSON.stringify(config))
    form.set(
      'authorization',
      JSON.stringify(
        auth.sign(
          createReleasePublishIntent({
            artifactDescriptorDigest:
              publishArtifactDescriptorDigest(artifacts),
            artifactDigests: artifacts.map((artifact) =>
              sha256(artifact.bytes),
            ),
            configDigest: configDigest(normalizedConfig),
            nonce: 'publish-audit-nonce',
            packageId: normalizedConfig.id,
            sourceDigest: sha256(source),
            timestamp,
            version: normalizedConfig.version,
          }),
        ),
      ),
    )
    form.set('createdAt', timestamp)
    form.set('source', new File([blobPart(source)], 'source.tgz'))
    form.set(
      'artifacts',
      JSON.stringify([
        {
          format: 'generic-archive',
          mediaType: 'application/gzip',
          part: 'artifact.install',
          role: 'install',
        },
      ]),
    )
    form.set(
      'artifact.install',
      new File([blobPart(artifacts[0]!.bytes)], 'install.tgz', {
        type: 'application/gzip',
      }),
    )

    vi.stubGlobal('fetch', auth.fetch)

    try {
      const response = await app.request('/releases', {
        body: form,
        headers: {
          'x-request-id': 'publish-audit-001',
        },
        method: 'POST',
      })

      expect(response.status).toBe(201)
      expect(entries).toHaveLength(1)
      const entry = entries[0]!
      expect(entry).toMatchObject({
        action: 'release.publish',
        channel: 'latest',
        eventType: 'release.published',
        kind: 'regesta.core-audit',
        outcome: 'accepted',
        package: normalizedConfig.id,
        requestId: 'publish-audit-001',
        timestamp,
        version: normalizedConfig.version,
      })
      if (entry.outcome !== 'accepted') {
        throw new Error('Expected accepted audit entry')
      }
      expect(entry.eventId).toMatch(/^sha256:[a-f0-9]{64}$/u)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('does not fail accepted writes when the operator audit sink fails', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const adapters = createMemoryRegistryAdapters()
    const app = createRegestaApp(adapters, {
      auditLog: () => {
        throw new Error('audit backend unavailable')
      },
    })
    const auth = createTestDomainAuth()
    const timestamp = new Date().toISOString()
    const source = bytes('source archive')
    const artifacts = [
      {
        bytes: bytes('install artifact'),
        format: 'generic-archive',
        mediaType: 'application/gzip',
        role: 'install',
      },
    ]
    const config: RegestaConfig = {
      id: 'demo:example.com/audit-sink-failure',
      provenance: {
        level: 'source-attached',
      },
      source: {
        include: ['regesta.json'],
      },
      version: '0.0.1',
    }
    const normalizedConfig = normalizeRegestaConfig(config)
    const form = new FormData()

    form.set('config', JSON.stringify(config))
    form.set(
      'authorization',
      JSON.stringify(
        auth.sign(
          createReleasePublishIntent({
            artifactDescriptorDigest:
              publishArtifactDescriptorDigest(artifacts),
            artifactDigests: artifacts.map((artifact) =>
              sha256(artifact.bytes),
            ),
            configDigest: configDigest(normalizedConfig),
            nonce: 'publish-audit-sink-failure-nonce',
            packageId: normalizedConfig.id,
            sourceDigest: sha256(source),
            timestamp,
            version: normalizedConfig.version,
          }),
        ),
      ),
    )
    form.set('createdAt', timestamp)
    form.set('source', new File([blobPart(source)], 'source.tgz'))
    form.set(
      'artifacts',
      JSON.stringify([
        {
          format: 'generic-archive',
          mediaType: 'application/gzip',
          part: 'artifact.install',
          role: 'install',
        },
      ]),
    )
    form.set(
      'artifact.install',
      new File([blobPart(artifacts[0]!.bytes)], 'install.tgz', {
        type: 'application/gzip',
      }),
    )

    vi.stubGlobal('fetch', auth.fetch)

    try {
      const response = await app.request('/releases', {
        body: form,
        method: 'POST',
      })

      expect(response.status).toBe(201)
      await expect(
        adapters.database.getRelease(
          normalizedConfig.id,
          normalizedConfig.version,
        ),
      ).resolves.toBeDefined()
      expect(consoleError).toHaveBeenCalledWith(
        'Core registry audit log sink failed',
        expect.objectContaining({
          action: 'release.publish',
          error: expect.any(Error),
          package: normalizedConfig.id,
        }),
      )
    } finally {
      vi.unstubAllGlobals()
      consoleError.mockRestore()
    }
  })

  it('logs rejected signed publish attempts to the operator audit sink when configured', async () => {
    const entries: CoreRegistryAuditEntry[] = []
    const app = createRegestaApp(createMemoryRegistryAdapters(), {
      auditLog: (entry) => {
        entries.push(entry)
      },
    })
    const auth = createTestDomainAuth()
    const timestamp = new Date().toISOString()
    const source = bytes('source archive')
    const artifacts = [
      {
        bytes: bytes('install artifact'),
        format: 'generic-archive',
        mediaType: 'application/gzip',
        role: 'install',
      },
    ]
    const config: RegestaConfig = {
      id: 'demo:example.com/rejected-audit-regesta',
      provenance: {
        level: 'source-attached',
      },
      source: {
        include: ['regesta.json'],
      },
      version: '0.0.1',
    }
    const normalizedConfig = normalizeRegestaConfig(config)
    const form = new FormData()

    form.set('config', JSON.stringify(config))
    form.set(
      'authorization',
      JSON.stringify(
        auth.sign(
          createReleasePublishIntent({
            artifactDescriptorDigest:
              publishArtifactDescriptorDigest(artifacts),
            artifactDigests: artifacts.map((artifact) =>
              sha256(artifact.bytes),
            ),
            configDigest: configDigest(normalizedConfig),
            nonce: 'publish-reject-audit-nonce',
            packageId: normalizedConfig.id,
            sourceDigest: sha256(bytes('different source archive')),
            timestamp,
            version: normalizedConfig.version,
          }),
        ),
      ),
    )
    form.set('createdAt', timestamp)
    form.set('source', new File([blobPart(source)], 'source.tgz'))
    form.set(
      'artifacts',
      JSON.stringify([
        {
          format: 'generic-archive',
          mediaType: 'application/gzip',
          part: 'artifact.install',
          role: 'install',
        },
      ]),
    )
    form.set(
      'artifact.install',
      new File([blobPart(artifacts[0]!.bytes)], 'install.tgz', {
        type: 'application/gzip',
      }),
    )

    const response = await app.request('/releases', {
      body: form,
      headers: {
        'x-request-id': 'publish-reject-audit-001',
      },
      method: 'POST',
    })

    expect(response.status).toBe(401)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      action: 'release.publish',
      channel: 'latest',
      kind: 'regesta.core-audit',
      outcome: 'rejected',
      package: normalizedConfig.id,
      reason: 'Write authorization payload mismatch',
      requestId: 'publish-reject-audit-001',
      version: normalizedConfig.version,
    })
    expect(entries[0]).toHaveProperty('observedAt')
  })

  it('logs accepted channel update events to the operator audit sink when configured', async () => {
    const entries: CoreRegistryAuditEntry[] = []
    const adapters = createMemoryRegistryAdapters()
    const app = createRegestaApp(adapters, {
      auditLog: (entry) => {
        entries.push(entry)
      },
    })
    const auth = createTestDomainAuth()
    const packageId = 'npm:example.com/channel-audit'
    const timestamp = new Date().toISOString()

    await publishRelease(
      {
        artifacts: [
          {
            bytes: bytes('install artifact'),
            format: 'npm-tarball',
            mediaType: 'application/gzip',
            role: 'install',
          },
        ],
        config: {
          id: packageId,
          source: {
            include: ['regesta.json'],
          },
          version: '0.0.1',
        },
        createdAt: '2026-06-01T00:00:00.000Z',
        source: bytes('source archive'),
      },
      adapters,
    )

    vi.stubGlobal('fetch', auth.fetch)

    try {
      const response = await app.request(
        `/packages/${encodeURIComponent(packageId)}/channels/latest`,
        {
          body: JSON.stringify({
            authorization: auth.sign(
              createChannelUpdateIntent({
                channel: 'latest',
                nonce: 'channel-audit-nonce',
                packageId,
                previousVersion: '0.0.1',
                timestamp,
                version: '0.0.1',
              }),
            ),
            version: '0.0.1',
          }),
          headers: {
            'content-type': 'application/json',
            'x-request-id': 'channel-audit-001',
          },
          method: 'PUT',
        },
      )

      expect(response.status).toBe(200)
      expect(entries).toHaveLength(1)
      const entry = entries[0]!
      expect(entry).toMatchObject({
        action: 'channel.update',
        channel: 'latest',
        eventType: 'channel.updated',
        kind: 'regesta.core-audit',
        outcome: 'accepted',
        package: packageId,
        previousVersion: '0.0.1',
        requestId: 'channel-audit-001',
        timestamp,
        version: '0.0.1',
      })
      if (entry.outcome !== 'accepted') {
        throw new Error('Expected accepted audit entry')
      }
      expect(entry.eventId).toMatch(/^sha256:[a-f0-9]{64}$/u)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('does not wait for slow asynchronous operator audit sinks', async () => {
    const pendingAudit = deferred<void>()
    const entries: CoreRegistryAuditEntry[] = []
    const adapters = createMemoryRegistryAdapters()
    const app = createRegestaApp(adapters, {
      auditLog: async (entry) => {
        await pendingAudit.promise
        entries.push(entry)
      },
    })
    const auth = createTestDomainAuth()
    const packageId = 'npm:example.com/slow-audit'
    const timestamp = new Date().toISOString()

    await publishRelease(
      {
        artifacts: [
          {
            bytes: bytes('install artifact'),
            format: 'npm-tarball',
            mediaType: 'application/gzip',
            role: 'install',
          },
        ],
        config: {
          id: packageId,
          source: {
            include: ['regesta.json'],
          },
          version: '0.0.1',
        },
        createdAt: '2026-06-01T00:00:00.000Z',
        source: bytes('source archive'),
      },
      adapters,
    )

    vi.stubGlobal('fetch', auth.fetch)

    try {
      const response = await app.request(
        `/packages/${encodeURIComponent(packageId)}/channels/latest`,
        {
          body: JSON.stringify({
            authorization: auth.sign(
              createChannelUpdateIntent({
                channel: 'latest',
                nonce: 'slow-audit-nonce',
                packageId,
                previousVersion: '0.0.1',
                timestamp,
                version: '0.0.1',
              }),
            ),
            version: '0.0.1',
          }),
          headers: {
            'content-type': 'application/json',
            'x-request-id': 'slow-audit-001',
          },
          method: 'PUT',
        },
      )

      expect(response.status).toBe(200)
      expect(entries).toEqual([])

      pendingAudit.resolve(undefined)
      await vi.waitFor(() => {
        expect(entries).toHaveLength(1)
      })
      expect(entries[0]).toMatchObject({
        action: 'channel.update',
        kind: 'regesta.core-audit',
        outcome: 'accepted',
        package: packageId,
        requestId: 'slow-audit-001',
      })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('logs accepted channel delete events to the operator audit sink when configured', async () => {
    const entries: CoreRegistryAuditEntry[] = []
    const adapters = createMemoryRegistryAdapters()
    const app = createRegestaApp(adapters, {
      auditLog: (entry) => {
        entries.push(entry)
      },
    })
    const auth = createTestDomainAuth()
    const packageId = 'npm:example.com/channel-delete-audit'
    const timestamp = new Date().toISOString()

    await publishRelease(
      {
        artifacts: [
          {
            bytes: bytes('install artifact'),
            format: 'npm-tarball',
            mediaType: 'application/gzip',
            role: 'install',
          },
        ],
        config: {
          id: packageId,
          source: {
            include: ['regesta.json'],
          },
          version: '0.0.1',
        },
        createdAt: '2026-06-01T00:00:00.000Z',
        source: bytes('source archive'),
      },
      adapters,
    )

    vi.stubGlobal('fetch', auth.fetch)

    try {
      const response = await app.request(
        `/packages/${encodeURIComponent(packageId)}/channels/latest`,
        {
          body: JSON.stringify({
            authorization: auth.sign(
              createChannelDeleteIntent({
                channel: 'latest',
                nonce: 'channel-delete-audit-nonce',
                packageId,
                previousVersion: '0.0.1',
                timestamp,
              }),
            ),
          }),
          headers: {
            'content-type': 'application/json',
            'x-request-id': 'channel-delete-audit-001',
          },
          method: 'DELETE',
        },
      )

      expect(response.status).toBe(200)
      expect(entries).toHaveLength(1)
      const entry = entries[0]!
      expect(entry).toMatchObject({
        action: 'channel.delete',
        channel: 'latest',
        eventType: 'channel.deleted',
        kind: 'regesta.core-audit',
        outcome: 'accepted',
        package: packageId,
        previousVersion: '0.0.1',
        requestId: 'channel-delete-audit-001',
        timestamp,
      })
      if (entry.outcome !== 'accepted') {
        throw new Error('Expected accepted audit entry')
      }
      expect(entry.eventId).toMatch(/^sha256:[a-f0-9]{64}$/u)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('logs rejected signed channel write attempts to the operator audit sink when configured', async () => {
    const entries: CoreRegistryAuditEntry[] = []
    const adapters = createMemoryRegistryAdapters()
    const app = createRegestaApp(adapters, {
      auditLog: (entry) => {
        entries.push(entry)
      },
    })
    const auth = createTestDomainAuth()
    const packageId = 'npm:example.com/channel-reject-audit'
    const timestamp = new Date().toISOString()

    await publishRelease(
      {
        artifacts: [
          {
            bytes: bytes('install artifact'),
            format: 'npm-tarball',
            mediaType: 'application/gzip',
            role: 'install',
          },
        ],
        config: {
          id: packageId,
          source: {
            include: ['regesta.json'],
          },
          version: '0.0.1',
        },
        createdAt: '2026-06-01T00:00:00.000Z',
        source: bytes('source archive'),
      },
      adapters,
    )

    const response = await app.request(
      `/packages/${encodeURIComponent(packageId)}/channels/latest`,
      {
        body: JSON.stringify({
          authorization: auth.sign(
            createChannelUpdateIntent({
              channel: 'latest',
              nonce: 'channel-reject-audit-nonce',
              packageId,
              previousVersion: '0.0.1',
              timestamp,
              version: '0.0.2',
            }),
          ),
          version: '0.0.1',
        }),
        headers: {
          'content-type': 'application/json',
          'x-request-id': 'channel-reject-audit-001',
        },
        method: 'PUT',
      },
    )

    expect(response.status).toBe(401)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      action: 'channel.update',
      channel: 'latest',
      kind: 'regesta.core-audit',
      outcome: 'rejected',
      package: packageId,
      previousVersion: '0.0.1',
      reason: 'Write authorization payload mismatch',
      requestId: 'channel-reject-audit-001',
      version: '0.0.1',
    })
    expect(entries[0]).toHaveProperty('observedAt')
  })

  it('logs rejected signed channel delete attempts to the operator audit sink when configured', async () => {
    const entries: CoreRegistryAuditEntry[] = []
    const adapters = createMemoryRegistryAdapters()
    const app = createRegestaApp(adapters, {
      auditLog: (entry) => {
        entries.push(entry)
      },
    })
    const auth = createTestDomainAuth()
    const packageId = 'npm:example.com/channel-delete-reject-audit'
    const timestamp = new Date().toISOString()

    await publishRelease(
      {
        artifacts: [
          {
            bytes: bytes('install artifact'),
            format: 'npm-tarball',
            mediaType: 'application/gzip',
            role: 'install',
          },
        ],
        config: {
          id: packageId,
          source: {
            include: ['regesta.json'],
          },
          version: '0.0.1',
        },
        createdAt: '2026-06-01T00:00:00.000Z',
        source: bytes('source archive'),
      },
      adapters,
    )

    const response = await app.request(
      `/packages/${encodeURIComponent(packageId)}/channels/latest`,
      {
        body: JSON.stringify({
          authorization: auth.sign(
            createChannelDeleteIntent({
              channel: 'latest',
              nonce: 'channel-delete-reject-audit-nonce',
              packageId,
              timestamp,
            }),
          ),
        }),
        headers: {
          'content-type': 'application/json',
          'x-request-id': 'channel-delete-reject-audit-001',
        },
        method: 'DELETE',
      },
    )

    expect(response.status).toBe(401)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      action: 'channel.delete',
      channel: 'latest',
      kind: 'regesta.core-audit',
      outcome: 'rejected',
      package: packageId,
      previousVersion: '0.0.1',
      reason: 'Write authorization payload mismatch',
      requestId: 'channel-delete-reject-audit-001',
    })
    expect(entries[0]).toHaveProperty('observedAt')
  })

  it('rejects oversized requests before route handlers parse the body', async () => {
    const entries: Array<{
      requestId: string
      status: number
    }> = []
    const app = createRegestaApp(createMemoryRegistryAdapters(), {
      requestLog: (entry) => {
        entries.push({
          requestId: entry.requestId,
          status: entry.status,
        })
      },
      requestSizeLimit: {
        maxBytes: 5,
      },
    })

    const response = await app.request('http://registry.test/releases', {
      body: 'upload',
      headers: {
        'content-length': '6',
        origin: 'https://client.example',
        'x-request-id': 'oversized-publish-001',
      },
      method: 'POST',
    })

    expect(response.status).toBe(413)
    expect(response.headers.get('access-control-allow-origin')).toBe('*')
    expect(response.headers.get('x-request-id')).toBe('oversized-publish-001')
    await expect(response.json()).resolves.toMatchObject({
      code: 'request_too_large',
      error: 'Request body too large',
      message: 'Request body too large',
    })
    expect(entries).toEqual([
      {
        requestId: 'oversized-publish-001',
        status: 413,
      },
    ])
  })

  it('normalizes trailing slashes at the transport layer', async () => {
    const app = createRegestaApp(createMemoryRegistryAdapters())
    const response = await app.request('/health/')

    expect(response.status).toBe(301)
    expect(new URL(response.headers.get('location')!).pathname).toBe('/health')
  })

  it('handles browser favicon requests outside package routes', async () => {
    const app = createRegestaApp(createMemoryRegistryAdapters())
    const response = await app.request('/favicon.ico')

    expect(response.status).toBe(204)
    expect(response.headers.get('cache-control')).toBe('public, max-age=86400')
    expect(await response.text()).toBe('')
  })

  it('serves fixed dev.localhost key material for local debugging', async () => {
    const app = createRegestaApp(createMemoryRegistryAdapters())
    const binding = await app.request(
      'http://dev.localhost/.well-known/regesta.json',
    )
    const privateKey = await app.request(
      'http://dev.localhost/regesta.private-key.json',
    )

    expect(binding.status).toBe(200)
    await expect(binding.json()).resolves.toEqual(devLocalhostDomainBinding)
    expect(privateKey.status).toBe(200)
    await expect(privateKey.json()).resolves.toMatchObject({
      kid: devLocalhostKeyId,
      privateKeyJwk: {
        crv: 'Ed25519',
        d: devLocalhostPrivateKeyFile.privateKeyJwk.d,
        kty: 'OKP',
      },
    })
  })

  it('returns 400 for invalid object digest requests', async () => {
    const app = createRegestaApp(createMemoryRegistryAdapters())
    const response = await app.request('/objects/not-a-digest')

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      error: 'Invalid object digest',
    })
  })

  it('exports paginated object inventory descriptors', async () => {
    const adapters = createMemoryRegistryAdapters()
    const app = createRegestaApp(adapters)
    const descriptors = await Promise.all([
      adapters.objects.put(bytes('object c'), 'text/plain'),
      adapters.objects.put(bytes('object a'), 'application/octet-stream'),
      adapters.objects.put(bytes('object b'), 'application/json'),
    ])
    const sorted = descriptors.toSorted((left, right) => {
      return left.digest.localeCompare(right.digest)
    })
    const getDescriptor = vi.fn(() => {
      throw new Error('object inventory reads should not preflight cursors')
    })
    adapters.objects.getDescriptor = getDescriptor

    const firstPage = await app.request('/objects?limit=2')
    const firstEtag = firstPage.headers.get('etag')
    const firstHead = await app.request('/objects?limit=2', {
      method: 'HEAD',
    })
    const conditional = await app.request('/objects?limit=2', {
      headers: {
        'if-none-match': firstEtag ?? '',
      },
    })
    const secondPage = await app.request(
      `/objects?after=${encodeURIComponent(sorted[1]!.digest)}&limit=2`,
    )
    const emptyPageUrl = `/objects?after=${encodeURIComponent(sorted[2]!.digest)}&limit=2`
    const emptyPage = await app.request(emptyPageUrl)
    const emptyPageHead = await app.request(emptyPageUrl, {
      method: 'HEAD',
    })
    const conditionalEmptyPage = await app.request(emptyPageUrl, {
      headers: {
        'if-none-match': `W/"regesta.object-inventory:${sorted[2]!.digest}:0"`,
      },
    })
    const missingCursor = await app.request(
      `/objects?after=${encodeURIComponent(sha256(bytes('missing')))}`,
    )
    const invalidQuery = await app.request('/objects?limit=1000')

    expect(firstPage.status).toBe(200)
    expect(firstPage.headers.get('cache-control')).toBe('no-cache')
    expect(firstPage.headers.get('content-type')).toBe(
      'application/json; charset=UTF-8',
    )
    expect(firstEtag).toBe(
      `W/"regesta.object-inventory:${sorted[1]!.digest}:2"`,
    )
    const firstPageText = await firstPage.clone().text()
    expect(firstPage.headers.get('content-length')).toBe(
      String(Buffer.byteLength(firstPageText)),
    )
    await expect(firstPage.json()).resolves.toEqual({
      nextAfter: sorted[1]!.digest,
      object: 'regesta.object-inventory',
      objects: sorted.slice(0, 2),
    })
    expect(firstHead.status).toBe(200)
    expect(firstHead.headers.get('cache-control')).toBe('no-cache')
    expect(firstHead.headers.get('content-type')).toBe(
      'application/json; charset=UTF-8',
    )
    expect(firstHead.headers.get('content-length')).toBe(
      String(Buffer.byteLength(firstPageText)),
    )
    expect(firstHead.headers.get('etag')).toBe(firstEtag)
    expect(await firstHead.text()).toBe('')
    expect(conditional.status).toBe(304)
    expect(conditional.headers.get('cache-control')).toBe('no-cache')
    expect(conditional.headers.get('etag')).toBe(firstEtag)
    expect(conditional.headers.get('content-length')).toBeNull()
    expect(await conditional.text()).toBe('')
    expect(secondPage.status).toBe(200)
    await expect(secondPage.json()).resolves.toEqual({
      nextAfter: sorted[2]!.digest,
      object: 'regesta.object-inventory',
      objects: sorted.slice(2),
    })
    expect(emptyPage.status).toBe(200)
    expect(emptyPage.headers.get('cache-control')).toBe('no-cache')
    expect(emptyPage.headers.get('content-type')).toBe(
      'application/json; charset=UTF-8',
    )
    expect(emptyPage.headers.get('etag')).toBe(
      `W/"regesta.object-inventory:${sorted[2]!.digest}:0"`,
    )
    const emptyPageText = await emptyPage.clone().text()
    expect(emptyPage.headers.get('content-length')).toBe(
      String(Buffer.byteLength(emptyPageText)),
    )
    await expect(emptyPage.json()).resolves.toEqual({
      object: 'regesta.object-inventory',
      objects: [],
    })
    expect(emptyPageHead.status).toBe(200)
    expect(emptyPageHead.headers.get('cache-control')).toBe('no-cache')
    expect(emptyPageHead.headers.get('content-type')).toBe(
      'application/json; charset=UTF-8',
    )
    expect(emptyPageHead.headers.get('etag')).toBe(
      `W/"regesta.object-inventory:${sorted[2]!.digest}:0"`,
    )
    expect(emptyPageHead.headers.get('content-length')).toBe(
      String(Buffer.byteLength(emptyPageText)),
    )
    expect(await emptyPageHead.text()).toBe('')
    expect(conditionalEmptyPage.status).toBe(304)
    expect(conditionalEmptyPage.headers.get('cache-control')).toBe('no-cache')
    expect(conditionalEmptyPage.headers.get('etag')).toBe(
      `W/"regesta.object-inventory:${sorted[2]!.digest}:0"`,
    )
    expect(conditionalEmptyPage.headers.get('content-length')).toBeNull()
    expect(await conditionalEmptyPage.text()).toBe('')
    expect(missingCursor.status).toBe(404)
    await expect(missingCursor.json()).resolves.toMatchObject({
      code: 'object_cursor_not_found',
    })
    expect(getDescriptor).not.toHaveBeenCalled()
    expect(invalidQuery.status).toBe(400)
    await expect(invalidQuery.json()).resolves.toMatchObject({
      error: 'Invalid object inventory query',
    })
  })

  it('validates adapter object inventory descriptors before serving pages', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const adapters = createMemoryRegistryAdapters()
    const descriptor = await adapters.objects.put(
      bytes('object inventory boundary'),
      'text/plain',
    )
    const invalidDescriptor = {
      ...descriptor,
      size: -1,
    }
    adapters.objects.listDescriptors = () =>
      Promise.resolve([invalidDescriptor])
    const app = createRegestaApp(adapters)

    try {
      const response = await app.request('/objects', {
        headers: {
          'x-request-id': 'invalid-adapter-object-inventory-001',
        },
      })

      expect(response.status).toBe(500)
      await expect(response.json()).resolves.toEqual({
        code: 'internal_server_error',
        error: 'Internal Server Error',
        message: 'Internal Server Error',
      })
      expect(consoleError).toHaveBeenCalledWith(
        'Unexpected transport error',
        expect.objectContaining({
          error: expect.objectContaining({
            message:
              'Adapter object inventory objects[0] size must be a non-negative safe integer',
          }),
          kind: 'regesta.unexpected-error',
          requestId: 'invalid-adapter-object-inventory-001',
        }),
      )
    } finally {
      consoleError.mockRestore()
    }
  })

  it('supports object HEAD requests without downloading bytes', async () => {
    const adapters = createMemoryRegistryAdapters()
    const app = createRegestaApp(adapters)
    const descriptor = await adapters.objects.put(
      bytes('object bytes'),
      'application/octet-stream',
    )
    const [algorithm, hex] = descriptor.digest.split(':')
    const digestGet = await app.request(`/objects/${descriptor.digest}`)

    const digestHead = await app.request(`/objects/${descriptor.digest}`, {
      method: 'HEAD',
    })
    const partsHead = await app.request(`/objects/${algorithm}/${hex}`, {
      method: 'HEAD',
    })
    const conditionalGet = await app.request(`/objects/${descriptor.digest}`, {
      headers: {
        'if-none-match': `W/"${descriptor.digest}"`,
      },
    })
    const conditionalHead = await app.request(`/objects/${descriptor.digest}`, {
      headers: {
        'if-none-match': `"${descriptor.digest}"`,
      },
      method: 'HEAD',
    })
    const rangeGet = await app.request(`/objects/${descriptor.digest}`, {
      headers: {
        range: 'bytes=0-5',
      },
    })
    const invalidRange = await app.request(`/objects/${descriptor.digest}`, {
      headers: {
        range: 'bytes=100-200',
      },
    })

    expect(digestGet.status).toBe(200)
    expect(digestGet.headers.get('accept-ranges')).toBe('bytes')
    expect(digestGet.headers.get('content-length')).toBe(
      String(descriptor.size),
    )
    expect(digestGet.headers.get('content-type')).toBe(descriptor.mediaType)
    expect(digestGet.headers.get('cache-control')).toBe(
      'public, max-age=31536000, immutable',
    )
    expect(digestGet.headers.get('etag')).toBe(`"${descriptor.digest}"`)
    expect(await digestGet.text()).toBe('object bytes')
    expect(digestHead.status).toBe(200)
    expect(digestHead.headers.get('accept-ranges')).toBe('bytes')
    expect(digestHead.headers.get('content-length')).toBe(
      String(descriptor.size),
    )
    expect(digestHead.headers.get('content-type')).toBe(descriptor.mediaType)
    expect(digestHead.headers.get('cache-control')).toBe(
      'public, max-age=31536000, immutable',
    )
    expect(digestHead.headers.get('etag')).toBe(`"${descriptor.digest}"`)
    expect(await digestHead.text()).toBe('')
    expect(partsHead.status).toBe(200)
    expect(partsHead.headers.get('accept-ranges')).toBe('bytes')
    expect(partsHead.headers.get('content-length')).toBe(
      String(descriptor.size),
    )
    expect(partsHead.headers.get('content-type')).toBe(descriptor.mediaType)
    expect(partsHead.headers.get('cache-control')).toBe(
      'public, max-age=31536000, immutable',
    )
    expect(partsHead.headers.get('etag')).toBe(`"${descriptor.digest}"`)
    expect(await partsHead.text()).toBe('')
    expect(conditionalGet.status).toBe(304)
    expect(conditionalGet.headers.get('accept-ranges')).toBe('bytes')
    expect(conditionalGet.headers.get('cache-control')).toBe(
      'public, max-age=31536000, immutable',
    )
    expect(conditionalGet.headers.get('etag')).toBe(`"${descriptor.digest}"`)
    expect(conditionalGet.headers.get('content-length')).toBeNull()
    expect(await conditionalGet.text()).toBe('')
    expect(conditionalHead.status).toBe(304)
    expect(conditionalHead.headers.get('accept-ranges')).toBe('bytes')
    expect(conditionalHead.headers.get('cache-control')).toBe(
      'public, max-age=31536000, immutable',
    )
    expect(conditionalHead.headers.get('etag')).toBe(`"${descriptor.digest}"`)
    expect(conditionalHead.headers.get('content-length')).toBeNull()
    expect(await conditionalHead.text()).toBe('')
    expect(rangeGet.status).toBe(206)
    expect(rangeGet.headers.get('accept-ranges')).toBe('bytes')
    expect(rangeGet.headers.get('content-range')).toBe(
      `bytes 0-5/${descriptor.size}`,
    )
    expect(rangeGet.headers.get('content-length')).toBe('6')
    expect(await rangeGet.text()).toBe('object')
    expect(invalidRange.status).toBe(416)
    expect(invalidRange.headers.get('accept-ranges')).toBe('bytes')
    expect(invalidRange.headers.get('content-range')).toBe(
      `bytes */${descriptor.size}`,
    )
    expect(await invalidRange.text()).toBe('')
  })

  it('serves object HEAD and conditional reads without loading object bytes', async () => {
    const adapters = createMemoryRegistryAdapters()
    const descriptor = await adapters.objects.put(
      bytes('large object bytes'),
      'application/octet-stream',
    )
    const getObject = adapters.objects.get.bind(adapters.objects)
    let objectGetCalls = 0
    adapters.objects.get = (digest) => {
      objectGetCalls += 1
      return getObject(digest)
    }
    const app = createRegestaApp(adapters)

    const head = await app.request(`/objects/${descriptor.digest}`, {
      method: 'HEAD',
    })
    const rangeHead = await app.request(`/objects/${descriptor.digest}`, {
      headers: {
        range: 'bytes=6-11',
      },
      method: 'HEAD',
    })
    const invalidRangeHead = await app.request(
      `/objects/${descriptor.digest}`,
      {
        headers: {
          range: 'bytes=100-200',
        },
        method: 'HEAD',
      },
    )
    const conditional = await app.request(`/objects/${descriptor.digest}`, {
      headers: {
        'if-none-match': `"${descriptor.digest}"`,
      },
    })
    const invalidRangeGet = await app.request(`/objects/${descriptor.digest}`, {
      headers: {
        range: 'bytes=100-200',
      },
    })

    expect(head.status).toBe(200)
    expect(head.headers.get('accept-ranges')).toBe('bytes')
    expect(head.headers.get('content-length')).toBe(String(descriptor.size))
    expect(await head.text()).toBe('')
    expect(rangeHead.status).toBe(206)
    expect(rangeHead.headers.get('accept-ranges')).toBe('bytes')
    expect(rangeHead.headers.get('content-length')).toBe('6')
    expect(rangeHead.headers.get('content-range')).toBe(
      `bytes 6-11/${descriptor.size}`,
    )
    expect(await rangeHead.text()).toBe('')
    expect(invalidRangeHead.status).toBe(416)
    expect(invalidRangeHead.headers.get('accept-ranges')).toBe('bytes')
    expect(invalidRangeHead.headers.get('content-range')).toBe(
      `bytes */${descriptor.size}`,
    )
    expect(await invalidRangeHead.text()).toBe('')
    expect(conditional.status).toBe(304)
    expect(conditional.headers.get('accept-ranges')).toBe('bytes')
    expect(await conditional.text()).toBe('')
    expect(invalidRangeGet.status).toBe(416)
    expect(invalidRangeGet.headers.get('accept-ranges')).toBe('bytes')
    expect(invalidRangeGet.headers.get('content-range')).toBe(
      `bytes */${descriptor.size}`,
    )
    expect(await invalidRangeGet.text()).toBe('')
    expect(objectGetCalls).toBe(0)

    const get = await app.request(`/objects/${descriptor.digest}`)

    expect(get.status).toBe(200)
    expect(await get.text()).toBe('large object bytes')
    expect(objectGetCalls).toBe(1)
  })

  it('validates adapter object descriptors before serving object headers', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const adapters = createMemoryRegistryAdapters()
    const descriptor = await adapters.objects.put(
      bytes('object descriptor boundary'),
      'text/plain',
    )
    adapters.objects.getDescriptor = () =>
      Promise.resolve({
        ...descriptor,
        digest: sha256(bytes('different object descriptor')),
      })
    const app = createRegestaApp(adapters)

    try {
      const response = await app.request(`/objects/${descriptor.digest}`, {
        headers: {
          'x-request-id': 'invalid-adapter-object-descriptor-001',
        },
        method: 'HEAD',
      })

      expect(response.status).toBe(500)
      expect(await response.text()).toBe('')
      expect(consoleError).toHaveBeenCalledWith(
        'Unexpected transport error',
        expect.objectContaining({
          error: expect.objectContaining({
            message: `Adapter object descriptor digest must match requested object digest: ${descriptor.digest}`,
          }),
          kind: 'regesta.unexpected-error',
          requestId: 'invalid-adapter-object-descriptor-001',
        }),
      )
    } finally {
      consoleError.mockRestore()
    }
  })

  it('rejects object reads when descriptor and bytes disagree', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const adapters = createMemoryRegistryAdapters()
    const descriptor = await adapters.objects.put(
      bytes('object bytes'),
      'application/octet-stream',
    )
    const getObject = adapters.objects.get.bind(adapters.objects)
    adapters.objects.get = async (digest) => {
      const object = await getObject(digest)

      return object
        ? {
            ...object,
            descriptor: {
              ...object.descriptor,
              mediaType: 'text/plain',
            },
          }
        : undefined
    }
    const app = createRegestaApp(adapters)

    try {
      const response = await app.request(`/objects/${descriptor.digest}`, {
        headers: {
          'x-request-id': 'object-descriptor-mismatch-001',
        },
      })

      expect(response.status).toBe(500)
      await expect(response.json()).resolves.toEqual({
        code: 'internal_server_error',
        error: 'Internal Server Error',
        message: 'Internal Server Error',
      })
      expect(consoleError).toHaveBeenCalledWith(
        'Unexpected transport error',
        expect.objectContaining({
          error: expect.objectContaining({
            message: `Object descriptor changed while reading: ${descriptor.digest}`,
          }),
          kind: 'regesta.unexpected-error',
          requestId: 'object-descriptor-mismatch-001',
        }),
      )
    } finally {
      consoleError.mockRestore()
    }
  })

  it('rejects object reads when bytes do not match the descriptor digest', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const adapters = createMemoryRegistryAdapters()
    const descriptor = await adapters.objects.put(
      bytes('object bytes'),
      'application/octet-stream',
    )
    const getObject = adapters.objects.get.bind(adapters.objects)
    adapters.objects.get = async (digest) => {
      const object = await getObject(digest)

      return object
        ? {
            ...object,
            bytes: bytes('tampered bytes'),
          }
        : undefined
    }
    const app = createRegestaApp(adapters)

    try {
      const response = await app.request(`/objects/${descriptor.digest}`, {
        headers: {
          'x-request-id': 'object-bytes-mismatch-001',
        },
      })

      expect(response.status).toBe(500)
      await expect(response.json()).resolves.toEqual({
        code: 'internal_server_error',
        error: 'Internal Server Error',
        message: 'Internal Server Error',
      })
      expect(consoleError).toHaveBeenCalledWith(
        'Unexpected transport error',
        expect.objectContaining({
          error: expect.objectContaining({
            message: `Object byte length changed while reading: ${descriptor.digest}`,
          }),
          kind: 'regesta.unexpected-error',
          requestId: 'object-bytes-mismatch-001',
        }),
      )
    } finally {
      consoleError.mockRestore()
    }
  })

  it('reads events by digest', async () => {
    const adapters = createMemoryRegistryAdapters()
    const app = createRegestaApp(adapters)
    const packageId = 'npm:example.com/event-regesta'
    const publish = await publishRelease(
      {
        artifacts: [
          {
            bytes: bytes('install artifact'),
            format: 'npm-tarball',
            mediaType: 'application/gzip',
            role: 'install',
          },
        ],
        config: {
          id: packageId,
          source: {
            include: ['regesta.json'],
          },
          version: '0.0.1',
        },
        createdAt: '2026-06-01T00:00:00.000Z',
        source: bytes('source archive'),
      },
      adapters,
    )
    const [algorithm, hex] = publish.event.id.split(':')

    const response = await app.request(`/events/${algorithm}/${hex}`)
    const head = await app.request(`/events/${algorithm}/${hex}`, {
      method: 'HEAD',
    })
    const conditional = await app.request(`/events/${algorithm}/${hex}`, {
      headers: {
        'if-none-match': `"${publish.event.id}"`,
      },
    })
    const conditionalHead = await app.request(`/events/${algorithm}/${hex}`, {
      headers: {
        'if-none-match': `W/"${publish.event.id}"`,
      },
      method: 'HEAD',
    })
    const missing = await app.request(`/events/sha256/${'0'.repeat(64)}`)
    const invalid = await app.request(`/events/sha512/${hex}`)
    const eventText = await response.text()

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe(
      'public, max-age=31536000, immutable',
    )
    expect(response.headers.get('content-length')).toBe(
      String(bytes(`${canonicalJson(publish.event)}\n`).byteLength),
    )
    expect(response.headers.get('content-type')).toBe(
      'application/json; charset=utf-8',
    )
    expect(response.headers.get('etag')).toBe(`W/"${publish.event.id}"`)
    expect(eventText).toBe(`${canonicalJson(publish.event)}\n`)
    expect(JSON.parse(eventText)).toMatchObject({
      eventType: 'release.published',
      id: publish.event.id,
      release: {
        id: packageId,
        version: '0.0.1',
      },
    })
    expect(head.status).toBe(200)
    expect(head.headers.get('cache-control')).toBe(
      'public, max-age=31536000, immutable',
    )
    expect(head.headers.get('content-type')).toBe(
      'application/json; charset=utf-8',
    )
    expect(head.headers.get('etag')).toBe(`W/"${publish.event.id}"`)
    expect(await head.text()).toBe('')
    expect(conditional.status).toBe(304)
    expect(conditional.headers.get('cache-control')).toBe(
      'public, max-age=31536000, immutable',
    )
    expect(conditional.headers.get('etag')).toBe(`W/"${publish.event.id}"`)
    expect(conditional.headers.get('content-length')).toBeNull()
    expect(await conditional.text()).toBe('')
    expect(conditionalHead.status).toBe(304)
    expect(conditionalHead.headers.get('cache-control')).toBe(
      'public, max-age=31536000, immutable',
    )
    expect(conditionalHead.headers.get('etag')).toBe(`W/"${publish.event.id}"`)
    expect(conditionalHead.headers.get('content-length')).toBeNull()
    expect(await conditionalHead.text()).toBe('')
    expect(missing.status).toBe(404)
    await expect(missing.json()).resolves.toMatchObject({
      code: 'event_not_found',
      error: 'Event not found',
      message: 'Event not found',
    })
    expect(invalid.status).toBe(400)
    await expect(invalid.json()).resolves.toMatchObject({
      error: 'Invalid event digest',
    })
  })

  it('validates adapter event ids before serving events by digest', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const adapters = createMemoryRegistryAdapters()
    const packageId = 'npm:example.com/event-id-boundary'
    const first = await publishRelease(
      {
        artifacts: [
          {
            bytes: bytes('first install artifact'),
            mediaType: 'application/gzip',
            role: 'install',
          },
        ],
        config: {
          id: packageId,
          source: {
            include: ['regesta.json'],
          },
          version: '0.0.1',
        },
        createdAt: '2026-06-01T00:00:00.000Z',
        source: bytes('first source archive'),
      },
      adapters,
    )
    const second = await publishRelease(
      {
        artifacts: [
          {
            bytes: bytes('second install artifact'),
            mediaType: 'application/gzip',
            role: 'install',
          },
        ],
        config: {
          id: packageId,
          source: {
            include: ['regesta.json'],
          },
          version: '0.0.2',
        },
        createdAt: '2026-06-01T00:01:00.000Z',
        source: bytes('second source archive'),
      },
      adapters,
    )
    adapters.database.getEvent = () => Promise.resolve(second.event)
    const [algorithm, hex] = first.event.id.split(':')
    const app = createRegestaApp(adapters)

    try {
      const response = await app.request(`/events/${algorithm}/${hex}`, {
        headers: {
          'x-request-id': 'mismatched-adapter-event-001',
        },
      })

      expect(response.status).toBe(500)
      await expect(response.json()).resolves.toEqual({
        code: 'internal_server_error',
        error: 'Internal Server Error',
        message: 'Internal Server Error',
      })
      expect(consoleError).toHaveBeenCalledWith(
        'Unexpected transport error',
        expect.objectContaining({
          error: expect.objectContaining({
            message: `Adapter registry event id must match requested event id: ${first.event.id}`,
          }),
          kind: 'regesta.unexpected-error',
          requestId: 'mismatched-adapter-event-001',
        }),
      )
    } finally {
      consoleError.mockRestore()
    }
  })

  it('reads event log pages by event cursor', async () => {
    const adapters = createMemoryRegistryAdapters()
    const app = createRegestaApp(adapters)
    const first = await publishRelease(
      {
        artifacts: [
          {
            bytes: bytes('first install artifact'),
            format: 'npm-tarball',
            mediaType: 'application/gzip',
            role: 'install',
          },
        ],
        config: {
          id: 'npm:example.com/event-pages',
          source: {
            include: ['regesta.json'],
          },
          version: '0.0.1',
        },
        createdAt: '2026-06-01T00:00:00.000Z',
        source: bytes('first source archive'),
      },
      adapters,
    )
    const second = await publishRelease(
      {
        artifacts: [
          {
            bytes: bytes('second install artifact'),
            format: 'npm-tarball',
            mediaType: 'application/gzip',
            role: 'install',
          },
        ],
        config: {
          id: 'npm:example.com/event-pages',
          source: {
            include: ['regesta.json'],
          },
          version: '0.0.2',
        },
        createdAt: '2026-06-01T00:01:00.000Z',
        source: bytes('second source archive'),
      },
      adapters,
    )
    const getEvent = vi.fn(() => {
      throw new Error('event log pages should not preflight cursors')
    })
    adapters.database.getEvent = getEvent

    const fullPage = await app.request('/events')
    const firstPage = await app.request('/events?limit=1')
    const firstPageHead = await app.request('/events?limit=1', {
      method: 'HEAD',
    })
    const conditionalFirstPage = await app.request('/events?limit=1', {
      headers: {
        'if-none-match': `"regesta.event-log:${first.event.id}:1"`,
      },
    })
    const conditionalFirstPageHead = await app.request('/events?limit=1', {
      headers: {
        'if-none-match': `W/"regesta.event-log:${first.event.id}:1"`,
      },
      method: 'HEAD',
    })
    const secondPage = await app.request(
      `/events?after=${encodeURIComponent(first.event.id)}&limit=1`,
    )
    const emptyPage = await app.request(
      `/events?after=${encodeURIComponent(second.event.id)}&limit=1`,
    )
    const conditionalEmptyPage = await app.request(
      `/events?after=${encodeURIComponent(second.event.id)}&limit=1`,
      {
        headers: {
          'if-none-match': `W/"regesta.event-log:${second.event.id}:0"`,
        },
      },
    )
    const conditionalEmptyPageHead = await app.request(
      `/events?after=${encodeURIComponent(second.event.id)}&limit=1`,
      {
        headers: {
          'if-none-match': `"regesta.event-log:${second.event.id}:0"`,
        },
        method: 'HEAD',
      },
    )
    const missingCursor = await app.request(
      `/events?after=${encodeURIComponent(
        sha256(bytes('missing event cursor')),
      )}&limit=1`,
    )
    const invalid = await app.request('/events?limit=0')

    expect(fullPage.status).toBe(200)
    await expect(fullPage.json()).resolves.toEqual({
      events: [
        expect.objectContaining({
          id: first.event.id,
        }),
        expect.objectContaining({
          id: second.event.id,
        }),
      ],
      nextAfter: second.event.id,
    })
    expect(firstPage.status).toBe(200)
    expect(firstPage.headers.get('cache-control')).toBe('no-cache')
    expect(firstPage.headers.get('etag')).toBe(
      `W/"regesta.event-log:${first.event.id}:1"`,
    )
    const firstPageText = await firstPage.clone().text()
    expect(firstPage.headers.get('content-length')).toBe(
      String(Buffer.byteLength(firstPageText)),
    )
    await expect(firstPage.json()).resolves.toEqual({
      events: [
        expect.objectContaining({
          id: first.event.id,
        }),
      ],
      nextAfter: first.event.id,
    })
    expect(firstPageHead.status).toBe(200)
    expect(firstPageHead.headers.get('cache-control')).toBe('no-cache')
    expect(firstPageHead.headers.get('etag')).toBe(
      `W/"regesta.event-log:${first.event.id}:1"`,
    )
    expect(firstPageHead.headers.get('content-length')).toBe(
      String(Buffer.byteLength(firstPageText)),
    )
    expect(await firstPageHead.text()).toBe('')
    expect(conditionalFirstPage.status).toBe(304)
    expect(conditionalFirstPage.headers.get('cache-control')).toBe('no-cache')
    expect(conditionalFirstPage.headers.get('etag')).toBe(
      `W/"regesta.event-log:${first.event.id}:1"`,
    )
    expect(conditionalFirstPage.headers.get('content-length')).toBeNull()
    expect(await conditionalFirstPage.text()).toBe('')
    expect(conditionalFirstPageHead.status).toBe(304)
    expect(conditionalFirstPageHead.headers.get('cache-control')).toBe(
      'no-cache',
    )
    expect(conditionalFirstPageHead.headers.get('etag')).toBe(
      `W/"regesta.event-log:${first.event.id}:1"`,
    )
    expect(conditionalFirstPageHead.headers.get('content-length')).toBeNull()
    expect(await conditionalFirstPageHead.text()).toBe('')
    expect(secondPage.status).toBe(200)
    await expect(secondPage.json()).resolves.toEqual({
      events: [
        expect.objectContaining({
          id: second.event.id,
        }),
      ],
      nextAfter: second.event.id,
    })
    expect(emptyPage.status).toBe(200)
    const emptyPageText = await emptyPage.clone().text()
    expect(emptyPage.headers.get('content-length')).toBe(
      String(Buffer.byteLength(emptyPageText)),
    )
    await expect(emptyPage.json()).resolves.toEqual({
      events: [],
    })
    expect(emptyPage.headers.get('cache-control')).toBe('no-cache')
    expect(emptyPage.headers.get('etag')).toBe(
      `W/"regesta.event-log:${second.event.id}:0"`,
    )
    expect(conditionalEmptyPage.status).toBe(304)
    expect(conditionalEmptyPage.headers.get('cache-control')).toBe('no-cache')
    expect(conditionalEmptyPage.headers.get('etag')).toBe(
      `W/"regesta.event-log:${second.event.id}:0"`,
    )
    expect(conditionalEmptyPage.headers.get('content-length')).toBeNull()
    expect(await conditionalEmptyPage.text()).toBe('')
    expect(conditionalEmptyPageHead.status).toBe(304)
    expect(conditionalEmptyPageHead.headers.get('cache-control')).toBe(
      'no-cache',
    )
    expect(conditionalEmptyPageHead.headers.get('etag')).toBe(
      `W/"regesta.event-log:${second.event.id}:0"`,
    )
    expect(conditionalEmptyPageHead.headers.get('content-length')).toBeNull()
    expect(await conditionalEmptyPageHead.text()).toBe('')
    expect(missingCursor.status).toBe(404)
    await expect(missingCursor.json()).resolves.toMatchObject({
      code: 'event_cursor_not_found',
      error: 'Event cursor not found',
      message: 'Event cursor not found',
    })
    expect(getEvent).not.toHaveBeenCalled()
    expect(invalid.status).toBe(400)
    await expect(invalid.json()).resolves.toMatchObject({
      error: 'Invalid event log query',
    })
  })

  it('validates adapter event log entries before serving event log pages', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const adapters = createMemoryRegistryAdapters()
    const publish = await publishRelease(
      {
        artifacts: [
          {
            bytes: bytes('install artifact'),
            mediaType: 'application/gzip',
            role: 'install',
          },
        ],
        config: {
          id: 'npm:example.com/event-log-boundary',
          source: {
            include: ['regesta.json'],
          },
          version: '0.0.1',
        },
        createdAt: '2026-06-01T00:00:00.000Z',
        source: bytes('source archive'),
      },
      adapters,
    )
    const invalidEvent = structuredClone(publish.event)
    Object.defineProperty(invalidEvent, 'object', {
      configurable: true,
      value: 'regesta.broken-event',
    })
    adapters.database.listEvents = () => Promise.resolve([invalidEvent])
    const app = createRegestaApp(adapters)

    try {
      const response = await app.request('/events', {
        headers: {
          'x-request-id': 'invalid-adapter-event-log-001',
        },
      })

      expect(response.status).toBe(500)
      await expect(response.json()).resolves.toEqual({
        code: 'internal_server_error',
        error: 'Internal Server Error',
        message: 'Internal Server Error',
      })
      expect(consoleError).toHaveBeenCalledWith(
        'Unexpected transport error',
        expect.objectContaining({
          error: expect.objectContaining({
            message: 'Adapter event log events[0] object must be regesta.event',
          }),
          kind: 'regesta.unexpected-error',
          requestId: 'invalid-adapter-event-log-001',
        }),
      )
    } finally {
      consoleError.mockRestore()
    }
  })

  it('bounds event log reads when clients omit page limits', async () => {
    const adapters = createMemoryRegistryAdapters()
    let listOptions: unknown
    adapters.database.listEvents = (options) => {
      listOptions = options
      return Promise.resolve([])
    }
    const app = createRegestaApp(adapters)
    const response = await app.request('/events')

    expect(response.status).toBe(200)
    expect(listOptions).toEqual({
      after: undefined,
      limit: 999,
    })
    await expect(response.json()).resolves.toEqual({
      events: [],
    })
  })

  it('returns 400 for invalid publish multipart JSON', async () => {
    const app = createRegestaApp(createMemoryRegistryAdapters())
    const form = new FormData()
    form.set('config', '{')
    form.set('artifacts', '[]')
    form.set('source', new File(['source'], 'source.tgz'))
    const response = await app.request('/releases', {
      body: form,
      method: 'POST',
    })

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      error: 'Invalid config JSON',
    })
  })

  it('returns 400 for malformed publish multipart bodies', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const app = createRegestaApp(createMemoryRegistryAdapters())

    try {
      const response = await app.request('/releases', {
        body: '--not-the-declared-boundary\r\n',
        headers: {
          'content-type': 'multipart/form-data; boundary=regesta-boundary',
        },
        method: 'POST',
      })

      expect(response.status).toBe(400)
      await expect(response.json()).resolves.toMatchObject({
        code: 'request_invalid',
        error: 'Invalid form request body',
        message: 'Invalid form request body',
      })
      expect(consoleError).not.toHaveBeenCalled()
    } finally {
      consoleError.mockRestore()
    }
  })

  it('rejects publish source files over the configured byte limit', async () => {
    const app = createRegestaApp(createMemoryRegistryAdapters(), {
      publishUploadLimits: {
        sourceBytes: 3,
      },
    })
    const form = new FormData()

    form.set(
      'config',
      JSON.stringify({
        id: 'demo:dev.localhost/source-too-large',
        source: {
          include: ['regesta.json'],
        },
        version: '0.0.1',
      }),
    )
    form.set(
      'artifacts',
      JSON.stringify([
        {
          mediaType: 'application/octet-stream',
          part: 'artifact.install',
          role: 'install',
        },
      ]),
    )
    form.set('artifact.install', new File(['ok'], 'artifact.bin'))
    form.set('source', new File(['source'], 'source.tgz'))

    const response = await app.request('/releases', {
      body: form,
      method: 'POST',
    })

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      code: 'request_invalid',
      error: 'Publish request field source is too large',
      issues: ['source: Must be at most 3 bytes'],
    })
  })

  it('rejects publish artifacts over the configured byte limit', async () => {
    const app = createRegestaApp(createMemoryRegistryAdapters(), {
      publishUploadLimits: {
        artifactBytes: 3,
      },
    })
    const form = new FormData()

    form.set(
      'config',
      JSON.stringify({
        id: 'demo:dev.localhost/artifact-too-large',
        source: {
          include: ['regesta.json'],
        },
        version: '0.0.1',
      }),
    )
    form.set(
      'artifacts',
      JSON.stringify([
        {
          mediaType: 'application/octet-stream',
          part: 'artifact.install',
          role: 'install',
        },
      ]),
    )
    form.set('artifact.install', new File(['artifact'], 'artifact.bin'))
    form.set('source', new File(['source'], 'source.tgz'))

    const response = await app.request('/releases', {
      body: form,
      method: 'POST',
    })

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      code: 'request_invalid',
      error: 'Publish request field artifact.install is too large',
      issues: ['artifact.install: Must be at most 3 bytes'],
    })
  })

  it('returns 400 for invalid artifact compatibility metadata', async () => {
    const app = createRegestaApp(createMemoryRegistryAdapters())
    const form = new FormData()

    form.set(
      'config',
      JSON.stringify({
        id: 'demo:dev.localhost/invalid-compatibility',
        source: {
          include: ['regesta.json'],
        },
        version: '0.0.1',
      }),
    )
    form.set(
      'artifacts',
      JSON.stringify([
        {
          compatibility: {
            runtimes: [1],
          },
          mediaType: 'application/octet-stream',
          part: 'artifact.install',
          role: 'install',
        },
      ]),
    )
    form.set('artifact.install', new File(['artifact'], 'artifact.bin'))

    const response = await app.request('/releases', {
      body: form,
      method: 'POST',
    })

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      error: 'Invalid artifacts',
    })
  })

  it('returns 400 when publish artifact mediaType is missing', async () => {
    const app = createRegestaApp(createMemoryRegistryAdapters())
    const form = new FormData()

    form.set(
      'config',
      JSON.stringify({
        id: 'demo:dev.localhost/missing-artifact-media-type',
        source: {
          include: ['regesta.json'],
        },
        version: '0.0.1',
      }),
    )
    form.set(
      'artifacts',
      JSON.stringify([
        {
          part: 'artifact.install',
          role: 'install',
        },
      ]),
    )
    form.set('artifact.install', new File(['artifact'], 'artifact.bin'))

    const response = await app.request('/releases', {
      body: form,
      method: 'POST',
    })

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      error: 'Invalid artifacts',
      issues: [
        '0.mediaType: Invalid key: Expected "mediaType" but received undefined',
      ],
    })
  })

  it('rejects unsafe publish artifact descriptor strings', async () => {
    const app = createRegestaApp(createMemoryRegistryAdapters())
    const form = new FormData()

    form.set(
      'config',
      JSON.stringify({
        id: 'demo:dev.localhost/unsafe-artifact-descriptor',
        source: {
          include: ['regesta.json'],
        },
        version: '0.0.1',
      }),
    )
    form.set(
      'artifacts',
      JSON.stringify([
        {
          filename: 'artifact.bin',
          format: 'demo',
          mediaType: 'application/octet-stream',
          part: 'artifact.install',
          role: 'install\r\nx',
        },
      ]),
    )
    form.set('artifact.install', new File(['artifact'], 'artifact.bin'))

    const response = await app.request('/releases', {
      body: form,
      method: 'POST',
    })

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      error: 'Invalid artifacts',
      issues: ['artifact role must not include control characters'],
    })
  })

  it('rejects unknown artifact compatibility fields', async () => {
    const app = createRegestaApp(createMemoryRegistryAdapters())
    const form = new FormData()

    form.set(
      'config',
      JSON.stringify({
        id: 'demo:dev.localhost/unknown-compatibility',
        source: {
          include: ['regesta.json'],
        },
        version: '0.0.1',
      }),
    )
    form.set(
      'artifacts',
      JSON.stringify([
        {
          compatibility: {
            ecosystems: ['npm'],
          },
          mediaType: 'application/octet-stream',
          part: 'artifact.install',
          role: 'install',
        },
      ]),
    )
    form.set('artifact.install', new File(['artifact'], 'artifact.bin'))

    const response = await app.request('/releases', {
      body: form,
      method: 'POST',
    })

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      error: 'Invalid artifacts',
      issues: [
        '0.compatibility.ecosystems: Invalid key: Expected never but received "ecosystems"',
      ],
    })
  })

  it('rejects client-supplied ecosystem metadata in publish artifact descriptors', async () => {
    const app = createRegestaApp(createMemoryRegistryAdapters())
    const form = new FormData()

    form.set(
      'config',
      JSON.stringify({
        id: 'npm:dev.localhost/client-metadata',
        source: {
          include: ['regesta.json'],
        },
        version: '0.0.1',
      }),
    )
    form.set(
      'artifacts',
      JSON.stringify([
        {
          ecosystemMetadata: {
            npm: {
              dependencies: {
                leftpad: '*',
              },
            },
          },
          mediaType: 'application/octet-stream',
          part: 'artifact.install',
          role: 'install',
        },
      ]),
    )
    form.set('artifact.install', new File(['artifact'], 'artifact.bin'))

    const response = await app.request('/releases', {
      body: form,
      method: 'POST',
    })

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      error: 'Invalid artifacts',
      issues: [
        '0.ecosystemMetadata: Invalid key: Expected never but received "ecosystemMetadata"',
      ],
    })
  })

  it('returns 400 for malformed npm install artifacts', async () => {
    const app = createRegestaApp(createMemoryRegistryAdapters())
    const auth = createTestDomainAuth()
    const form = new FormData()
    const brokenGzip = new Uint8Array([0x1f, 0x8b, 0x08, 0x00])
    const config: RegestaConfig = {
      id: 'npm:example.com/malformed-artifact',
      provenance: {
        level: 'source-attached',
      },
      source: {
        include: ['regesta.json'],
      },
      version: '0.0.1',
    }
    const source = bytes('source')
    const artifacts = [
      {
        bytes: brokenGzip,
        format: 'npm-tarball',
        mediaType: 'application/gzip',
        role: 'install',
      },
    ]

    form.set('config', JSON.stringify(config))
    form.set(
      'authorization',
      JSON.stringify(
        createSignedPublishAuthorization({
          artifacts,
          auth,
          config,
          nonce: 'malformed-artifact-nonce',
          source,
        }),
      ),
    )
    form.set('source', new File([blobPart(source)], 'source.tgz'))
    form.set(
      'artifacts',
      JSON.stringify([
        {
          format: 'npm-tarball',
          mediaType: 'application/gzip',
          part: 'artifact.install',
          role: 'install',
        },
      ]),
    )
    form.set('artifact.install', new File([brokenGzip], 'package.tgz'))

    const response = await app.request('/releases', {
      body: form,
      method: 'POST',
    })

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      error: 'npm install artifact must be a readable tarball',
    })
  })

  it('publishes non-npm install artifacts without applying npm tarball rules', async () => {
    const app = createRegestaApp(createMemoryRegistryAdapters())
    const auth = createTestDomainAuth()
    const timestamp = new Date().toISOString()
    const source = bytes('source archive')
    const artifacts = [
      {
        bytes: new Uint8Array([0x1f, 0x8b, 0x08, 0x00]),
        format: 'generic-archive',
        mediaType: 'application/gzip',
        role: 'install',
      },
    ]
    const config: RegestaConfig = {
      id: 'demo:example.com/raw-gzip',
      provenance: {
        level: 'source-attached',
      },
      source: {
        include: ['regesta.json'],
      },
      version: '0.0.1',
    }
    const normalizedConfig = normalizeRegestaConfig(config)
    const form = new FormData()

    form.set('config', JSON.stringify(config))
    form.set(
      'authorization',
      JSON.stringify(
        auth.sign(
          createReleasePublishIntent({
            artifactDescriptorDigest:
              publishArtifactDescriptorDigest(artifacts),
            artifactDigests: artifacts.map((artifact) =>
              sha256(artifact.bytes),
            ),
            configDigest: configDigest(normalizedConfig),
            nonce: 'non-npm-raw-gzip',
            packageId: normalizedConfig.id,
            sourceDigest: sha256(source),
            timestamp,
            version: normalizedConfig.version,
          }),
        ),
      ),
    )
    form.set('createdAt', timestamp)
    form.set('source', new File([blobPart(source)], 'source.tgz'))
    form.set(
      'artifacts',
      JSON.stringify([
        {
          format: 'generic-archive',
          mediaType: 'application/gzip',
          part: 'artifact.install',
          role: 'install',
        },
      ]),
    )
    form.set(
      'artifact.install',
      new File([blobPart(artifacts[0]!.bytes)], 'artifact.tgz', {
        type: 'application/gzip',
      }),
    )

    vi.stubGlobal('fetch', auth.fetch)

    try {
      const response = await app.request('/releases', {
        body: form,
        method: 'POST',
      })
      const body = await response.json()

      expect(response.status).toBe(201)
      expect(body).toMatchObject({
        manifest: {
          artifacts: [
            expect.objectContaining({
              format: 'generic-archive',
              mediaType: 'application/gzip',
              role: 'install',
            }),
          ],
          id: normalizedConfig.id,
        },
      })
      expect(body).not.toMatchObject({
        manifest: {
          artifacts: [
            expect.objectContaining({
              ecosystemMetadata: expect.anything(),
            }),
          ],
        },
      })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('returns 400 for invalid npm package manifests inside install artifacts', async () => {
    const app = createRegestaApp(createMemoryRegistryAdapters())
    const auth = createTestDomainAuth()
    const form = new FormData()
    const config: RegestaConfig = {
      id: 'npm:example.com/invalid-artifact-manifest',
      provenance: {
        level: 'source-attached',
      },
      source: {
        include: ['regesta.json'],
      },
      version: '0.0.1',
    }
    const source = bytes('source')
    const artifactBytes = invalidPackageManifestTarball()
    const artifacts = [
      {
        bytes: artifactBytes,
        format: 'npm-tarball',
        mediaType: 'application/gzip',
        role: 'install',
      },
    ]

    form.set('config', JSON.stringify(config))
    form.set(
      'authorization',
      JSON.stringify(
        createSignedPublishAuthorization({
          artifacts,
          auth,
          config,
          nonce: 'invalid-artifact-manifest-nonce',
          source,
        }),
      ),
    )
    form.set('source', new File([blobPart(source)], 'source.tgz'))
    form.set(
      'artifacts',
      JSON.stringify([
        {
          format: 'npm-tarball',
          mediaType: 'application/gzip',
          part: 'artifact.install',
          role: 'install',
        },
      ]),
    )
    form.set(
      'artifact.install',
      new File([blobPart(artifactBytes)], 'package.tgz'),
    )

    const response = await app.request('/releases', {
      body: form,
      method: 'POST',
    })

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      error: 'npm package.json must be valid JSON',
    })
  })

  it('returns 400 for invalid npm resolver metadata inside install artifacts', async () => {
    const app = createRegestaApp(createMemoryRegistryAdapters())
    const auth = createTestDomainAuth()
    const form = new FormData()
    const config: RegestaConfig = {
      id: 'npm:example.com/invalid-resolver-metadata',
      provenance: {
        level: 'source-attached',
      },
      source: {
        include: ['regesta.json'],
      },
      version: '0.0.1',
    }
    const source = bytes('source')
    const artifactBytes = packageManifestTarball({
      dependencies: {
        '@example.com/base': 1,
      },
      name: '@example.com/invalid-resolver-metadata',
      version: '0.0.1',
    })
    const artifacts = [
      {
        bytes: artifactBytes,
        format: 'npm-tarball',
        mediaType: 'application/gzip',
        role: 'install',
      },
    ]

    form.set('config', JSON.stringify(config))
    form.set(
      'authorization',
      JSON.stringify(
        createSignedPublishAuthorization({
          artifacts,
          auth,
          config,
          nonce: 'invalid-resolver-metadata-nonce',
          source,
        }),
      ),
    )
    form.set('source', new File([blobPart(source)], 'source.tgz'))
    form.set(
      'artifacts',
      JSON.stringify([
        {
          format: 'npm-tarball',
          mediaType: 'application/gzip',
          part: 'artifact.install',
          role: 'install',
        },
      ]),
    )
    form.set(
      'artifact.install',
      new File([blobPart(artifactBytes)], 'package.tgz'),
    )

    const response = await app.request('/releases', {
      body: form,
      method: 'POST',
    })

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      error: 'npm package.json dependencies.@example.com/base must be a string',
    })
  })

  it('returns 400 for invalid channel request bodies', async () => {
    const app = createRegestaApp(createMemoryRegistryAdapters())
    const packageId = encodeURIComponent('npm:example.com/hello-regesta')
    const response = await app.request(
      `/packages/${packageId}/channels/latest`,
      {
        body: JSON.stringify({}),
        headers: {
          'content-type': 'application/json',
        },
        method: 'PUT',
      },
    )

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      error: 'Invalid channel request body',
    })
  })

  it('returns 400 for malformed channel JSON bodies', async () => {
    const app = createRegestaApp(createMemoryRegistryAdapters())
    const packageId = encodeURIComponent('npm:example.com/hello-regesta')

    const update = await app.request(`/packages/${packageId}/channels/latest`, {
      body: '{',
      headers: {
        'content-type': 'application/json',
      },
      method: 'PUT',
    })
    const deletion = await app.request(
      `/packages/${packageId}/channels/latest`,
      {
        body: '{',
        headers: {
          'content-type': 'application/json',
        },
        method: 'DELETE',
      },
    )

    expect(update.status).toBe(400)
    await expect(update.json()).resolves.toMatchObject({
      error: 'Invalid JSON request body',
    })
    expect(deletion.status).toBe(400)
    await expect(deletion.json()).resolves.toMatchObject({
      error: 'Invalid JSON request body',
    })
  })

  it('rejects unknown channel request body fields', async () => {
    const app = createRegestaApp(createMemoryRegistryAdapters())
    const packageId = encodeURIComponent('npm:example.com/hello-regesta')

    const update = await app.request(`/packages/${packageId}/channels/latest`, {
      body: JSON.stringify({
        authorization: {},
        package: 'npm:example.com/other',
        version: '0.0.1',
      }),
      headers: {
        'content-type': 'application/json',
      },
      method: 'PUT',
    })
    const deletion = await app.request(
      `/packages/${packageId}/channels/latest`,
      {
        body: JSON.stringify({
          authorization: {},
          version: '0.0.1',
        }),
        headers: {
          'content-type': 'application/json',
        },
        method: 'DELETE',
      },
    )

    expect(update.status).toBe(400)
    await expect(update.json()).resolves.toMatchObject({
      error: 'Invalid channel request body',
      issues: ['package: Invalid key: Expected never but received "package"'],
    })
    expect(deletion.status).toBe(400)
    await expect(deletion.json()).resolves.toMatchObject({
      error: 'Invalid channel request body',
      issues: ['version: Invalid key: Expected never but received "version"'],
    })
  })

  it('treats encoded package ids as one route segment across core package routes', async () => {
    const adapters = createMemoryRegistryAdapters()
    const app = createRegestaApp(adapters)
    const packageId = 'go:some.dev/releases/pkg'
    const encodedPackageId = encodeURIComponent(packageId)

    const published = await publishRelease(
      {
        artifacts: [
          {
            bytes: bytes('install artifact'),
            format: 'go-module-archive',
            mediaType: 'application/gzip',
            role: 'install',
          },
        ],
        config: {
          id: packageId,
          source: {
            include: ['go.mod'],
          },
          version: '0.0.1',
        },
        createdAt: '2026-06-01T00:00:00.000Z',
        source: bytes('source archive'),
      },
      adapters,
    )

    const state = await app.request(`/packages/${encodedPackageId}`)
    const stateHead = await app.request(`/packages/${encodedPackageId}`, {
      method: 'HEAD',
    })
    const conditionalState = await app.request(
      `/packages/${encodedPackageId}`,
      {
        headers: {
          'if-none-match': `"${published.event.id}"`,
        },
      },
    )
    const release = await app.request(
      `/packages/${encodedPackageId}/releases/0.0.1`,
    )
    const releaseHead = await app.request(
      `/packages/${encodedPackageId}/releases/0.0.1`,
      {
        method: 'HEAD',
      },
    )
    const conditionalRelease = await app.request(
      `/packages/${encodedPackageId}/releases/0.0.1`,
      {
        headers: {
          'if-none-match': `"${published.event.id}"`,
        },
      },
    )
    const channel = await app.request(
      `/packages/${encodedPackageId}/channels/latest`,
    )
    const channelHead = await app.request(
      `/packages/${encodedPackageId}/channels/latest`,
      {
        method: 'HEAD',
      },
    )
    const channelEtag = expectedPackageChannelEtag({
      channel: 'latest',
      packageId,
      releaseEventId: published.event.id,
      version: '0.0.1',
    })
    const conditionalChannel = await app.request(
      `/packages/${encodedPackageId}/channels/latest`,
      {
        headers: {
          'if-none-match': channelEtag,
        },
      },
    )
    const verification = await app.request(
      `/packages/${encodedPackageId}/releases/0.0.1/verification`,
    )
    const expectedReleaseEnvelope = {
      event: published.event,
      manifest: published.manifest,
      manifestDescriptor: published.manifestDescriptor,
    }
    const releaseText = await release.text()

    expect(state.status).toBe(200)
    expect(state.headers.get('cache-control')).toBe('no-cache')
    expect(state.headers.get('content-type')).toBe(
      'application/json; charset=UTF-8',
    )
    expect(state.headers.get('etag')).toBe(`W/"${published.event.id}"`)
    const stateText = await state.clone().text()
    expect(state.headers.get('content-length')).toBe(
      String(Buffer.byteLength(stateText)),
    )
    const stateBody = await state.json()
    expect(stateBody).toMatchObject({
      channels: {
        latest: '0.0.1',
      },
      id: packageId,
      releases: [
        {
          version: '0.0.1',
        },
      ],
    })
    expect(stateHead.status).toBe(200)
    expect(stateHead.headers.get('cache-control')).toBe('no-cache')
    expect(stateHead.headers.get('content-type')).toBe(
      'application/json; charset=UTF-8',
    )
    expect(stateHead.headers.get('content-length')).toBeNull()
    expect(stateHead.headers.get('etag')).toBe(`W/"${published.event.id}"`)
    expect(await stateHead.text()).toBe('')
    expect(conditionalState.status).toBe(304)
    expect(conditionalState.headers.get('cache-control')).toBe('no-cache')
    expect(conditionalState.headers.get('etag')).toBe(
      `W/"${published.event.id}"`,
    )
    expect(conditionalState.headers.get('content-length')).toBeNull()
    expect(await conditionalState.text()).toBe('')
    expect(release.status).toBe(200)
    expect(release.headers.get('cache-control')).toBe(
      'public, max-age=31536000, immutable',
    )
    expect(release.headers.get('content-length')).toBe(
      String(bytes(`${canonicalJson(expectedReleaseEnvelope)}\n`).byteLength),
    )
    expect(release.headers.get('content-type')).toBe(
      'application/json; charset=utf-8',
    )
    expect(release.headers.get('etag')).toBe(`W/"${published.event.id}"`)
    expect(releaseText).toBe(`${canonicalJson(expectedReleaseEnvelope)}\n`)
    expect(JSON.parse(releaseText)).toMatchObject({
      event: {
        id: published.event.id,
      },
      manifest: {
        id: packageId,
        version: '0.0.1',
      },
      manifestDescriptor: {
        digest: published.manifestDescriptor.digest,
      },
    })
    expect(releaseHead.status).toBe(200)
    expect(releaseHead.headers.get('cache-control')).toBe(
      'public, max-age=31536000, immutable',
    )
    expect(releaseHead.headers.get('content-length')).toBe(
      String(bytes(`${canonicalJson(expectedReleaseEnvelope)}\n`).byteLength),
    )
    expect(releaseHead.headers.get('content-type')).toBe(
      'application/json; charset=utf-8',
    )
    expect(releaseHead.headers.get('etag')).toBe(`W/"${published.event.id}"`)
    expect(await releaseHead.text()).toBe('')
    expect(conditionalRelease.status).toBe(304)
    expect(conditionalRelease.headers.get('cache-control')).toBe(
      'public, max-age=31536000, immutable',
    )
    expect(conditionalRelease.headers.get('etag')).toBe(
      `W/"${published.event.id}"`,
    )
    expect(conditionalRelease.headers.get('content-length')).toBeNull()
    expect(await conditionalRelease.text()).toBe('')
    expect(channel.status).toBe(200)
    expect(channel.headers.get('cache-control')).toBe('no-cache')
    expect(channel.headers.get('content-type')).toBe(
      'application/json; charset=UTF-8',
    )
    expect(channel.headers.get('etag')).toBe(channelEtag)
    const channelText = await channel.clone().text()
    expect(channel.headers.get('content-length')).toBe(
      String(Buffer.byteLength(channelText)),
    )
    await expect(channel.json()).resolves.toMatchObject({
      manifest: {
        id: packageId,
        version: '0.0.1',
      },
    })
    expect(channelHead.status).toBe(200)
    expect(channelHead.headers.get('cache-control')).toBe('no-cache')
    expect(channelHead.headers.get('content-type')).toBe(
      'application/json; charset=UTF-8',
    )
    expect(channelHead.headers.get('content-length')).toBe(
      String(Buffer.byteLength(channelText)),
    )
    expect(channelHead.headers.get('etag')).toBe(channelEtag)
    expect(await channelHead.text()).toBe('')
    expect(conditionalChannel.status).toBe(304)
    expect(conditionalChannel.headers.get('cache-control')).toBe('no-cache')
    expect(conditionalChannel.headers.get('etag')).toBe(channelEtag)
    expect(conditionalChannel.headers.get('content-length')).toBeNull()
    expect(await conditionalChannel.text()).toBe('')
    expect(verification.status).toBe(200)
    expect(verification.headers.get('cache-control')).toBe('no-cache')
    expect(verification.headers.get('content-type')).toBe(
      'application/json; charset=UTF-8',
    )
    const verificationText = await verification.clone().text()
    expect(verification.headers.get('content-length')).toBe(
      String(Buffer.byteLength(verificationText)),
    )
    await expect(verification.json()).resolves.toMatchObject({
      manifest: {
        id: packageId,
        version: '0.0.1',
      },
      ok: true,
    })
  })

  it('reads package releases through channels', async () => {
    const adapters = createMemoryRegistryAdapters()
    const app = createRegestaApp(adapters)
    const packageId = 'npm:example.com/hello-regesta'

    const publish = await publishRelease(
      {
        artifacts: [
          {
            bytes: bytes('install artifact'),
            format: 'npm-tarball',
            mediaType: 'application/gzip',
            role: 'install',
          },
        ],
        config: {
          id: packageId,
          source: {
            include: ['regesta.json'],
          },
          version: '0.0.1',
        },
        createdAt: '2026-06-01T00:00:00.000Z',
        source: bytes('source archive'),
      },
      adapters,
    )

    const response = await app.request(
      `/packages/${encodeURIComponent(packageId)}/channels/latest`,
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-cache')
    const etag = expectedPackageChannelEtag({
      channel: 'latest',
      packageId,
      releaseEventId: publish.event.id,
      version: '0.0.1',
    })
    expect(response.headers.get('etag')).toBe(etag)
    await expect(response.json()).resolves.toMatchObject({
      manifest: {
        id: packageId,
        version: '0.0.1',
      },
    })

    const conditional = await app.request(
      `/packages/${encodeURIComponent(packageId)}/channels/latest`,
      {
        headers: {
          'if-none-match': etag,
        },
      },
    )

    expect(conditional.status).toBe(304)
    expect(conditional.headers.get('cache-control')).toBe('no-cache')
    expect(conditional.headers.get('etag')).toBe(etag)
    expect(await conditional.text()).toBe('')
  })

  it('returns uncached verification problem responses', async () => {
    const app = createRegestaApp(createMemoryRegistryAdapters())
    const packageId = 'npm:example.com/missing-regesta'

    const response = await app.request(
      `/packages/${encodeURIComponent(packageId)}/releases/0.0.1/verification`,
    )

    expect(response.status).toBe(422)
    expect(response.headers.get('cache-control')).toBe('no-cache')
    expect(response.headers.get('content-type')).toBe(
      'application/json; charset=UTF-8',
    )
    const text = await response.clone().text()
    expect(response.headers.get('content-length')).toBe(
      String(Buffer.byteLength(text)),
    )
    await expect(response.json()).resolves.toEqual({
      ok: false,
      problems: [`Release not found: ${packageId}@0.0.1`],
    })
  })

  it('serves package state from indexed event state', async () => {
    const adapters = createMemoryRegistryAdapters()
    const app = createRegestaApp(adapters)
    const packageId = 'npm:example.com/package-state-read'
    const publish = await publishRelease(
      {
        artifacts: [
          {
            bytes: bytes('install artifact'),
            mediaType: 'application/gzip',
            role: 'install',
          },
        ],
        config: {
          id: packageId,
          source: {
            include: ['regesta.json'],
          },
          version: '0.0.1',
        },
        createdAt: '2026-06-01T00:00:00.000Z',
        source: bytes('source archive'),
      },
      adapters,
    )
    const channel = await updatePackageChannel(adapters, {
      channel: 'beta',
      packageId,
      timestamp: '2026-06-01T00:01:00.000Z',
      version: '0.0.1',
    })
    const response = await app.request(
      `/packages/${encodeURIComponent(packageId)}`,
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-cache')
    const etag = `W/"${channel.event.id}"`
    expect(response.headers.get('etag')).toBe(etag)
    await expect(response.json()).resolves.toMatchObject({
      channels: {
        beta: '0.0.1',
        latest: '0.0.1',
      },
      id: packageId,
      releases: [
        {
          createdAt: '2026-06-01T00:00:00.000Z',
          manifestDigest: publish.manifestDescriptor.digest,
          version: '0.0.1',
        },
      ],
    })

    const conditional = await app.request(
      `/packages/${encodeURIComponent(packageId)}`,
      {
        headers: {
          'if-none-match': etag,
        },
      },
    )

    expect(conditional.status).toBe(304)
    expect(conditional.headers.get('cache-control')).toBe('no-cache')
    expect(conditional.headers.get('etag')).toBe(etag)
    expect(await conditional.text()).toBe('')

    adapters.database.getPackageEventState = () => {
      throw new Error('package state HEAD must not read full package state')
    }

    const head = await app.request(
      `/packages/${encodeURIComponent(packageId)}`,
      {
        method: 'HEAD',
      },
    )

    expect(head.status).toBe(200)
    expect(head.headers.get('cache-control')).toBe('no-cache')
    expect(head.headers.get('content-type')).toBe(
      'application/json; charset=UTF-8',
    )
    expect(head.headers.get('content-length')).toBeNull()
    expect(head.headers.get('etag')).toBe(etag)
    expect(await head.text()).toBe('')
  })

  it('uses event timestamps as package state conditional fallback metadata', async () => {
    const adapters = createMemoryRegistryAdapters()
    const app = createRegestaApp(adapters)
    const packageId = 'npm:example.com/package-state-timestamp-fallback'
    await publishRelease(
      {
        artifacts: [
          {
            bytes: bytes('install artifact'),
            mediaType: 'application/gzip',
            role: 'install',
          },
        ],
        config: {
          id: packageId,
          source: {
            include: ['regesta.json'],
          },
          version: '0.0.1',
        },
        createdAt: '2026-06-01T00:00:00.000Z',
        source: bytes('source archive'),
      },
      adapters,
    )
    const channel = await updatePackageChannel(adapters, {
      channel: 'beta',
      packageId,
      timestamp: '2026-06-01T00:01:00.000Z',
      version: '0.0.1',
    })
    adapters.database.getPackageEventHead = () =>
      Promise.resolve({
        lastEventId: channel.event.id,
        lastEventTimestamp: channel.event.timestamp,
        releaseCount: 1,
      })
    adapters.database.getPackageEventState = () => {
      throw new Error('conditional package state must not read full state')
    }

    const response = await app.request(
      `/packages/${encodeURIComponent(packageId)}`,
      {
        headers: {
          'if-modified-since': 'Mon, 01 Jun 2026 00:01:00 GMT',
        },
      },
    )

    expect(response.status).toBe(304)
    expect(response.headers.get('cache-control')).toBe('no-cache')
    expect(response.headers.get('etag')).toBe(`W/"${channel.event.id}"`)
    expect(response.headers.get('last-modified')).toBe(
      'Mon, 01 Jun 2026 00:01:00 GMT',
    )
    expect(response.headers.get('content-length')).toBeNull()
    expect(await response.text()).toBe('')
  })

  it('serves missing package state HEAD responses from indexed heads only', async () => {
    const adapters = createMemoryRegistryAdapters()
    adapters.database.getPackageEventState = () => {
      throw new Error('missing package state HEAD must not read full state')
    }
    const app = createRegestaApp(adapters)
    const packageId = 'npm:example.com/missing-package-state-head'

    const response = await app.request(
      `/packages/${encodeURIComponent(packageId)}`,
      {
        method: 'HEAD',
      },
    )

    expect(response.status).toBe(404)
    expect(response.headers.get('cache-control')).toBe('no-cache')
    expect(await response.text()).toBe('')
  })

  it('validates adapter package state at the transport boundary', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const adapters = createMemoryRegistryAdapters()
    const packageId = 'npm:example.com/invalid-adapter-state'
    const eventId = sha256(bytes('invalid adapter state event'))
    adapters.database.getPackageEventState = () => {
      return Promise.resolve({
        lastEventId: eventId,
        lastEventTimestamp: '2026-06-01T00:00:00.000Z',
        state: {
          channels: {
            latest: '9.9.9',
          },
          ecosystem: 'npm',
          id: packageId,
          name: 'example.com/invalid-adapter-state',
          object: 'regesta.package-state',
          releases: [
            {
              createdAt: '2026-06-01T00:00:00.000Z',
              manifestDigest: sha256(bytes('invalid adapter state manifest')),
              version: '1.0.0',
            },
          ],
        },
      })
    }
    const app = createRegestaApp(adapters)

    try {
      const response = await app.request(
        `/packages/${encodeURIComponent(packageId)}`,
        {
          headers: {
            'x-request-id': 'invalid-adapter-package-state-001',
          },
        },
      )

      expect(response.status).toBe(500)
      await expect(response.json()).resolves.toEqual({
        code: 'internal_server_error',
        error: 'Internal Server Error',
        message: 'Internal Server Error',
      })
      expect(consoleError).toHaveBeenCalledWith(
        'Unexpected transport error',
        expect.objectContaining({
          error: expect.objectContaining({
            message:
              'Adapter package state channels latest must target an existing release version: 9.9.9',
          }),
          kind: 'regesta.unexpected-error',
          requestId: 'invalid-adapter-package-state-001',
        }),
      )
    } finally {
      consoleError.mockRestore()
    }
  })

  it('rejects adapter package state for a different package id', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const adapters = createMemoryRegistryAdapters()
    const packageId = 'npm:example.com/requested-package-state'
    adapters.database.getPackageEventState = () => {
      return Promise.resolve({
        state: {
          ecosystem: 'npm',
          id: 'npm:example.com/other-package-state',
          name: 'example.com/other-package-state',
          object: 'regesta.package-state',
          releases: [],
        },
      })
    }
    const app = createRegestaApp(adapters)

    try {
      const response = await app.request(
        `/packages/${encodeURIComponent(packageId)}`,
        {
          headers: {
            'x-request-id': 'mismatched-adapter-package-state-001',
          },
        },
      )

      expect(response.status).toBe(500)
      await expect(response.json()).resolves.toEqual({
        code: 'internal_server_error',
        error: 'Internal Server Error',
        message: 'Internal Server Error',
      })
      expect(consoleError).toHaveBeenCalledWith(
        'Unexpected transport error',
        expect.objectContaining({
          error: expect.objectContaining({
            message:
              'Adapter package state id must match requested package id: npm:example.com/requested-package-state',
          }),
          kind: 'regesta.unexpected-error',
          requestId: 'mismatched-adapter-package-state-001',
        }),
      )
    } finally {
      consoleError.mockRestore()
    }
  })

  it('validates adapter package channels before serving npm dist-tags', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const adapters = createMemoryRegistryAdapters()
    adapters.database.getPackageReleaseHead = () => {
      return Promise.resolve({
        releaseCount: 1,
      })
    }
    adapters.database.getPackageChannels = () => {
      return Promise.resolve({
        latest: '1.0.0\r\nx',
      })
    }
    const app = createRegestaApp(adapters)

    try {
      const response = await app.request(
        'http://npm.registry.test/-/package/@example.com/invalid-dist-tags/dist-tags',
        {
          headers: {
            'x-request-id': 'invalid-adapter-dist-tags-001',
          },
        },
      )

      expect(response.status).toBe(500)
      await expect(response.json()).resolves.toEqual({
        code: 'internal_server_error',
        error: 'Internal Server Error',
        message: 'Internal Server Error',
      })
      expect(consoleError).toHaveBeenCalledWith(
        'Unexpected transport error',
        expect.objectContaining({
          error: expect.objectContaining({
            message:
              'Adapter package channels latest must not include control characters',
          }),
          kind: 'regesta.unexpected-error',
          requestId: 'invalid-adapter-dist-tags-001',
        }),
      )
    } finally {
      consoleError.mockRestore()
    }
  })

  it('serves package channel releases from indexed channel state', async () => {
    const adapters = createMemoryRegistryAdapters()
    const app = createRegestaApp(adapters)
    const packageId = 'npm:example.com/channel-read'
    const publish = await publishRelease(
      {
        artifacts: [
          {
            bytes: bytes('install artifact'),
            mediaType: 'application/gzip',
            role: 'install',
          },
        ],
        config: {
          id: packageId,
          source: {
            include: ['regesta.json'],
          },
          version: '0.0.1',
        },
        createdAt: '2026-06-01T00:00:00.000Z',
        source: bytes('source archive'),
      },
      adapters,
    )
    const response = await app.request(
      `/packages/${encodeURIComponent(packageId)}/channels/latest`,
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-cache')
    expect(response.headers.get('etag')).toBe(
      expectedPackageChannelEtag({
        channel: 'latest',
        packageId,
        releaseEventId: publish.event.id,
        version: '0.0.1',
      }),
    )
    await expect(response.json()).resolves.toMatchObject({
      manifest: {
        id: packageId,
        version: '0.0.1',
      },
    })
  })

  it('validates adapter release envelopes before serving package releases', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const adapters = createMemoryRegistryAdapters()
    const packageId = 'npm:example.com/release-envelope-boundary'
    const publish = await publishRelease(
      {
        artifacts: [
          {
            bytes: bytes('install artifact'),
            mediaType: 'application/gzip',
            role: 'install',
          },
        ],
        config: {
          id: packageId,
          source: {
            include: ['regesta.json'],
          },
          version: '0.0.1',
        },
        createdAt: '2026-06-01T00:00:00.000Z',
        source: bytes('source archive'),
      },
      adapters,
    )
    adapters.database.getRelease = () =>
      Promise.resolve({
        event: publish.event,
        manifest: {
          ...publish.manifest,
          version: '9.9.9',
        },
        manifestDescriptor: publish.manifestDescriptor,
      })
    const app = createRegestaApp(adapters)

    try {
      const response = await app.request(
        `/packages/${encodeURIComponent(packageId)}/releases/0.0.1`,
        {
          headers: {
            'x-request-id': 'invalid-adapter-release-envelope-001',
          },
        },
      )

      expect(response.status).toBe(500)
      await expect(response.json()).resolves.toEqual({
        code: 'internal_server_error',
        error: 'Internal Server Error',
        message: 'Internal Server Error',
      })
      expect(consoleError).toHaveBeenCalledWith(
        'Unexpected transport error',
        expect.objectContaining({
          error: expect.objectContaining({
            message:
              'Adapter release manifest version must match requested version: 0.0.1',
          }),
          kind: 'regesta.unexpected-error',
          requestId: 'invalid-adapter-release-envelope-001',
        }),
      )
    } finally {
      consoleError.mockRestore()
    }
  })

  it('returns 404 for missing package channels', async () => {
    const app = createRegestaApp(createMemoryRegistryAdapters())
    const packageId = encodeURIComponent('npm:example.com/hello-regesta')
    const response = await app.request(`/packages/${packageId}/channels/beta`)

    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toMatchObject({
      error: 'Channel not found',
    })
  })

  it('rejects invalid package channel route parameters', async () => {
    const app = createRegestaApp(createMemoryRegistryAdapters())
    const packageId = encodeURIComponent('npm:example.com/hello-regesta')
    const response = await app.request(
      `/packages/${packageId}/channels/${encodeURIComponent('latest\r\nx')}`,
    )

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      code: 'request_invalid',
      issues: ['Package channel must not include control characters'],
    })
  })

  it('rejects invalid package version route parameters', async () => {
    const app = createRegestaApp(createMemoryRegistryAdapters())
    const packageId = encodeURIComponent('npm:example.com/hello-regesta')
    const response = await app.request(
      `/packages/${packageId}/releases/${encodeURIComponent('0.0.1\r\nx')}`,
    )

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      code: 'request_invalid',
      issues: ['Package version must not include control characters'],
    })
  })

  it('rejects invalid channel update target versions', async () => {
    const app = createRegestaApp(createMemoryRegistryAdapters())
    const packageId = encodeURIComponent('npm:example.com/hello-regesta')
    const response = await app.request(
      `/packages/${packageId}/channels/latest`,
      {
        body: JSON.stringify({
          authorization: {},
          version: '0.0.1\r\nx',
        }),
        headers: {
          'content-type': 'application/json',
        },
        method: 'PUT',
      },
    )

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      code: 'request_invalid',
      issues: ['Package version must not include control characters'],
    })
  })

  it('rejects channel update authorization domains that do not match package owners before domain binding fetch', async () => {
    const adapters = createMemoryRegistryAdapters()
    const getPackageChannelVersion = vi.spyOn(
      adapters.database,
      'getPackageChannelVersion',
    )
    const app = createRegestaApp(adapters)
    const auth = createTestDomainAuth()
    const packageId = 'npm:example.com/channel-update-domain-mismatch'
    const authorization = auth.sign(
      createChannelUpdateIntent({
        channel: 'latest',
        nonce: 'channel-update-domain-mismatch',
        packageId,
        timestamp: new Date().toISOString(),
        version: '0.0.1',
      }),
    )
    const fetchBinding = vi.fn(() =>
      Promise.reject(new Error('domain binding fetch should not be called')),
    )
    vi.stubGlobal('fetch', fetchBinding)

    try {
      const response = await app.request(
        `/packages/${encodeURIComponent(packageId)}/channels/latest`,
        {
          body: JSON.stringify({
            authorization: {
              ...authorization,
              payload: {
                ...authorization.payload,
                domain: 'other.example.com',
              },
            },
            version: '0.0.1',
          }),
          headers: {
            'content-type': 'application/json',
          },
          method: 'PUT',
        },
      )

      expect(response.status).toBe(401)
      await expect(response.json()).resolves.toMatchObject({
        code: 'write_authorization_invalid',
        message: 'Write intent domain must match package owner',
      })
      expect(fetchBinding).not.toHaveBeenCalled()
      expect(getPackageChannelVersion).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('rejects channel delete authorization domains that do not match package owners before domain binding fetch', async () => {
    const adapters = createMemoryRegistryAdapters()
    const getPackageChannelVersion = vi.spyOn(
      adapters.database,
      'getPackageChannelVersion',
    )
    const app = createRegestaApp(adapters)
    const auth = createTestDomainAuth()
    const packageId = 'npm:example.com/channel-delete-domain-mismatch'
    const authorization = auth.sign(
      createChannelDeleteIntent({
        channel: 'latest',
        nonce: 'channel-delete-domain-mismatch',
        packageId,
        timestamp: new Date().toISOString(),
      }),
    )
    const fetchBinding = vi.fn(() =>
      Promise.reject(new Error('domain binding fetch should not be called')),
    )
    vi.stubGlobal('fetch', fetchBinding)

    try {
      const response = await app.request(
        `/packages/${encodeURIComponent(packageId)}/channels/latest`,
        {
          body: JSON.stringify({
            authorization: {
              ...authorization,
              payload: {
                ...authorization.payload,
                domain: 'other.example.com',
              },
            },
          }),
          headers: {
            'content-type': 'application/json',
          },
          method: 'DELETE',
        },
      )

      expect(response.status).toBe(401)
      await expect(response.json()).resolves.toMatchObject({
        code: 'write_authorization_invalid',
        message: 'Write intent domain must match package owner',
      })
      expect(fetchBinding).not.toHaveBeenCalled()
      expect(getPackageChannelVersion).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('uses the verified previous channel version when committing signed channel updates', async () => {
    const adapters = createMemoryRegistryAdapters()
    const app = createRegestaApp(adapters)
    const auth = createTestDomainAuth()
    const packageId = 'npm:example.com/channel-previous-version'
    await publishRelease(
      {
        artifacts: [
          {
            bytes: bytes('install artifact'),
            format: 'npm-tarball',
            mediaType: 'application/gzip',
            role: 'install',
          },
        ],
        config: {
          id: packageId,
          source: {
            include: ['regesta.json'],
          },
          version: '0.0.1',
        },
        createdAt: '2026-06-01T00:00:00.000Z',
        source: bytes('source archive'),
      },
      adapters,
    )
    const getPackageChannelVersion = vi.spyOn(
      adapters.database,
      'getPackageChannelVersion',
    )
    const authorization = auth.sign(
      createChannelUpdateIntent({
        channel: 'latest',
        nonce: 'channel-bound-previous-version',
        packageId,
        previousVersion: '0.0.1',
        timestamp: new Date().toISOString(),
        version: '0.0.1',
      }),
    )

    vi.stubGlobal('fetch', auth.fetch)

    try {
      const response = await app.request(
        `/packages/${encodeURIComponent(packageId)}/channels/latest`,
        {
          body: JSON.stringify({
            authorization,
            version: '0.0.1',
          }),
          headers: {
            'content-type': 'application/json',
          },
          method: 'PUT',
        },
      )

      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toMatchObject({
        event: {
          previousVersion: '0.0.1',
        },
        previousVersion: '0.0.1',
      })
      expect(getPackageChannelVersion).toHaveBeenCalledOnce()
      expect(getPackageChannelVersion).toHaveBeenCalledWith(packageId, 'latest')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('rejects replayed write authorizations for channel updates', async () => {
    const adapters = createMemoryRegistryAdapters()
    const app = createRegestaApp(adapters)
    const auth = createTestDomainAuth()
    const packageId = 'npm:example.com/hello-regesta'
    await publishRelease(
      {
        artifacts: [
          {
            bytes: bytes('install artifact'),
            format: 'npm-tarball',
            mediaType: 'application/gzip',
            role: 'install',
          },
        ],
        config: {
          id: packageId,
          source: {
            include: ['regesta.json'],
          },
          version: '0.0.1',
        },
        createdAt: '2026-06-01T00:00:00.000Z',
        source: bytes('source archive'),
      },
      adapters,
    )
    const authorization = auth.sign(
      createChannelUpdateIntent({
        channel: 'latest',
        nonce: 'channel-replay-nonce',
        packageId,
        previousVersion: '0.0.1',
        timestamp: new Date().toISOString(),
        version: '0.0.1',
      }),
    )
    const body = JSON.stringify({
      authorization,
      version: '0.0.1',
    })

    vi.stubGlobal('fetch', auth.fetch)

    try {
      const first = await app.request(
        `/packages/${encodeURIComponent(packageId)}/channels/latest`,
        {
          body,
          headers: {
            'content-type': 'application/json',
          },
          method: 'PUT',
        },
      )
      const replayed = await app.request(
        `/packages/${encodeURIComponent(packageId)}/channels/latest`,
        {
          body,
          headers: {
            'content-type': 'application/json',
          },
          method: 'PUT',
        },
      )

      expect(first.status).toBe(200)
      expect(replayed.status).toBe(409)
      await expect(replayed.json()).resolves.toMatchObject({
        error: expect.stringContaining('Write authorization already used'),
      })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('rejects replayed write authorizations for channel deletes', async () => {
    const adapters = createMemoryRegistryAdapters()
    const app = createRegestaApp(adapters)
    const auth = createTestDomainAuth()
    const packageId = 'npm:example.com/hello-regesta'
    await publishRelease(
      {
        artifacts: [
          {
            bytes: bytes('install artifact'),
            format: 'npm-tarball',
            mediaType: 'application/gzip',
            role: 'install',
          },
        ],
        config: {
          id: packageId,
          source: {
            include: ['regesta.json'],
          },
          version: '0.0.1',
        },
        createdAt: '2026-06-01T00:00:00.000Z',
        source: bytes('source archive'),
      },
      adapters,
    )
    const authorization = auth.sign(
      createChannelDeleteIntent({
        channel: 'beta',
        nonce: 'channel-delete-replay-nonce',
        packageId,
        timestamp: new Date().toISOString(),
      }),
    )
    const body = JSON.stringify({
      authorization,
    })

    vi.stubGlobal('fetch', auth.fetch)

    try {
      const first = await app.request(
        `/packages/${encodeURIComponent(packageId)}/channels/beta`,
        {
          body,
          headers: {
            'content-type': 'application/json',
          },
          method: 'DELETE',
        },
      )
      const replayed = await app.request(
        `/packages/${encodeURIComponent(packageId)}/channels/beta`,
        {
          body,
          headers: {
            'content-type': 'application/json',
          },
          method: 'DELETE',
        },
      )

      expect(first.status).toBe(200)
      expect(replayed.status).toBe(409)
      await expect(replayed.json()).resolves.toMatchObject({
        error: expect.stringContaining('Write authorization already used'),
      })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('maps package channel conflicts to conflict responses', async () => {
    const adapters = createMemoryRegistryAdapters()
    const app = createRegestaApp(adapters)
    const auth = createTestDomainAuth()
    const packageId = 'npm:example.com/channel-conflict'
    await publishRelease(
      {
        artifacts: [
          {
            bytes: bytes('install artifact'),
            format: 'npm-tarball',
            mediaType: 'application/gzip',
            role: 'install',
          },
        ],
        config: {
          id: packageId,
          source: {
            include: ['regesta.json'],
          },
          version: '0.0.1',
        },
        createdAt: '2026-06-01T00:00:00.000Z',
        source: bytes('source archive'),
      },
      adapters,
    )
    const authorization = auth.sign(
      createChannelUpdateIntent({
        channel: 'latest',
        nonce: 'channel-conflict-nonce',
        packageId,
        previousVersion: '0.0.1',
        timestamp: new Date().toISOString(),
        version: '0.0.1',
      }),
    )
    adapters.database.commitPackageChannelUpdate = () => {
      throw new PackageChannelConflictError(
        packageId,
        'latest',
        '0.0.1',
        '0.0.2',
      )
    }

    vi.stubGlobal('fetch', auth.fetch)

    try {
      const response = await app.request(
        `/packages/${encodeURIComponent(packageId)}/channels/latest`,
        {
          body: JSON.stringify({
            authorization,
            version: '0.0.1',
          }),
          headers: {
            'content-type': 'application/json',
          },
          method: 'PUT',
        },
      )

      expect(response.status).toBe(409)
      await expect(response.json()).resolves.toMatchObject({
        error: expect.stringContaining('Package channel changed before commit'),
      })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('maps missing channel update releases to not found responses', async () => {
    const app = createRegestaApp(createMemoryRegistryAdapters())
    const auth = createTestDomainAuth()
    const packageId = 'npm:example.com/missing-channel-release'
    const authorization = auth.sign(
      createChannelUpdateIntent({
        channel: 'latest',
        nonce: 'missing-channel-release-nonce',
        packageId,
        timestamp: new Date().toISOString(),
        version: '0.0.1',
      }),
    )

    vi.stubGlobal('fetch', auth.fetch)

    try {
      const response = await app.request(
        `/packages/${encodeURIComponent(packageId)}/channels/latest`,
        {
          body: JSON.stringify({
            authorization,
            version: '0.0.1',
          }),
          headers: {
            'content-type': 'application/json',
          },
          method: 'PUT',
        },
      )

      expect(response.status).toBe(404)
      await expect(response.json()).resolves.toMatchObject({
        error: expect.stringContaining('Release not found'),
      })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('maps duplicate registry event ids to conflict responses', async () => {
    const adapters = createMemoryRegistryAdapters()
    const app = createRegestaApp(adapters)
    const packageId = parsePackageId('demo:dev.localhost/event-conflict').id
    const artifactBytes = bytes('install artifact')
    const sourceBytes = bytes('source archive')
    const config: RegestaConfig = {
      id: packageId,
      provenance: {
        level: 'source-attached',
      },
      source: {
        include: ['regesta.json'],
      },
      version: '0.0.1',
    }
    const form = new FormData()

    adapters.database.commitPublishedRelease = () => {
      throw new RegistryEventAlreadyExistsError(sha256(bytes('event')))
    }
    form.set('config', JSON.stringify(config))
    form.set(
      'authorization',
      JSON.stringify(
        createWriteAuthorization(
          createReleasePublishIntent({
            artifactDescriptorDigest: publishArtifactDescriptorDigest([
              {
                bytes: artifactBytes,
                format: 'demo',
                mediaType: 'application/octet-stream',
                role: 'install',
              },
            ]),
            artifactDigests: [sha256(artifactBytes)],
            configDigest: configDigest(config),
            nonce: 'event-conflict-nonce',
            packageId,
            sourceDigest: sha256(sourceBytes),
            timestamp: new Date().toISOString(),
            version: config.version,
          }),
          devLocalhostPrivateKeyFile,
        ),
      ),
    )
    form.set('source', new File([blobPart(sourceBytes)], 'source.tgz'))
    form.set(
      'artifacts',
      JSON.stringify([
        {
          format: 'demo',
          mediaType: 'application/octet-stream',
          part: 'artifact.install',
          role: 'install',
        },
      ]),
    )
    form.set(
      'artifact.install',
      new File([blobPart(artifactBytes)], 'artifact.bin', {
        type: 'application/octet-stream',
      }),
    )

    vi.stubGlobal('fetch', devLocalhostFetch)

    try {
      const response = await app.request('http://localhost:4321/releases', {
        body: form,
        method: 'POST',
      })

      expect(response.status).toBe(409)
      await expect(response.json()).resolves.toMatchObject({
        error: expect.stringContaining('Registry event already exists'),
      })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('maps duplicate releases to conflict responses', async () => {
    const adapters = createMemoryRegistryAdapters()
    const app = createRegestaApp(adapters)
    const packageId = parsePackageId('demo:dev.localhost/duplicate-release').id
    const artifactBytes = bytes('install artifact')
    const sourceBytes = bytes('source archive')
    const config: RegestaConfig = {
      id: packageId,
      provenance: {
        level: 'source-attached',
      },
      source: {
        include: ['regesta.json'],
      },
      version: '0.0.1',
    }
    const form = new FormData()

    await publishRelease(
      {
        artifacts: [
          {
            bytes: artifactBytes,
            mediaType: 'application/octet-stream',
            role: 'install',
          },
        ],
        config,
        createdAt: '2026-06-01T00:00:00.000Z',
        source: sourceBytes,
      },
      adapters,
    )
    form.set('config', JSON.stringify(config))
    form.set(
      'authorization',
      JSON.stringify(
        createWriteAuthorization(
          createReleasePublishIntent({
            artifactDescriptorDigest: publishArtifactDescriptorDigest([
              {
                bytes: artifactBytes,
                mediaType: 'application/octet-stream',
                role: 'install',
              },
            ]),
            artifactDigests: [sha256(artifactBytes)],
            configDigest: configDigest(config),
            nonce: 'duplicate-release-nonce',
            packageId,
            sourceDigest: sha256(sourceBytes),
            timestamp: new Date().toISOString(),
            version: config.version,
          }),
          devLocalhostPrivateKeyFile,
        ),
      ),
    )
    form.set('source', new File([blobPart(sourceBytes)], 'source.tgz'))
    form.set(
      'artifacts',
      JSON.stringify([
        {
          mediaType: 'application/octet-stream',
          part: 'artifact.install',
          role: 'install',
        },
      ]),
    )
    form.set(
      'artifact.install',
      new File([blobPart(artifactBytes)], 'artifact.bin', {
        type: 'application/octet-stream',
      }),
    )

    vi.stubGlobal('fetch', devLocalhostFetch)

    try {
      const response = await app.request('http://localhost:4321/releases', {
        body: form,
        method: 'POST',
      })

      expect(response.status).toBe(409)
      await expect(response.json()).resolves.toMatchObject({
        error: expect.stringContaining('Release already exists'),
      })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('commits only one concurrent publish for duplicate release versions', async () => {
    const adapters = createMemoryRegistryAdapters()
    const app = createRegestaApp(adapters)
    const auth = createTestDomainAuth()
    const packageId = parsePackageId(
      'demo:example.com/concurrent-duplicate-release',
    ).id
    const artifactBytes = bytes('concurrent install artifact')
    const sourceBytes = bytes('concurrent source archive')
    const config: RegestaConfig = {
      id: packageId,
      provenance: {
        level: 'source-attached',
      },
      source: {
        include: ['regesta.json'],
      },
      version: '0.0.1',
    }
    const timestamp = new Date().toISOString()
    const publishForm = (nonce: string): FormData => {
      const form = new FormData()

      form.set('config', JSON.stringify(config))
      form.set(
        'authorization',
        JSON.stringify(
          auth.sign(
            createReleasePublishIntent({
              artifactDescriptorDigest: publishArtifactDescriptorDigest([
                {
                  format: 'demo',
                  bytes: artifactBytes,
                  mediaType: 'application/octet-stream',
                  role: 'install',
                },
              ]),
              artifactDigests: [sha256(artifactBytes)],
              configDigest: configDigest(config),
              nonce,
              packageId,
              sourceDigest: sha256(sourceBytes),
              timestamp,
              version: config.version,
            }),
          ),
        ),
      )
      form.set('createdAt', timestamp)
      form.set('source', new File([blobPart(sourceBytes)], 'source.tgz'))
      form.set(
        'artifacts',
        JSON.stringify([
          {
            format: 'demo',
            mediaType: 'application/octet-stream',
            part: 'artifact.install',
            role: 'install',
          },
        ]),
      )
      form.set(
        'artifact.install',
        new File([blobPart(artifactBytes)], 'artifact.bin', {
          type: 'application/octet-stream',
        }),
      )

      return form
    }

    vi.stubGlobal('fetch', auth.fetch)

    try {
      const responses = await Promise.all([
        app.request('/releases', {
          body: publishForm('concurrent-duplicate-release-1'),
          method: 'POST',
        }),
        app.request('/releases', {
          body: publishForm('concurrent-duplicate-release-2'),
          method: 'POST',
        }),
      ])
      const statuses = responses.map((response) => response.status).toSorted()
      const failed = responses.find((response) => {
        return response.status === 409
      })

      expect(statuses).toEqual([201, 409])
      await expect(failed?.json()).resolves.toMatchObject({
        error: expect.stringContaining('Release already exists'),
      })
      await expect(
        adapters.database.listEvents({ limit: 1 }),
      ).resolves.toHaveLength(1)
      await expect(
        adapters.database.getPackageChannels(packageId),
      ).resolves.toEqual({
        latest: config.version,
      })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('serves concurrent core and npm projection reads consistently', async () => {
    const adapters = createMemoryRegistryAdapters()
    const app = createRegestaApp(adapters)
    const packageId = parsePackageId('npm:example.com/concurrent-reads').id
    const artifactBytes = bytes('concurrent install artifact')
    const sourceBytes = bytes('concurrent source archive')
    const published = await publishRelease(
      {
        artifacts: [
          {
            bytes: artifactBytes,
            format: 'npm-tarball',
            mediaType: 'application/gzip',
            role: 'install',
          },
        ],
        config: {
          id: packageId,
          source: {
            include: ['regesta.json'],
          },
          version: '0.0.1',
        },
        createdAt: '2026-06-01T00:00:00.000Z',
        source: sourceBytes,
      },
      adapters,
    )
    const packagePath = encodeURIComponent(packageId)
    const eventPath = published.event.id.replace('sha256:', 'sha256/')
    const npmBase = 'http://npm.registry.test/@example.com/concurrent-reads'
    const npmTarball = `${npmBase}/-/concurrent-reads-${published.manifest.version}.tgz`
    const readRequests = Array.from({ length: 4 }, () => [
      {
        assert: async (response: Response) => {
          expect(response.status).toBe(200)
          await expect(response.json()).resolves.toMatchObject({
            channels: {
              latest: published.manifest.version,
            },
            id: packageId,
          })
        },
        url: `/packages/${packagePath}`,
      },
      {
        assert: async (response: Response) => {
          expect(response.status).toBe(200)
          await expect(response.json()).resolves.toMatchObject({
            event: {
              id: published.event.id,
            },
            manifest: {
              id: packageId,
              version: published.manifest.version,
            },
          })
        },
        url: `/packages/${packagePath}/channels/latest`,
      },
      {
        assert: async (response: Response) => {
          expect(response.status).toBe(200)
          await expect(response.json()).resolves.toMatchObject({
            event: {
              id: published.event.id,
            },
            manifest: {
              id: packageId,
              version: published.manifest.version,
            },
          })
        },
        url: `/packages/${packagePath}/releases/${published.manifest.version}`,
      },
      {
        assert: async (response: Response) => {
          expect(response.status).toBe(200)
          await expect(response.json()).resolves.toMatchObject({
            eventType: 'release.published',
            id: published.event.id,
          })
        },
        url: `/events/${eventPath}`,
      },
      {
        assert: async (response: Response) => {
          expect(response.status).toBe(200)
          await expect(response.json()).resolves.toMatchObject({
            events: [
              {
                id: published.event.id,
              },
            ],
            nextAfter: published.event.id,
          })
        },
        url: '/events?limit=1',
      },
      {
        assert: async (response: Response) => {
          expect(response.status).toBe(200)
          expect(await response.text()).toBe(
            `${canonicalJson(published.manifest)}\n`,
          )
        },
        url: `/objects/${published.manifestDescriptor.digest}`,
      },
      {
        assert: async (response: Response) => {
          expect(response.status).toBe(200)
          await expect(response.json()).resolves.toMatchObject({
            'dist-tags': {
              latest: published.manifest.version,
            },
            name: '@example.com/concurrent-reads',
          })
        },
        url: npmBase,
      },
      {
        assert: async (response: Response) => {
          expect(response.status).toBe(200)
          await expect(response.json()).resolves.toMatchObject({
            name: '@example.com/concurrent-reads',
            version: published.manifest.version,
          })
        },
        url: `${npmBase}/latest`,
      },
      {
        assert: async (response: Response) => {
          expect(response.status).toBe(302)
          expect(response.headers.get('location')).toBe(
            `http://registry.test/objects/${sha256(artifactBytes)}`,
          )
          expect(await response.text()).toBe('')
        },
        url: npmTarball,
      },
    ]).flat()

    await Promise.all(
      readRequests.map(async (readRequest) => {
        const response = await app.request(readRequest.url)
        await readRequest.assert(response)
      }),
    )
  })

  it('accepts dev.localhost write signatures through domain binding lookup', async () => {
    const app = createRegestaApp(createMemoryRegistryAdapters())
    const packageId = parsePackageId('demo:dev.localhost/hello-regesta').id
    const artifactBytes = bytes('install artifact')
    const sourceBytes = bytes('source archive')
    const config: RegestaConfig = {
      id: packageId,
      provenance: {
        level: 'source-attached',
      },
      source: {
        include: ['regesta.json'],
      },
      version: '0.0.1',
    }
    const form = new FormData()

    form.set('config', JSON.stringify(config))
    form.set(
      'authorization',
      JSON.stringify(
        createWriteAuthorization(
          createReleasePublishIntent({
            artifactDescriptorDigest: publishArtifactDescriptorDigest([
              {
                bytes: artifactBytes,
                format: 'demo',
                mediaType: 'application/octet-stream',
                role: 'install',
              },
            ]),
            artifactDigests: [sha256(artifactBytes)],
            configDigest: configDigest(config),
            nonce: 'dev-localhost-nonce',
            packageId,
            sourceDigest: sha256(sourceBytes),
            timestamp: new Date().toISOString(),
            version: config.version,
          }),
          devLocalhostPrivateKeyFile,
        ),
      ),
    )
    form.set('source', new File([blobPart(sourceBytes)], 'source.tgz'))
    form.set(
      'artifacts',
      JSON.stringify([
        {
          format: 'demo',
          mediaType: 'application/octet-stream',
          part: 'artifact.install',
          role: 'install',
        },
      ]),
    )
    form.set(
      'artifact.install',
      new File([blobPart(artifactBytes)], 'artifact.bin', {
        type: 'application/octet-stream',
      }),
    )

    vi.stubGlobal('fetch', devLocalhostFetch)

    try {
      const response = await app.request('http://localhost:4321/releases', {
        body: form,
        method: 'POST',
      })

      expect(response.status).toBe(201)
      await expect(response.json()).resolves.toMatchObject({
        manifest: {
          id: packageId,
        },
      })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('publishes artifact-level compatibility from multipart metadata', async () => {
    const app = createRegestaApp(createMemoryRegistryAdapters())
    const packageId = parsePackageId('demo:dev.localhost/artifact-compat').id
    const artifactBytes = bytes('install artifact')
    const sourceBytes = bytes('source archive')
    const config: RegestaConfig = {
      id: packageId,
      provenance: {
        level: 'source-attached',
      },
      source: {
        include: ['regesta.json'],
      },
      version: '0.0.1',
    }
    const form = new FormData()

    form.set('config', JSON.stringify(config))
    form.set(
      'authorization',
      JSON.stringify(
        createWriteAuthorization(
          createReleasePublishIntent({
            artifactDescriptorDigest: publishArtifactDescriptorDigest([
              {
                bytes: artifactBytes,
                compatibility: {
                  modules: ['esm'],
                  platforms: [
                    {
                      arch: ['x64', 'arm64'],
                      os: ['linux', 'darwin'],
                    },
                  ],
                  runtimes: [
                    'node',
                    {
                      conditions: ['node', 'import'],
                      name: 'bun',
                      versions: '>=1.2',
                    },
                  ],
                },
                format: 'demo',
                mediaType: 'application/octet-stream',
                role: 'install',
              },
            ]),
            artifactDigests: [sha256(artifactBytes)],
            configDigest: configDigest(config),
            nonce: 'artifact-compatibility-nonce',
            packageId,
            sourceDigest: sha256(sourceBytes),
            timestamp: new Date().toISOString(),
            version: config.version,
          }),
          devLocalhostPrivateKeyFile,
        ),
      ),
    )
    form.set('source', new File([blobPart(sourceBytes)], 'source.tgz'))
    form.set(
      'artifacts',
      JSON.stringify([
        {
          compatibility: {
            modules: ['esm'],
            platforms: [
              {
                arch: ['x64', 'arm64'],
                os: ['linux', 'darwin'],
              },
            ],
            runtimes: [
              'node',
              {
                conditions: ['node', 'import'],
                name: 'bun',
                versions: '>=1.2',
              },
            ],
          },
          format: 'demo',
          mediaType: 'application/octet-stream',
          part: 'artifact.install',
          role: 'install',
        },
      ]),
    )
    form.set(
      'artifact.install',
      new File([blobPart(artifactBytes)], 'artifact.bin', {
        type: 'application/octet-stream',
      }),
    )

    vi.stubGlobal('fetch', devLocalhostFetch)

    try {
      const response = await app.request('http://localhost:4321/releases', {
        body: form,
        method: 'POST',
      })

      expect(response.status).toBe(201)
      await expect(response.json()).resolves.toMatchObject({
        manifest: {
          artifacts: [
            {
              compatibility: {
                modules: ['esm'],
                platforms: [
                  {
                    arch: ['x64', 'arm64'],
                    os: ['linux', 'darwin'],
                  },
                ],
                runtimes: [
                  'node',
                  {
                    conditions: ['node', 'import'],
                    name: 'bun',
                    versions: '>=1.2',
                  },
                ],
              },
            },
          ],
        },
      })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('rejects publish signatures that do not bind client artifact descriptor metadata', async () => {
    const app = createRegestaApp(createMemoryRegistryAdapters())
    const packageId = parsePackageId('demo:dev.localhost/signed-filename').id
    const artifactBytes = bytes('install artifact')
    const sourceBytes = bytes('source archive')
    const config: RegestaConfig = {
      id: packageId,
      provenance: {
        level: 'source-attached',
      },
      source: {
        include: ['regesta.json'],
      },
      version: '0.0.1',
    }
    const form = new FormData()

    form.set('config', JSON.stringify(config))
    form.set(
      'authorization',
      JSON.stringify(
        createWriteAuthorization(
          createReleasePublishIntent({
            artifactDescriptorDigest: publishArtifactDescriptorDigest([
              {
                bytes: artifactBytes,
                format: 'demo',
                mediaType: 'application/octet-stream',
                role: 'install',
              },
            ]),
            artifactDigests: [sha256(artifactBytes)],
            configDigest: configDigest(config),
            nonce: 'unsigned-artifact-filename-nonce',
            packageId,
            sourceDigest: sha256(sourceBytes),
            timestamp: new Date().toISOString(),
            version: config.version,
          }),
          devLocalhostPrivateKeyFile,
        ),
      ),
    )
    form.set('source', new File([blobPart(sourceBytes)], 'source.tgz'))
    form.set(
      'artifacts',
      JSON.stringify([
        {
          filename: 'artifact.bin',
          format: 'demo',
          mediaType: 'application/octet-stream',
          part: 'artifact.install',
          role: 'install',
        },
      ]),
    )
    form.set(
      'artifact.install',
      new File([blobPart(artifactBytes)], 'artifact.bin', {
        type: 'application/octet-stream',
      }),
    )

    vi.stubGlobal('fetch', devLocalhostFetch)

    try {
      const response = await app.request('http://localhost:4321/releases', {
        body: form,
        method: 'POST',
      })

      expect(response.status).toBe(401)
      await expect(response.json()).resolves.toMatchObject({
        code: 'write_authorization_invalid',
        message: 'Write authorization payload mismatch',
      })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('rejects publish authorizations that omit the release publish channel before domain binding fetch', async () => {
    const app = createRegestaApp(createMemoryRegistryAdapters())
    const prepared = await prepareFixtureNpmPublish(
      await createFixtureProject(),
    )
    const auth = createTestDomainAuth()
    const form = createSignedPublishForm({
      auth,
      nonce: 'missing-channel-publish-authorization-nonce',
      prepared,
      timestamp: new Date().toISOString(),
    })
    updateSignedPublishAuthorization(form, (_authorization, payload) => {
      delete payload.channel
    })

    const fetchBinding = vi.fn(() =>
      Promise.reject(new Error('domain binding fetch should not be called')),
    )
    vi.stubGlobal('fetch', fetchBinding)

    try {
      const response = await app.request('/releases', {
        body: form,
        method: 'POST',
      })

      expect(response.status).toBe(401)
      await expect(response.json()).resolves.toMatchObject({
        code: 'write_authorization_invalid',
        message: 'channel must be a non-empty string',
      })
      expect(fetchBinding).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('rejects publish authorization domains that do not match package owners before domain binding fetch or artifact processing', async () => {
    const app = createRegestaApp(createMemoryRegistryAdapters())
    const prepared = await prepareFixtureNpmPublish(
      await createFixtureProject(),
    )
    const auth = createTestDomainAuth()
    const form = createSignedPublishForm({
      auth,
      nonce: 'mismatched-domain-publish-authorization-nonce',
      prepared,
      timestamp: new Date().toISOString(),
    })
    updateSignedPublishAuthorization(form, (_authorization, payload) => {
      payload.domain = 'other.example.com'
    })
    form.set(
      'artifact.0',
      new File([blobPart(new Uint8Array([0x1f, 0x8b, 0x08, 0x00]))], 'bad.tgz'),
    )

    const fetchBinding = vi.fn(() =>
      Promise.reject(new Error('domain binding fetch should not be called')),
    )
    vi.stubGlobal('fetch', fetchBinding)

    try {
      const response = await app.request('/releases', {
        body: form,
        method: 'POST',
      })

      expect(response.status).toBe(401)
      await expect(response.json()).resolves.toMatchObject({
        code: 'write_authorization_invalid',
        message: 'Write intent domain must match package owner',
      })
      expect(fetchBinding).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('applies configured domain binding fetch timeouts to publish authorization checks', async () => {
    const prepared = await prepareFixtureNpmPublish(
      await createFixtureProject(),
    )
    const now = new Date('2026-06-12T00:00:00.000Z')

    vi.useFakeTimers()
    vi.setSystemTime(now)

    const app = createRegestaApp(createMemoryRegistryAdapters(), {
      trust: {
        domainBindingFetchTimeoutMs: 50,
      },
    })
    const auth = createTestDomainAuth()
    const form = createSignedPublishForm({
      auth,
      nonce: 'publish-domain-binding-timeout',
      prepared,
      timestamp: now.toISOString(),
    })
    let resolveFetchCalled: (() => void) | undefined
    const fetchCalled = new Promise<void>((resolve) => {
      resolveFetchCalled = resolve
    })
    const fetchBinding = vi.fn(
      (_input: Parameters<typeof fetch>[0], init: RequestInit | undefined) =>
        new Promise<Response>((_resolve, reject) => {
          resolveFetchCalled?.()
          const signal = init?.signal

          if (!(signal instanceof AbortSignal)) {
            reject(new Error('missing abort signal'))
            return
          }

          signal.addEventListener('abort', () => {
            reject(new Error('configured domain binding timeout'))
          })
        }),
    )
    vi.stubGlobal('fetch', fetchBinding)

    try {
      const responsePromise = app.request('/releases', {
        body: form,
        method: 'POST',
      })

      await fetchCalled
      await vi.advanceTimersByTimeAsync(50)

      const response = await responsePromise
      expect(response.status).toBe(401)
      await expect(response.json()).resolves.toMatchObject({
        code: 'write_authorization_invalid',
        issues: ['configured domain binding timeout'],
        message: 'Domain binding fetch failed',
      })
      expect(fetchBinding).toHaveBeenCalledOnce()
    } finally {
      vi.unstubAllGlobals()
      vi.useRealTimers()
    }
  })

  it('infers core release description from npm install artifacts before verifying publish signatures', async () => {
    const app = createRegestaApp(createMemoryRegistryAdapters())
    const prepared = await prepareFixtureNpmPublish(
      await createFixtureProject(),
    )
    const installArtifact = prepared.artifacts[0]
    const publishConfig = withoutDescription(prepared.config)
    const auth = createTestDomainAuth()

    if (!installArtifact) {
      throw new Error('Fixture publish did not produce an install artifact')
    }

    const publishForm = new FormData()
    publishForm.set('config', JSON.stringify(publishConfig))
    publishForm.set(
      'authorization',
      JSON.stringify(
        auth.sign(
          createReleasePublishIntent({
            artifactDescriptorDigest: publishArtifactDescriptorDigest(
              prepared.artifacts.map((artifact) => ({
                bytes: artifact.bytes,
                filename: artifact.filename,
                format: artifact.format,
                mediaType: artifact.mediaType,
                role: artifact.role,
              })),
            ),
            artifactDigests: prepared.artifacts.map((artifact) =>
              sha256(artifact.bytes),
            ),
            configDigest: configDigest(prepared.config),
            nonce: 'inferred-description-nonce',
            packageId: prepared.config.id,
            sourceDigest: sha256(prepared.source),
            timestamp: new Date().toISOString(),
            version: prepared.config.version,
          }),
        ),
      ),
    )
    publishForm.set(
      'source',
      new File([blobPart(prepared.source)], 'source.tgz'),
    )
    publishForm.set(
      'artifacts',
      JSON.stringify([
        {
          filename: installArtifact.filename,
          format: installArtifact.format,
          mediaType: installArtifact.mediaType,
          part: 'artifact.install',
          role: installArtifact.role,
        },
      ]),
    )
    publishForm.set(
      'artifact.install',
      new File(
        [blobPart(installArtifact.bytes)],
        installArtifact.filename ?? 'pkg.tgz',
        {
          type: installArtifact.mediaType,
        },
      ),
    )

    vi.stubGlobal('fetch', auth.fetch)

    try {
      const response = await app.request('/releases', {
        body: publishForm,
        method: 'POST',
      })

      expect(response.status).toBe(201)
      await expect(response.json()).resolves.toMatchObject({
        manifest: {
          metadata: {
            description: 'Fixture package',
          },
        },
      })

      const latest = await app.request(
        `/packages/${encodeURIComponent(prepared.config.id)}/channels/latest`,
      )

      expect(latest.status).toBe(200)
      await expect(latest.json()).resolves.toMatchObject({
        manifest: {
          metadata: {
            description: 'Fixture package',
          },
        },
      })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('rejects publish signatures that do not include inferred release description', async () => {
    const app = createRegestaApp(createMemoryRegistryAdapters())
    const prepared = await prepareFixtureNpmPublish(
      await createFixtureProject(),
    )
    const installArtifact = prepared.artifacts[0]
    const publishConfig = withoutDescription(prepared.config)
    const auth = createTestDomainAuth()

    if (!installArtifact) {
      throw new Error('Fixture publish did not produce an install artifact')
    }

    const publishForm = new FormData()
    publishForm.set('config', JSON.stringify(publishConfig))
    publishForm.set(
      'authorization',
      JSON.stringify(
        auth.sign(
          createReleasePublishIntent({
            artifactDescriptorDigest: publishArtifactDescriptorDigest(
              prepared.artifacts.map((artifact) => ({
                bytes: artifact.bytes,
                filename: artifact.filename,
                format: artifact.format,
                mediaType: artifact.mediaType,
                role: artifact.role,
              })),
            ),
            artifactDigests: prepared.artifacts.map((artifact) =>
              sha256(artifact.bytes),
            ),
            configDigest: configDigest(publishConfig),
            nonce: 'unsigned-inferred-description-nonce',
            packageId: prepared.config.id,
            sourceDigest: sha256(prepared.source),
            timestamp: new Date().toISOString(),
            version: prepared.config.version,
          }),
        ),
      ),
    )
    publishForm.set(
      'source',
      new File([blobPart(prepared.source)], 'source.tgz'),
    )
    publishForm.set(
      'artifacts',
      JSON.stringify([
        {
          filename: installArtifact.filename,
          format: installArtifact.format,
          mediaType: installArtifact.mediaType,
          part: 'artifact.install',
          role: installArtifact.role,
        },
      ]),
    )
    publishForm.set(
      'artifact.install',
      new File(
        [blobPart(installArtifact.bytes)],
        installArtifact.filename ?? 'pkg.tgz',
        {
          type: installArtifact.mediaType,
        },
      ),
    )

    vi.stubGlobal('fetch', auth.fetch)

    try {
      const response = await app.request('/releases', {
        body: publishForm,
        method: 'POST',
      })

      expect(response.status).toBe(401)
      await expect(response.json()).resolves.toMatchObject({
        code: 'write_authorization_invalid',
        message: 'Write authorization payload mismatch',
      })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('rejects npm release descriptions that cannot be reproduced from install artifacts', async () => {
    const app = createRegestaApp(createMemoryRegistryAdapters())
    const prepared = await prepareFixtureNpmPublish(
      await createFixtureProject(),
    )
    const auth = createTestDomainAuth()
    const timestamp = new Date().toISOString()
    const publishConfig: RegestaConfig = {
      ...prepared.config,
      description: 'Different package description',
    }
    const publishForm = createSignedPublishForm({
      auth,
      nonce: 'mismatched-npm-description-nonce',
      prepared: {
        ...prepared,
        config: publishConfig,
      },
      timestamp,
    })

    vi.stubGlobal('fetch', auth.fetch)

    try {
      const response = await app.request('/releases', {
        body: publishForm,
        method: 'POST',
      })

      expect(response.status).toBe(400)
      await expect(response.json()).resolves.toMatchObject({
        code: 'request_invalid',
        error:
          'regesta.json description must match npm package.json description',
      })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('serves npm projection APIs on npm subdomains', async () => {
    const adapters = createMemoryRegistryAdapters()
    const app = createRegestaApp(adapters)
    const prepared = await prepareFixtureNpmPublish(
      await createFixtureProject(),
    )
    const installArtifact = prepared.artifacts[0]
    const auth = createTestDomainAuth()

    if (!installArtifact) {
      throw new Error('Fixture publish did not produce an install artifact')
    }

    const publishForm = new FormData()
    const publishTimestamp = new Date().toISOString()
    publishForm.set('config', JSON.stringify(prepared.config))
    publishForm.set(
      'authorization',
      JSON.stringify(
        auth.sign(
          createReleasePublishIntent({
            artifactDescriptorDigest: publishArtifactDescriptorDigest(
              prepared.artifacts.map((artifact) => ({
                bytes: artifact.bytes,
                filename: artifact.filename,
                format: artifact.format,
                mediaType: artifact.mediaType,
                role: artifact.role,
              })),
            ),
            artifactDigests: prepared.artifacts.map((artifact) =>
              sha256(artifact.bytes),
            ),
            configDigest: configDigest(prepared.config),
            nonce: 'release-nonce',
            packageId: prepared.config.id,
            sourceDigest: sha256(prepared.source),
            timestamp: publishTimestamp,
            version: prepared.config.version,
          }),
        ),
      ),
    )
    publishForm.set('createdAt', publishTimestamp)
    publishForm.set(
      'source',
      new File([blobPart(prepared.source)], 'source.tgz'),
    )
    publishForm.set(
      'artifacts',
      JSON.stringify([
        {
          filename: installArtifact.filename,
          format: installArtifact.format,
          mediaType: installArtifact.mediaType,
          part: 'artifact.install',
          role: installArtifact.role,
        },
      ]),
    )
    publishForm.set(
      'artifact.install',
      new File(
        [blobPart(installArtifact.bytes)],
        installArtifact.filename ?? 'pkg.tgz',
        {
          type: installArtifact.mediaType,
        },
      ),
    )

    vi.stubGlobal('fetch', auth.fetch)

    let npmProjectionEtag: string | undefined

    try {
      const publish = await app.request('/releases', {
        body: publishForm,
        method: 'POST',
      })

      expect(publish.status).toBe(201)
      const publishBody = await publish.json()
      expect(publishBody).toMatchObject({
        channel: 'latest',
      })
      if (
        !isRecord(publishBody) ||
        !isRecord(publishBody.event) ||
        typeof publishBody.event.id !== 'string'
      ) {
        throw new Error('publish response event id must be a string')
      }
      npmProjectionEtag = `W/"regesta.npm-projection:${publishBody.event.id}"`
    } finally {
      vi.unstubAllGlobals()
    }

    if (!npmProjectionEtag) {
      throw new Error('npm projection etag was not computed')
    }
    const npmVersionManifestEtag = npmProjectionEtag.replace(
      'regesta.npm-projection',
      'regesta.npm-version',
    )
    const npmDistTagsEtag = `W/"regesta.npm-dist-tags:${sha256(
      canonicalJson({ latest: '0.0.1' }),
    )}"`
    const installArtifactObjectUrl = `http://registry.test/objects/${sha256(
      installArtifact.bytes,
    )}`
    const localInstallTarballUrl =
      'http://npm.registry.test/@example.com/hello-regesta/-/hello-regesta-0.0.1.tgz'

    const rootHostPackument = await app.request(
      'http://registry.test/npm/@example.com/hello-regesta',
    )

    expect(rootHostPackument.status).toBe(404)

    const rootHostTarball = await app.request(
      'http://registry.test/npm/@example.com/hello-regesta/-/hello-regesta-0.0.1.tgz',
    )

    expect(rootHostTarball.status).toBe(404)

    const subdomainPackument = await app.request(
      'http://npm.registry.test/@example.com/hello-regesta',
    )

    expect(subdomainPackument.status).toBe(200)
    expect(subdomainPackument.headers.get('cache-control')).toBe('no-cache')
    expect(subdomainPackument.headers.get('etag')).toBe(npmProjectionEtag)
    expect(subdomainPackument.headers.get('last-modified')).toBe(
      new Date(publishTimestamp).toUTCString(),
    )
    const subdomainPackumentText = await subdomainPackument.clone().text()
    expect(subdomainPackument.headers.get('content-length')).toBe(
      String(Buffer.byteLength(subdomainPackumentText)),
    )
    await expect(subdomainPackument.json()).resolves.toMatchObject({
      'dist-tags': {
        latest: '0.0.1',
      },
      description: 'Fixture package',
      name: '@example.com/hello-regesta',
      time: {
        '0.0.1': publishTimestamp,
        created: publishTimestamp,
        modified: publishTimestamp,
      },
      versions: {
        '0.0.1': {
          dependencies: {
            '@example.com/base': '^1.0.0',
          },
          description: 'Fixture package',
          dist: {
            tarball: localInstallTarballUrl,
          },
        },
      },
    })

    const conditionalPackument = await app.request(
      'http://npm.registry.test/@example.com/hello-regesta',
      {
        headers: {
          'if-none-match': npmProjectionEtag.replace('W/', ''),
        },
      },
    )

    expect(conditionalPackument.status).toBe(304)
    expect(conditionalPackument.headers.get('cache-control')).toBe('no-cache')
    expect(conditionalPackument.headers.get('etag')).toBe(npmProjectionEtag)
    expect(conditionalPackument.headers.get('last-modified')).toBe(
      new Date(publishTimestamp).toUTCString(),
    )
    expect(conditionalPackument.headers.get('content-length')).toBeNull()
    expect(await conditionalPackument.text()).toBe('')

    const headPackument = await app.request(
      'http://npm.registry.test/@example.com/hello-regesta',
      {
        method: 'HEAD',
      },
    )

    expect(headPackument.status).toBe(200)
    expect(headPackument.headers.get('cache-control')).toBe('no-cache')
    expect(headPackument.headers.get('content-type')).toBe(
      'application/json; charset=UTF-8',
    )
    expect(headPackument.headers.get('content-length')).toBe(
      String(Buffer.byteLength(subdomainPackumentText)),
    )
    expect(headPackument.headers.get('etag')).toBe(npmProjectionEtag)
    expect(headPackument.headers.get('last-modified')).toBe(
      new Date(publishTimestamp).toUTCString(),
    )
    expect(await headPackument.text()).toBe('')

    const conditionalHeadPackument = await app.request(
      'http://npm.registry.test/@example.com/hello-regesta',
      {
        headers: {
          'if-none-match': npmProjectionEtag,
        },
        method: 'HEAD',
      },
    )

    expect(conditionalHeadPackument.status).toBe(304)
    expect(conditionalHeadPackument.headers.get('cache-control')).toBe(
      'no-cache',
    )
    expect(conditionalHeadPackument.headers.get('etag')).toBe(npmProjectionEtag)
    expect(conditionalHeadPackument.headers.get('last-modified')).toBe(
      new Date(publishTimestamp).toUTCString(),
    )
    expect(conditionalHeadPackument.headers.get('content-length')).toBeNull()
    expect(await conditionalHeadPackument.text()).toBe('')

    const subdomainLatestManifest = await app.request(
      'http://npm.registry.test/@example.com/hello-regesta/latest',
    )

    expect(subdomainLatestManifest.status).toBe(200)
    expect(subdomainLatestManifest.headers.get('cache-control')).toBe(
      'no-cache',
    )
    expect(subdomainLatestManifest.headers.get('etag')).toBe(
      npmVersionManifestEtag,
    )
    expect(subdomainLatestManifest.headers.get('last-modified')).toBeNull()
    const subdomainLatestManifestText = await subdomainLatestManifest
      .clone()
      .text()
    expect(subdomainLatestManifest.headers.get('content-length')).toBe(
      String(Buffer.byteLength(subdomainLatestManifestText)),
    )
    await expect(subdomainLatestManifest.json()).resolves.toMatchObject({
      dependencies: {
        '@example.com/base': '^1.0.0',
      },
      description: 'Fixture package',
      dist: {
        tarball: localInstallTarballUrl,
      },
      name: '@example.com/hello-regesta',
      version: '0.0.1',
    })

    const subdomainVersionManifest = await app.request(
      'http://npm.registry.test/@example.com/hello-regesta/0.0.1',
    )

    expect(subdomainVersionManifest.status).toBe(200)
    expect(subdomainVersionManifest.headers.get('cache-control')).toBe(
      'public, max-age=31536000, immutable',
    )
    expect(subdomainVersionManifest.headers.get('etag')).toBe(
      npmVersionManifestEtag,
    )
    expect(subdomainVersionManifest.headers.get('last-modified')).toBe(
      new Date(publishTimestamp).toUTCString(),
    )
    const subdomainVersionManifestText = await subdomainVersionManifest
      .clone()
      .text()
    expect(subdomainVersionManifest.headers.get('content-length')).toBe(
      String(Buffer.byteLength(subdomainVersionManifestText)),
    )
    await expect(subdomainVersionManifest.json()).resolves.toMatchObject({
      name: '@example.com/hello-regesta',
      version: '0.0.1',
    })

    const conditionalVersionManifest = await app.request(
      'http://npm.registry.test/@example.com/hello-regesta/0.0.1',
      {
        headers: {
          'if-none-match': npmVersionManifestEtag.replace('W/', ''),
        },
      },
    )

    expect(conditionalVersionManifest.status).toBe(304)
    expect(conditionalVersionManifest.headers.get('cache-control')).toBe(
      'public, max-age=31536000, immutable',
    )
    expect(conditionalVersionManifest.headers.get('etag')).toBe(
      npmVersionManifestEtag,
    )
    expect(conditionalVersionManifest.headers.get('last-modified')).toBe(
      new Date(publishTimestamp).toUTCString(),
    )
    expect(conditionalVersionManifest.headers.get('content-length')).toBeNull()
    expect(await conditionalVersionManifest.text()).toBe('')

    const headVersionManifest = await app.request(
      'http://npm.registry.test/@example.com/hello-regesta/0.0.1',
      {
        method: 'HEAD',
      },
    )

    expect(headVersionManifest.status).toBe(200)
    expect(headVersionManifest.headers.get('cache-control')).toBe(
      'public, max-age=31536000, immutable',
    )
    expect(headVersionManifest.headers.get('etag')).toBe(npmVersionManifestEtag)
    expect(headVersionManifest.headers.get('last-modified')).toBe(
      new Date(publishTimestamp).toUTCString(),
    )
    expect(headVersionManifest.headers.get('content-length')).toBe(
      String(Buffer.byteLength(subdomainVersionManifestText)),
    )
    expect(await headVersionManifest.text()).toBe('')

    const conditionalHeadVersionManifest = await app.request(
      'http://npm.registry.test/@example.com/hello-regesta/0.0.1',
      {
        headers: {
          'if-none-match': npmVersionManifestEtag,
        },
        method: 'HEAD',
      },
    )

    expect(conditionalHeadVersionManifest.status).toBe(304)
    expect(conditionalHeadVersionManifest.headers.get('cache-control')).toBe(
      'public, max-age=31536000, immutable',
    )
    expect(conditionalHeadVersionManifest.headers.get('etag')).toBe(
      npmVersionManifestEtag,
    )
    expect(conditionalHeadVersionManifest.headers.get('last-modified')).toBe(
      new Date(publishTimestamp).toUTCString(),
    )
    expect(
      conditionalHeadVersionManifest.headers.get('content-length'),
    ).toBeNull()
    expect(await conditionalHeadVersionManifest.text()).toBe('')

    const subdomainDistTags = await app.request(
      'http://npm.registry.test/-/package/@example.com/hello-regesta/dist-tags',
    )

    expect(subdomainDistTags.status).toBe(200)
    expect(subdomainDistTags.headers.get('cache-control')).toBe('no-cache')
    expect(subdomainDistTags.headers.get('etag')).toBe(npmDistTagsEtag)
    const subdomainDistTagsText = await subdomainDistTags.clone().text()
    expect(subdomainDistTags.headers.get('content-length')).toBe(
      String(Buffer.byteLength(subdomainDistTagsText)),
    )
    await expect(subdomainDistTags.json()).resolves.toEqual({
      latest: '0.0.1',
    })

    const conditionalDistTags = await app.request(
      'http://npm.registry.test/-/package/@example.com/hello-regesta/dist-tags',
      {
        headers: {
          'if-none-match': npmDistTagsEtag,
        },
      },
    )

    expect(conditionalDistTags.status).toBe(304)
    expect(conditionalDistTags.headers.get('cache-control')).toBe('no-cache')
    expect(conditionalDistTags.headers.get('etag')).toBe(npmDistTagsEtag)
    expect(conditionalDistTags.headers.get('content-length')).toBeNull()
    expect(await conditionalDistTags.text()).toBe('')

    const headDistTags = await app.request(
      'http://npm.registry.test/-/package/@example.com/hello-regesta/dist-tags',
      {
        method: 'HEAD',
      },
    )

    expect(headDistTags.status).toBe(200)
    expect(headDistTags.headers.get('cache-control')).toBe('no-cache')
    expect(headDistTags.headers.get('etag')).toBe(npmDistTagsEtag)
    expect(headDistTags.headers.get('content-length')).toBe(
      String(Buffer.byteLength(subdomainDistTagsText)),
    )
    expect(await headDistTags.text()).toBe('')

    const conditionalHeadDistTags = await app.request(
      'http://npm.registry.test/-/package/@example.com/hello-regesta/dist-tags',
      {
        headers: {
          'if-none-match': npmDistTagsEtag,
        },
        method: 'HEAD',
      },
    )

    expect(conditionalHeadDistTags.status).toBe(304)
    expect(conditionalHeadDistTags.headers.get('cache-control')).toBe(
      'no-cache',
    )
    expect(conditionalHeadDistTags.headers.get('etag')).toBe(npmDistTagsEtag)
    expect(conditionalHeadDistTags.headers.get('content-length')).toBeNull()
    expect(await conditionalHeadDistTags.text()).toBe('')

    const subdomainRoot = await app.request('http://npm.registry.test/')

    expect(subdomainRoot.status).toBe(200)
    expect(subdomainRoot.headers.get('cache-control')).toBe('no-cache')
    expect(subdomainRoot.headers.get('content-length')).toBe('2')
    await expect(subdomainRoot.json()).resolves.toEqual({})

    const headRoot = await app.request('http://npm.registry.test/', {
      method: 'HEAD',
    })

    expect(headRoot.status).toBe(200)
    expect(headRoot.headers.get('cache-control')).toBe('no-cache')
    expect(headRoot.headers.get('content-length')).toBe('2')
    expect(headRoot.headers.get('content-type')).toBe(
      'application/json; charset=UTF-8',
    )
    expect(await headRoot.text()).toBe('')

    const subdomainPing = await app.request('http://npm.registry.test/-/ping')

    expect(subdomainPing.status).toBe(200)
    expect(subdomainPing.headers.get('cache-control')).toBe('no-cache')
    expect(subdomainPing.headers.get('content-length')).toBe('15')
    await expect(subdomainPing.json()).resolves.toEqual({ ping: 'pong' })

    const headPing = await app.request('http://npm.registry.test/-/ping', {
      method: 'HEAD',
    })

    expect(headPing.status).toBe(200)
    expect(headPing.headers.get('cache-control')).toBe('no-cache')
    expect(headPing.headers.get('content-length')).toBe('15')
    expect(await headPing.text()).toBe('')

    const subdomainTarball = await app.request(
      'http://npm.registry.test/@example.com/hello-regesta/-/hello-regesta-0.0.1.tgz',
    )

    expect(subdomainTarball.status).toBe(302)
    expect(subdomainTarball.headers.get('cache-control')).toBe('no-cache')
    expect(subdomainTarball.headers.get('location')).toBe(
      installArtifactObjectUrl,
    )
    expect(await subdomainTarball.text()).toBe('')

    const objectTarball = await app.request(installArtifactObjectUrl)

    expect(objectTarball.status).toBe(200)
    const objectTarballBytes = new Uint8Array(await objectTarball.arrayBuffer())
    expect(objectTarballBytes).toEqual(new Uint8Array(installArtifact.bytes))
    expect(objectTarballBytes).not.toEqual(new Uint8Array(prepared.source))

    const rangeTarball = await app.request(installArtifactObjectUrl, {
      headers: {
        range: 'bytes=1-3',
      },
    })
    const invalidRangeTarball = await app.request(installArtifactObjectUrl, {
      headers: {
        range: `bytes=${installArtifact.bytes.byteLength}-`,
      },
    })

    const conditionalTarball = await app.request(
      'http://npm.registry.test/@example.com/hello-regesta/-/hello-regesta-0.0.1.tgz',
      {
        headers: {
          'if-none-match': `"${sha256(installArtifact.bytes)}"`,
        },
      },
    )

    expect(conditionalTarball.status).toBe(302)
    expect(conditionalTarball.headers.get('location')).toBe(
      installArtifactObjectUrl,
    )

    const headTarball = await app.request(
      'http://npm.registry.test/@example.com/hello-regesta/-/hello-regesta-0.0.1.tgz',
      {
        method: 'HEAD',
      },
    )

    expect(headTarball.status).toBe(302)
    expect(headTarball.headers.get('location')).toBe(installArtifactObjectUrl)
    expect(await headTarball.text()).toBe('')

    expect(rangeTarball.status).toBe(206)
    expect(rangeTarball.headers.get('accept-ranges')).toBe('bytes')
    expect(rangeTarball.headers.get('content-range')).toBe(
      `bytes 1-3/${installArtifact.bytes.byteLength}`,
    )
    expect(rangeTarball.headers.get('content-length')).toBe('3')
    expect(new Uint8Array(await rangeTarball.arrayBuffer())).toEqual(
      new Uint8Array(installArtifact.bytes).subarray(1, 4),
    )
    expect(invalidRangeTarball.status).toBe(416)
    expect(invalidRangeTarball.headers.get('accept-ranges')).toBe('bytes')
    expect(invalidRangeTarball.headers.get('content-range')).toBe(
      `bytes */${installArtifact.bytes.byteLength}`,
    )
    expect(await invalidRangeTarball.text()).toBe('')

    const rootPathOnMainHost = await app.request(
      'http://registry.test/@example.com/hello-regesta',
    )

    expect(rootPathOnMainHost.status).toBe(404)
  })

  it('keeps npm projection reads isolated to the database adapter', async () => {
    const adapters = createMemoryRegistryAdapters()

    await publishRelease(
      {
        artifacts: [
          {
            bytes: bytes('install artifact bytes'),
            format: 'npm-tarball',
            mediaType: 'application/gzip',
            role: 'install',
          },
        ],
        config: {
          id: 'npm:example.com/projection-boundary',
          source: {
            include: ['regesta.json'],
          },
          version: '0.0.1',
        },
        createdAt: '2026-06-01T00:00:00.000Z',
        source: bytes('source archive'),
      },
      adapters,
    )

    adapters.objects.get = () => {
      throw new Error('npm projection must not read object bytes')
    }
    adapters.objects.getDescriptor = () => {
      throw new Error('npm projection must not read object descriptors')
    }
    adapters.objects.listDescriptors = () => {
      throw new Error('npm projection must not list objects')
    }
    adapters.objects.put = () => {
      throw new Error('npm projection must not write objects')
    }
    adapters.queue.enqueue = () => {
      throw new Error('npm projection must not enqueue jobs')
    }
    adapters.signer.sign = () => {
      throw new Error('npm projection must not sign bytes')
    }
    if (adapters.checkpoints) {
      adapters.checkpoints.get = () => {
        throw new Error('npm projection must not read checkpoint bytes')
      }
      adapters.checkpoints.getDescriptor = () => {
        throw new Error('npm projection must not read checkpoint descriptors')
      }
      adapters.checkpoints.listDescriptors = () => {
        throw new Error('npm projection must not list checkpoints')
      }
      adapters.checkpoints.put = () => {
        throw new Error('npm projection must not write checkpoints')
      }
    }

    const app = createRegestaApp(adapters)
    const response = await app.request(
      'http://npm.registry.test/@example.com/projection-boundary',
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      'dist-tags': {
        latest: '0.0.1',
      },
      name: '@example.com/projection-boundary',
      versions: {
        '0.0.1': {
          name: '@example.com/projection-boundary',
          version: '0.0.1',
        },
      },
    })
  })

  it('serves locally persisted publish data after app restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'regesta-server-local-'))
    const projectDir = await createFixtureProject({
      dependencies: false,
    })
    const prepared = await prepareFixtureNpmPublish(projectDir)
    const installArtifact = prepared.artifacts[0]
    const auth = createTestDomainAuth()
    const publishTimestamp = new Date().toISOString()
    const publishForm = createSignedPublishForm({
      auth,
      nonce: 'local-persistence-nonce',
      prepared,
      timestamp: publishTimestamp,
    })

    if (!installArtifact) {
      throw new Error('Fixture publish did not produce an install artifact')
    }

    try {
      const firstApp = createRegestaApp(createLocalRegistryAdapters(root))

      vi.stubGlobal('fetch', auth.fetch)

      try {
        const publish = await firstApp.request('/releases', {
          body: publishForm,
          method: 'POST',
        })

        expect(publish.status).toBe(201)
        await expect(publish.json()).resolves.toMatchObject({
          channel: 'latest',
          manifest: {
            id: prepared.config.id,
            metadata: {
              description: 'Fixture package',
            },
            version: prepared.config.version,
          },
        })
      } finally {
        vi.unstubAllGlobals()
      }

      const restartedApp = createRegestaApp(createLocalRegistryAdapters(root))
      const packageId = encodeURIComponent(prepared.config.id)
      const packageState = await restartedApp.request(`/packages/${packageId}`)

      expect(packageState.status).toBe(200)
      await expect(packageState.json()).resolves.toMatchObject({
        channels: {
          latest: prepared.config.version,
        },
        id: prepared.config.id,
        releases: [
          {
            createdAt: publishTimestamp,
            version: prepared.config.version,
          },
        ],
      })

      const verification = await restartedApp.request(
        `/packages/${packageId}/releases/${prepared.config.version}/verification`,
      )

      expect(verification.status).toBe(200)
      await expect(verification.json()).resolves.toMatchObject({
        ok: true,
        problems: [],
      })

      const packument = await restartedApp.request(
        'http://npm.registry.test/@example.com/hello-regesta',
      )
      const installArtifactObjectUrl = `http://registry.test/objects/${sha256(
        installArtifact.bytes,
      )}`
      const localInstallTarballUrl =
        'http://npm.registry.test/@example.com/hello-regesta/-/hello-regesta-0.0.1.tgz'

      expect(packument.status).toBe(200)
      await expect(packument.json()).resolves.toMatchObject({
        'dist-tags': {
          latest: prepared.config.version,
        },
        description: 'Fixture package',
        name: '@example.com/hello-regesta',
        versions: {
          [prepared.config.version]: {
            description: 'Fixture package',
            dist: {
              tarball: localInstallTarballUrl,
            },
            version: prepared.config.version,
          },
        },
      })

      const tarball = await restartedApp.request(
        'http://npm.registry.test/@example.com/hello-regesta/-/hello-regesta-0.0.1.tgz',
      )

      expect(tarball.status).toBe(302)
      expect(tarball.headers.get('location')).toBe(installArtifactObjectUrl)

      const object = await restartedApp.request(installArtifactObjectUrl)

      expect(object.status).toBe(200)
      expect(new Uint8Array(await object.arrayBuffer())).toEqual(
        new Uint8Array(installArtifact.bytes),
      )
    } finally {
      await rm(projectDir, { force: true, recursive: true })
      await rm(root, { force: true, recursive: true })
    }
  })

  it('redirects npm tarball reads without loading artifact bytes', async () => {
    const adapters = createMemoryRegistryAdapters()
    const artifactBytes = bytes('install artifact bytes')
    const artifactDigest = sha256(artifactBytes)

    await publishRelease(
      {
        artifacts: [
          {
            bytes: artifactBytes,
            format: 'npm-tarball',
            mediaType: 'application/gzip',
            role: 'install',
          },
        ],
        config: {
          id: 'npm:example.com/descriptor-tarball',
          source: {
            include: ['regesta.json'],
          },
          version: '0.0.1',
        },
        createdAt: '2026-06-01T00:00:00.000Z',
        source: bytes('source archive'),
      },
      adapters,
    )

    const getObject = adapters.objects.get.bind(adapters.objects)
    const getObjectDescriptor = adapters.objects.getDescriptor.bind(
      adapters.objects,
    )
    let objectGetCalls = 0
    let objectDescriptorGetCalls = 0
    adapters.objects.get = (digest) => {
      objectGetCalls += 1
      return getObject(digest)
    }
    adapters.objects.getDescriptor = (digest) => {
      objectDescriptorGetCalls += 1
      return getObjectDescriptor(digest)
    }
    const app = createRegestaApp(adapters)
    const tarballUrl =
      'http://npm.registry.test/@example.com/descriptor-tarball/-/descriptor-tarball-0.0.1.tgz'
    const localObjectUrl = `http://registry.test/objects/${artifactDigest}`
    const head = await app.request(tarballUrl, {
      method: 'HEAD',
    })
    const rangeHead = await app.request(tarballUrl, {
      headers: {
        range: 'bytes=1-7',
      },
      method: 'HEAD',
    })
    const invalidRangeHead = await app.request(tarballUrl, {
      headers: {
        range: `bytes=${artifactBytes.byteLength}-`,
      },
      method: 'HEAD',
    })
    const conditional = await app.request(tarballUrl, {
      headers: {
        'if-none-match': `"${artifactDigest}"`,
      },
    })
    const invalidRangeGet = await app.request(tarballUrl, {
      headers: {
        range: `bytes=${artifactBytes.byteLength}-`,
      },
    })
    const get = await app.request(tarballUrl)

    expect(head.status).toBe(302)
    expect(head.headers.get('location')).toBe(localObjectUrl)
    expect(await head.text()).toBe('')
    expect(rangeHead.status).toBe(302)
    expect(rangeHead.headers.get('location')).toBe(localObjectUrl)
    expect(await rangeHead.text()).toBe('')
    expect(invalidRangeHead.status).toBe(302)
    expect(invalidRangeHead.headers.get('location')).toBe(localObjectUrl)
    expect(await invalidRangeHead.text()).toBe('')
    expect(conditional.status).toBe(302)
    expect(conditional.headers.get('location')).toBe(localObjectUrl)
    expect(await conditional.text()).toBe('')
    expect(invalidRangeGet.status).toBe(302)
    expect(invalidRangeGet.headers.get('location')).toBe(localObjectUrl)
    expect(await invalidRangeGet.text()).toBe('')
    expect(get.status).toBe(302)
    expect(get.headers.get('location')).toBe(localObjectUrl)
    expect(await get.text()).toBe('')
    expect(objectGetCalls).toBe(0)
    expect(objectDescriptorGetCalls).toBe(0)
  })

  it('uses Host headers for npm projection URLs behind container routing', async () => {
    const adapters = createMemoryRegistryAdapters()
    const artifactBytes = bytes('host header install artifact')
    const artifactDigest = sha256(artifactBytes)

    await publishRelease(
      {
        artifacts: [
          {
            bytes: artifactBytes,
            format: 'npm-tarball',
            mediaType: 'application/gzip',
            role: 'install',
          },
        ],
        config: {
          id: 'npm:example.com/host-header-url',
          source: {
            include: ['regesta.json'],
          },
          version: '1.0.0',
        },
        createdAt: '2026-06-01T00:00:00.000Z',
        source: bytes('source archive'),
      },
      adapters,
    )

    const app = createRegestaApp(adapters)
    const rawOrigin = 'http://127.0.0.1:4321'
    const npmHost = 'npm.localhost:4321'
    const npmTarballUrl =
      'http://npm.localhost:4321/@example.com/host-header-url/-/host-header-url-1.0.0.tgz'
    const objectUrl = `http://localhost:4321/objects/${artifactDigest}`
    const requestInit = {
      headers: {
        host: npmHost,
      },
    }

    const packument = await app.request(
      `${rawOrigin}/@example.com/host-header-url`,
      requestInit,
    )
    const versionManifest = await app.request(
      `${rawOrigin}/@example.com/host-header-url/latest`,
      requestInit,
    )
    const tarball = await app.request(
      `${rawOrigin}/@example.com/host-header-url/-/host-header-url-1.0.0.tgz`,
      requestInit,
    )

    expect(packument.status).toBe(200)
    await expect(packument.json()).resolves.toMatchObject({
      versions: {
        '1.0.0': {
          dist: {
            tarball: npmTarballUrl,
          },
        },
      },
    })
    expect(versionManifest.status).toBe(200)
    await expect(versionManifest.json()).resolves.toMatchObject({
      dist: {
        tarball: npmTarballUrl,
      },
    })
    expect(tarball.status).toBe(302)
    expect(tarball.headers.get('location')).toBe(objectUrl)
  })

  it('redirects missing local-looking npm tarball routes without listing releases', async () => {
    const adapters = createMemoryRegistryAdapters()
    const listPackageReleases = adapters.database.listPackageReleases.bind(
      adapters.database,
    )
    let releaseListCalls = 0
    adapters.database.listPackageReleases = (packageId, options) => {
      releaseListCalls += 1

      return listPackageReleases(packageId, options)
    }
    const upstreamFetch = vi.fn<typeof fetch>()

    const app = createRegestaApp(adapters, {
      npmUpstreamFetch: upstreamFetch,
    })
    const response = await app.request(
      'http://npm.registry.test/@example.com/descriptor-tarball/-/descriptor-tarball-9.9.9.tgz',
    )
    const head = await app.request(
      'http://npm.registry.test/@example.com/descriptor-tarball/-/descriptor-tarball-9.9.9.tgz',
      {
        method: 'HEAD',
      },
    )

    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe(
      'https://registry.npmjs.org/%40example.com%2Fdescriptor-tarball/-/descriptor-tarball-9.9.9.tgz',
    )
    expect(await response.text()).toBe('')
    expect(head.status).toBe(302)
    expect(head.headers.get('location')).toBe(
      'https://registry.npmjs.org/%40example.com%2Fdescriptor-tarball/-/descriptor-tarball-9.9.9.tgz',
    )
    expect(await head.text()).toBe('')
    expect(releaseListCalls).toBe(0)
    expect(upstreamFetch).not.toHaveBeenCalled()
  })

  it('redirects npm tarball reads without validating artifact bytes in the npm layer', async () => {
    const adapters = createMemoryRegistryAdapters()
    const artifactBytes = bytes('install artifact bytes')
    const artifactDigest = sha256(artifactBytes)

    await publishRelease(
      {
        artifacts: [
          {
            bytes: artifactBytes,
            format: 'npm-tarball',
            mediaType: 'application/gzip',
            role: 'install',
          },
        ],
        config: {
          id: 'npm:example.com/mismatched-tarball-descriptor',
          source: {
            include: ['regesta.json'],
          },
          version: '0.0.1',
        },
        createdAt: '2026-06-01T00:00:00.000Z',
        source: bytes('source archive'),
      },
      adapters,
    )

    const getObject = adapters.objects.get.bind(adapters.objects)
    let objectGetCalls = 0
    adapters.objects.get = async (digest) => {
      objectGetCalls += 1
      const object = await getObject(digest)

      return object && digest === artifactDigest
        ? {
            ...object,
            bytes: bytes('install artifact bytez'),
          }
        : object
    }
    const app = createRegestaApp(adapters)

    const response = await app.request(
      'http://npm.registry.test/@example.com/mismatched-tarball-descriptor/-/mismatched-tarball-descriptor-0.0.1.tgz',
    )

    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe(
      `http://registry.test/objects/${artifactDigest}`,
    )
    expect(objectGetCalls).toBe(0)
  })

  it('supports real npm installs through the npm projection host', async () => {
    const adapters = createMemoryRegistryAdapters()
    const app = createRegestaApp(adapters)
    const projectDir = await createFixtureProject({
      dependencies: false,
    })
    const installDir = await mkdtemp(join(tmpdir(), 'regesta-npm-install-'))
    const server = await listenForNpmInstall(app)

    try {
      const prepared = await prepareFixtureNpmPublish(projectDir)
      await publishRelease(
        {
          artifacts: prepared.artifacts,
          config: prepared.config,
          createdAt: '2026-06-01T00:00:00.000Z',
          source: prepared.source,
        },
        adapters,
      )
      await writeFile(
        join(installDir, 'package.json'),
        '{"private":true,"type":"module"}\n',
      )
      await execFileAsync(
        'npm',
        [
          'install',
          '--audit=false',
          '--fund=false',
          '--ignore-scripts',
          '--package-lock=false',
          '--registry',
          server.origin,
          '--cache',
          join(installDir, '.npm-cache'),
          '@example.com/hello-regesta@latest',
        ],
        {
          cwd: installDir,
          env: {
            ...process.env,
            npm_config_update_notifier: 'false',
          },
        },
      )

      const installedPackageJson = JSON.parse(
        await readFile(
          join(
            installDir,
            'node_modules',
            '@example.com',
            'hello-regesta',
            'package.json',
          ),
          'utf8',
        ),
      )
      const installedSource = await readFile(
        join(
          installDir,
          'node_modules',
          '@example.com',
          'hello-regesta',
          'src',
          'index.ts',
        ),
        'utf8',
      )

      expect(installedPackageJson).toMatchObject({
        name: '@example.com/hello-regesta',
        version: '0.0.1',
      })
      expect(installedSource).toBe('export const value = 1\n')
    } finally {
      await server.close()
      await rm(projectDir, { force: true, recursive: true })
      await rm(installDir, { force: true, recursive: true })
    }
  })

  it('falls back to npmjs packuments without rewriting metadata or proxying tarballs', async () => {
    const fetchCalls: Array<{
      credentials?: string
      headers: Headers
      method: string
      redirect?: string
      url: string
    }> = []
    const upstreamHeaders = {
      'cache-control': 'public, max-age=300',
      connection: 'keep-alive',
      'content-type': 'application/json',
      etag: '"upstream-etag"',
      'last-modified': 'Wed, 10 Jun 2026 00:00:00 GMT',
      location: 'https://registry.npmjs.org/login',
      'set-cookie': 'npm_token=secret',
      'www-authenticate': 'Bearer realm="npm"',
      'x-upstream-secret': 'secret',
    }
    const fetchMock: typeof fetch = (input, init) => {
      const request = {
        credentials: init?.credentials,
        headers: new Headers(init?.headers),
        method: init?.method ?? 'GET',
        redirect: init?.redirect,
        url: String(input),
      }
      fetchCalls.push(request)

      if (request.headers.get('if-none-match') === '"upstream-etag"') {
        return Promise.resolve(
          new Response(null, {
            headers: upstreamHeaders,
            status: 304,
          }),
        )
      }

      if (
        request.url === 'https://registry.npmjs.org/%40upstream%2Fpkg/latest'
      ) {
        return Promise.resolve(
          Response.json(
            {
              dist: {
                tarball:
                  'https://registry.npmjs.org/@upstream/pkg/-/pkg-1.0.0.tgz',
              },
              name: '@upstream/pkg',
              version: '1.0.0',
            },
            {
              headers: upstreamHeaders,
            },
          ),
        )
      }

      if (request.url === 'https://registry.npmjs.org/tinyexec/latest') {
        return Promise.resolve(
          Response.json(
            {
              dist: {
                tarball:
                  'https://registry.npmjs.org/tinyexec/-/tinyexec-0.0.1.tgz',
              },
              name: 'tinyexec',
              version: '0.0.1',
            },
            {
              headers: upstreamHeaders,
            },
          ),
        )
      }

      if (
        request.url ===
        'https://registry.npmjs.org/%40example.com%2Ffallback/latest'
      ) {
        return Promise.resolve(
          Response.json(
            {
              dist: {
                tarball:
                  'https://registry.npmjs.org/@example.com/fallback/-/fallback-2.0.0.tgz',
              },
              name: '@example.com/fallback',
              version: '2.0.0',
            },
            {
              headers: upstreamHeaders,
            },
          ),
        )
      }

      if (
        request.url ===
        'https://registry.npmjs.org/-/package/%40upstream%2Fpkg/dist-tags'
      ) {
        return Promise.resolve(
          Response.json(
            {
              latest: '1.0.0',
            },
            {
              headers: upstreamHeaders,
            },
          ),
        )
      }

      return Promise.resolve(
        Response.json(
          {
            'dist-tags': {
              latest: '1.0.0',
            },
            name: '@upstream/pkg',
            versions: {
              '1.0.0': {
                dist: {
                  tarball:
                    'https://registry.npmjs.org/@upstream/pkg/-/pkg-1.0.0.tgz',
                },
                name: '@upstream/pkg',
                version: '1.0.0',
              },
            },
          },
          {
            headers: upstreamHeaders,
          },
        ),
      )
    }
    const app = createRegestaApp(createMemoryRegistryAdapters(), {
      npmUpstreamFetch: fetchMock,
    })
    const sensitiveRequestHeaders = {
      authorization: 'Bearer regesta-local-token',
      cookie: 'npm_token=secret',
      'npm-auth-token': 'secret',
      'x-custom-secret': 'secret',
    }

    const packument = await app.request(
      'http://npm.registry.test/@upstream/pkg',
      {
        headers: sensitiveRequestHeaders,
      },
    )

    expect(packument.status).toBe(200)
    expect(packument.headers.get('cache-control')).toBe('public, max-age=300')
    const fallbackEtag = requiredHeader(packument, 'etag')
    expect(fallbackEtag).toBe('"upstream-etag"')
    expect(packument.headers.get('last-modified')).toBe(
      'Wed, 10 Jun 2026 00:00:00 GMT',
    )
    expectNoSensitiveUpstreamResponseHeaders(packument)
    expect(fetchCalls.map((request) => request.url)).toEqual([
      'https://registry.npmjs.org/%40upstream%2Fpkg',
    ])
    expect(fetchCalls[0]!.headers.get('accept')).toBe('application/json')
    expectNoSensitiveUpstreamRequestHeaders(fetchCalls[0]!.headers)
    expect(fetchCalls[0]!.credentials).toBe('omit')
    expect(fetchCalls[0]!.method).toBe('GET')
    expect(fetchCalls[0]!.redirect).toBe('error')
    await expect(packument.json()).resolves.toMatchObject({
      name: '@upstream/pkg',
      versions: {
        '1.0.0': {
          dist: {
            tarball: 'https://registry.npmjs.org/@upstream/pkg/-/pkg-1.0.0.tgz',
          },
        },
      },
    })

    const conditionalPackument = await app.request(
      'http://npm.registry.test/@upstream/pkg',
      {
        headers: {
          'if-modified-since': 'Tue, 09 Jun 2026 00:00:00 GMT',
          'if-none-match': fallbackEtag,
        },
      },
    )

    expect(conditionalPackument.status).toBe(304)
    expect(conditionalPackument.headers.get('cache-control')).toBe(
      'public, max-age=300',
    )
    expect(conditionalPackument.headers.get('etag')).toBe(fallbackEtag)
    expect(conditionalPackument.headers.get('last-modified')).toBe(
      'Wed, 10 Jun 2026 00:00:00 GMT',
    )
    expectNoSensitiveUpstreamResponseHeaders(conditionalPackument)
    expect(fetchCalls.at(-1)?.headers.get('if-modified-since')).toBe(
      'Tue, 09 Jun 2026 00:00:00 GMT',
    )
    expect(fetchCalls.at(-1)?.headers.get('if-none-match')).toBe(fallbackEtag)

    const headPackument = await app.request(
      'http://npm.registry.test/@upstream/pkg',
      {
        method: 'HEAD',
      },
    )

    expect(headPackument.status).toBe(200)
    expect(headPackument.headers.get('etag')).toBe('"upstream-etag"')
    expect(headPackument.headers.get('last-modified')).toBe(
      'Wed, 10 Jun 2026 00:00:00 GMT',
    )
    expectNoSensitiveUpstreamResponseHeaders(headPackument)
    expect(await headPackument.text()).toBe('')
    expect(fetchCalls.at(-1)?.method).toBe('HEAD')

    const manifest = await app.request(
      'http://npm.registry.test/@upstream/pkg/latest',
      {
        headers: sensitiveRequestHeaders,
      },
    )

    expect(manifest.status).toBe(200)
    expect(fetchCalls.at(-1)?.url).toBe(
      'https://registry.npmjs.org/%40upstream%2Fpkg/latest',
    )
    await expect(manifest.json()).resolves.toMatchObject({
      dist: {
        tarball: 'https://registry.npmjs.org/@upstream/pkg/-/pkg-1.0.0.tgz',
      },
    })

    const headManifest = await app.request(
      'http://npm.registry.test/@upstream/pkg/latest',
      {
        headers: sensitiveRequestHeaders,
        method: 'HEAD',
      },
    )

    expect(headManifest.status).toBe(200)
    expect(headManifest.headers.get('cache-control')).toBe(
      'public, max-age=300',
    )
    expect(headManifest.headers.get('etag')).toBe('"upstream-etag"')
    expect(headManifest.headers.get('last-modified')).toBe(
      'Wed, 10 Jun 2026 00:00:00 GMT',
    )
    expectNoSensitiveUpstreamResponseHeaders(headManifest)
    expect(await headManifest.text()).toBe('')
    expect(fetchCalls.at(-1)?.method).toBe('HEAD')
    expect(fetchCalls.at(-1)?.url).toBe(
      'https://registry.npmjs.org/%40upstream%2Fpkg/latest',
    )

    const unscopedManifest = await app.request(
      'http://npm.registry.test/tinyexec/latest',
    )

    expect(unscopedManifest.status).toBe(200)
    expect(fetchCalls.at(-1)?.url).toBe(
      'https://registry.npmjs.org/tinyexec/latest',
    )
    await expect(unscopedManifest.json()).resolves.toMatchObject({
      dist: {
        tarball: 'https://registry.npmjs.org/tinyexec/-/tinyexec-0.0.1.tgz',
      },
    })

    const deployedUnscopedManifest = await app.request(
      'https://npm.regesta.dev/tinyexec/latest',
    )

    expect(deployedUnscopedManifest.status).toBe(200)
    expect(fetchCalls.at(-1)?.url).toBe(
      'https://registry.npmjs.org/tinyexec/latest',
    )
    await expect(deployedUnscopedManifest.json()).resolves.toMatchObject({
      dist: {
        tarball: 'https://registry.npmjs.org/tinyexec/-/tinyexec-0.0.1.tgz',
      },
    })

    const domainScopedFallbackManifest = await app.request(
      'http://npm.registry.test/@example.com/fallback/latest',
    )

    expect(domainScopedFallbackManifest.status).toBe(200)
    expect(fetchCalls.at(-1)?.url).toBe(
      'https://registry.npmjs.org/%40example.com%2Ffallback/latest',
    )
    await expect(domainScopedFallbackManifest.json()).resolves.toMatchObject({
      dist: {
        tarball:
          'https://registry.npmjs.org/@example.com/fallback/-/fallback-2.0.0.tgz',
      },
    })

    const distTags = await app.request(
      'http://npm.registry.test/-/package/@upstream/pkg/dist-tags',
      {
        headers: sensitiveRequestHeaders,
      },
    )

    expect(distTags.status).toBe(200)
    const distTagsEtag = requiredHeader(distTags, 'etag')
    expect(distTags.headers.get('cache-control')).toBe('public, max-age=300')
    expect(distTags.headers.get('last-modified')).toBe(
      'Wed, 10 Jun 2026 00:00:00 GMT',
    )
    expectNoSensitiveUpstreamResponseHeaders(distTags)
    expect(distTagsEtag).toBe('"upstream-etag"')
    expect(fetchCalls.at(-1)?.url).toBe(
      'https://registry.npmjs.org/-/package/%40upstream%2Fpkg/dist-tags',
    )
    await expect(distTags.json()).resolves.toEqual({
      latest: '1.0.0',
    })

    const conditionalDistTags = await app.request(
      'http://npm.registry.test/-/package/@upstream/pkg/dist-tags',
      {
        headers: {
          'if-modified-since': 'Tue, 09 Jun 2026 00:00:00 GMT',
          'if-none-match': distTagsEtag,
        },
      },
    )

    expect(conditionalDistTags.status).toBe(304)
    expect(conditionalDistTags.headers.get('content-length')).toBeNull()
    expect(conditionalDistTags.headers.get('etag')).toBe(distTagsEtag)
    expectNoSensitiveUpstreamResponseHeaders(conditionalDistTags)
    expect(fetchCalls.at(-1)?.headers.get('if-modified-since')).toBe(
      'Tue, 09 Jun 2026 00:00:00 GMT',
    )
    expect(fetchCalls.at(-1)?.headers.get('if-none-match')).toBe(distTagsEtag)

    const headDistTags = await app.request(
      'http://npm.registry.test/-/package/@upstream/pkg/dist-tags',
      {
        headers: sensitiveRequestHeaders,
        method: 'HEAD',
      },
    )

    expect(headDistTags.status).toBe(200)
    expect(headDistTags.headers.get('cache-control')).toBe(
      'public, max-age=300',
    )
    expect(headDistTags.headers.get('etag')).toBe('"upstream-etag"')
    expect(headDistTags.headers.get('last-modified')).toBe(
      'Wed, 10 Jun 2026 00:00:00 GMT',
    )
    expectNoSensitiveUpstreamResponseHeaders(headDistTags)
    expect(await headDistTags.text()).toBe('')
    expect(fetchCalls.at(-1)?.method).toBe('HEAD')
    expect(fetchCalls.at(-1)?.url).toBe(
      'https://registry.npmjs.org/-/package/%40upstream%2Fpkg/dist-tags',
    )
    expect(
      fetchCalls.every((request) => {
        return request.credentials === 'omit' && request.redirect === 'error'
      }),
    ).toBe(true)
    expect(
      fetchCalls.every((request) => {
        expectNoSensitiveUpstreamRequestHeaders(request.headers)
        return true
      }),
    ).toBe(true)

    const fetchCallsBeforeTarballs = fetchCalls.length
    const tarball = await app.request(
      'http://npm.registry.test/@upstream/pkg/-/pkg-1.0.0.tgz',
    )

    expect(tarball.status).toBe(302)
    expect(tarball.headers.get('location')).toBe(
      'https://registry.npmjs.org/%40upstream%2Fpkg/-/pkg-1.0.0.tgz',
    )
    expect(await tarball.text()).toBe('')
    expect(fetchCalls).toHaveLength(fetchCallsBeforeTarballs)
    const domainScopedFallbackTarball = await app.request(
      'http://npm.registry.test/@example.com/fallback/-/fallback-2.0.0.tgz',
    )

    expect(domainScopedFallbackTarball.status).toBe(302)
    expect(domainScopedFallbackTarball.headers.get('location')).toBe(
      'https://registry.npmjs.org/%40example.com%2Ffallback/-/fallback-2.0.0.tgz',
    )
    expect(await domainScopedFallbackTarball.text()).toBe('')
    expect(fetchCalls).toHaveLength(fetchCallsBeforeTarballs)
    const unscopedTarball = await app.request(
      'http://npm.registry.test/tinyexec/-/tinyexec-0.0.1.tgz',
    )

    expect(unscopedTarball.status).toBe(302)
    expect(unscopedTarball.headers.get('location')).toBe(
      'https://registry.npmjs.org/tinyexec/-/tinyexec-0.0.1.tgz',
    )
    expect(await unscopedTarball.text()).toBe('')
    expect(fetchCalls).toHaveLength(fetchCallsBeforeTarballs)
    const deployedUnscopedTarball = await app.request(
      'https://npm.regesta.dev/tinyexec/-/tinyexec-0.0.1.tgz',
    )

    expect(deployedUnscopedTarball.status).toBe(302)
    expect(deployedUnscopedTarball.headers.get('location')).toBe(
      'https://registry.npmjs.org/tinyexec/-/tinyexec-0.0.1.tgz',
    )
    expect(await deployedUnscopedTarball.text()).toBe('')
    expect(fetchCalls).toHaveLength(fetchCallsBeforeTarballs)
    const deployedUnscopedTarballHead = await app.request(
      'https://npm.regesta.dev/tinyexec/-/tinyexec-0.0.1.tgz',
      {
        method: 'HEAD',
      },
    )

    expect(deployedUnscopedTarballHead.status).toBe(302)
    expect(deployedUnscopedTarballHead.headers.get('location')).toBe(
      'https://registry.npmjs.org/tinyexec/-/tinyexec-0.0.1.tgz',
    )
    expect(await deployedUnscopedTarballHead.text()).toBe('')
    expect(fetchCalls).toHaveLength(fetchCallsBeforeTarballs)

    const fallbackPackageState = await app.request(
      `/packages/${encodeURIComponent('npm:example.com/fallback')}`,
    )

    expect(fallbackPackageState.status).toBe(404)
    await expect(fallbackPackageState.json()).resolves.toMatchObject({
      code: 'package_not_found',
      error: 'Package not found',
      message: 'Package not found',
    })
  })

  it('logs upstream npm fallback failures while returning structured errors', async () => {
    const upstreamError = new Error('upstream timeout')
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const fetchMock: typeof fetch = () => Promise.reject(upstreamError)
    const app = createRegestaApp(createMemoryRegistryAdapters(), {
      npmUpstreamFetch: fetchMock,
    })

    try {
      const response = await app.request(
        'http://npm.registry.test/@upstream/pkg',
        {
          headers: {
            'x-request-id': 'upstream-fallback-001',
          },
        },
      )

      expect(response.status).toBe(502)
      expect(response.headers.get('x-request-id')).toBe('upstream-fallback-001')
      await expect(response.json()).resolves.toMatchObject({
        code: 'upstream_npm_registry_unavailable',
        error: 'Upstream npm registry unavailable',
        message: 'Upstream npm registry unavailable',
      })
      expect(consoleError).toHaveBeenCalledWith(
        'Upstream npm registry request failed',
        expect.objectContaining({
          error: upstreamError,
          kind: 'regesta.npm-upstream-failure',
          requestId: 'upstream-fallback-001',
          url: 'https://registry.npmjs.org/%40upstream%2Fpkg',
        }),
      )
    } finally {
      consoleError.mockRestore()
    }
  })

  it('rejects invalid upstream npm fallback timeout configuration', () => {
    expect(() =>
      createRegestaApp(createMemoryRegistryAdapters(), {
        npmUpstream: {
          upstreamTimeoutMs: -1,
        },
      }),
    ).toThrow('Upstream npm fetch timeout must be a non-negative safe integer')
  })

  it('bounds upstream npm fallback metadata requests with configured timeouts', async () => {
    vi.useFakeTimers()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const fetchMock: typeof fetch = (_input, init) => {
      const signal = init?.signal

      if (!signal) {
        return Promise.reject(new Error('missing upstream abort signal'))
      }

      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), {
          once: true,
        })
      })
    }
    const app = createRegestaApp(createMemoryRegistryAdapters(), {
      npmUpstream: {
        upstreamTimeoutMs: 50,
      },
      npmUpstreamFetch: fetchMock,
    })

    try {
      const pendingResponse = app.request(
        'http://npm.registry.test/@upstream/pkg',
        {
          headers: {
            'x-request-id': 'upstream-timeout-001',
          },
        },
      )

      await vi.advanceTimersByTimeAsync(50)

      const response = await pendingResponse
      expect(response.status).toBe(502)
      expect(response.headers.get('x-request-id')).toBe('upstream-timeout-001')
      await expect(response.json()).resolves.toMatchObject({
        code: 'upstream_npm_registry_unavailable',
        error: 'Upstream npm registry unavailable',
        message: 'Upstream npm registry unavailable',
      })
      expect(consoleError).toHaveBeenCalledWith(
        'Upstream npm registry request failed',
        expect.objectContaining({
          error: expect.objectContaining({
            message: 'Upstream npm registry request timed out',
          }),
          kind: 'regesta.npm-upstream-failure',
          requestId: 'upstream-timeout-001',
          url: 'https://registry.npmjs.org/%40upstream%2Fpkg',
        }),
      )
    } finally {
      consoleError.mockRestore()
      vi.useRealTimers()
    }
  })

  it('can disable upstream npm fallback timeout handling', async () => {
    const signals: Array<RequestInit['signal'] | undefined> = []
    const fetchMock: typeof fetch = (_input, init) => {
      signals.push(init?.signal)

      return Promise.resolve(
        Response.json({
          'dist-tags': {
            latest: '1.0.0',
          },
          name: 'no-timeout',
          versions: {
            '1.0.0': {
              dist: {
                tarball:
                  'https://registry.npmjs.org/no-timeout/-/no-timeout-1.0.0.tgz',
              },
              name: 'no-timeout',
              version: '1.0.0',
            },
          },
        }),
      )
    }
    const app = createRegestaApp(createMemoryRegistryAdapters(), {
      npmUpstream: {
        upstreamTimeoutMs: 0,
      },
      npmUpstreamFetch: fetchMock,
    })

    const response = await app.request('http://npm.registry.test/no-timeout')

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      name: 'no-timeout',
    })
    expect(signals).toEqual([undefined])
  })

  it('logs upstream npm fallback 5xx responses while returning structured errors', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const fetchMock: typeof fetch = () => {
      return Promise.resolve(
        new Response('<h1>upstream unavailable</h1>', {
          headers: {
            'content-type': 'text/html',
          },
          status: 503,
          statusText: 'Service Unavailable',
        }),
      )
    }
    const app = createRegestaApp(createMemoryRegistryAdapters(), {
      npmUpstreamFetch: fetchMock,
    })

    try {
      const packument = await app.request('http://npm.registry.test/broken', {
        headers: {
          'x-request-id': 'upstream-5xx-packument',
        },
      })
      const manifest = await app.request(
        'http://npm.registry.test/broken/latest',
        {
          headers: {
            'x-request-id': 'upstream-5xx-manifest',
          },
        },
      )
      const distTags = await app.request(
        'http://npm.registry.test/-/package/broken/dist-tags',
        {
          headers: {
            'x-request-id': 'upstream-5xx-dist-tags',
          },
        },
      )

      for (const response of [packument, manifest, distTags]) {
        expect(response.status).toBe(502)
        expect(response.headers.get('content-type')).toBe('application/json')
        await expect(response.json()).resolves.toMatchObject({
          code: 'upstream_npm_registry_unavailable',
          error: 'Upstream npm registry unavailable',
          message: 'Upstream npm registry unavailable',
        })
      }
      expect(consoleError).toHaveBeenCalledTimes(3)
      expect(consoleError).toHaveBeenCalledWith(
        'Upstream npm registry returned an unavailable response',
        expect.objectContaining({
          kind: 'regesta.npm-upstream-unavailable',
          requestId: 'upstream-5xx-packument',
          status: 503,
          statusText: 'Service Unavailable',
          url: 'https://registry.npmjs.org/broken',
        }),
      )
      expect(consoleError).toHaveBeenCalledWith(
        'Upstream npm registry returned an unavailable response',
        expect.objectContaining({
          kind: 'regesta.npm-upstream-unavailable',
          requestId: 'upstream-5xx-manifest',
          status: 503,
          statusText: 'Service Unavailable',
          url: 'https://registry.npmjs.org/broken/latest',
        }),
      )
      expect(consoleError).toHaveBeenCalledWith(
        'Upstream npm registry returned an unavailable response',
        expect.objectContaining({
          kind: 'regesta.npm-upstream-unavailable',
          requestId: 'upstream-5xx-dist-tags',
          status: 503,
          statusText: 'Service Unavailable',
          url: 'https://registry.npmjs.org/-/package/broken/dist-tags',
        }),
      )
    } finally {
      consoleError.mockRestore()
    }
  })

  it('rejects unprojectable upstream npm metadata responses', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const fetchMock: typeof fetch = () => {
      return Promise.resolve(
        new Response('not json', {
          headers: {
            'content-type': 'text/plain',
          },
        }),
      )
    }
    const app = createRegestaApp(createMemoryRegistryAdapters(), {
      npmUpstreamFetch: fetchMock,
    })

    try {
      const packument = await app.request('http://npm.registry.test/broken', {
        headers: {
          'x-request-id': 'upstream-invalid-json-packument',
        },
      })
      const manifest = await app.request(
        'http://npm.registry.test/broken/latest',
        {
          headers: {
            'x-request-id': 'upstream-invalid-json-manifest',
          },
        },
      )
      const distTags = await app.request(
        'http://npm.registry.test/-/package/broken/dist-tags',
        {
          headers: {
            'x-request-id': 'upstream-invalid-json-dist-tags',
          },
        },
      )

      expect(packument.status).toBe(502)
      expect(packument.headers.get('content-type')).toBe('application/json')
      await expect(packument.json()).resolves.toMatchObject({
        code: 'upstream_npm_registry_unavailable',
        error: 'Upstream npm registry unavailable',
        message: 'Upstream npm registry unavailable',
      })
      expect(manifest.status).toBe(502)
      await expect(manifest.json()).resolves.toMatchObject({
        code: 'upstream_npm_registry_unavailable',
      })
      expect(distTags.status).toBe(502)
      await expect(distTags.json()).resolves.toMatchObject({
        code: 'upstream_npm_registry_unavailable',
      })
      expect(consoleError).toHaveBeenCalledTimes(3)
      expect(consoleError).toHaveBeenCalledWith(
        'Upstream npm registry response was not valid JSON',
        expect.objectContaining({
          kind: 'regesta.npm-upstream-invalid-json',
          requestId: 'upstream-invalid-json-packument',
          url: 'https://registry.npmjs.org/broken',
        }),
      )
      expect(consoleError).toHaveBeenCalledWith(
        'Upstream npm registry response was not valid JSON',
        expect.objectContaining({
          kind: 'regesta.npm-upstream-invalid-json',
          requestId: 'upstream-invalid-json-manifest',
          url: 'https://registry.npmjs.org/broken/latest',
        }),
      )
      expect(consoleError).toHaveBeenCalledWith(
        'Upstream npm registry response was not valid JSON',
        expect.objectContaining({
          kind: 'regesta.npm-upstream-invalid-json',
          requestId: 'upstream-invalid-json-dist-tags',
          url: 'https://registry.npmjs.org/-/package/broken/dist-tags',
        }),
      )
    } finally {
      consoleError.mockRestore()
    }
  })

  it('rejects upstream npm dist-tags that do not match the projected shape', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const fetchMock: typeof fetch = () => {
      return Promise.resolve(
        Response.json({
          latest: 1,
        }),
      )
    }
    const app = createRegestaApp(createMemoryRegistryAdapters(), {
      npmUpstreamFetch: fetchMock,
    })

    try {
      const response = await app.request(
        'http://npm.registry.test/-/package/broken/dist-tags',
        {
          headers: {
            'x-request-id': 'upstream-invalid-dist-tags',
          },
        },
      )

      expect(response.status).toBe(502)
      await expect(response.json()).resolves.toMatchObject({
        code: 'upstream_npm_registry_unavailable',
        error: 'Upstream npm registry unavailable',
        message: 'Upstream npm registry unavailable',
      })
      expect(consoleError).toHaveBeenCalledWith(
        'Upstream npm registry response did not match projection shape',
        expect.objectContaining({
          kind: 'regesta.npm-upstream-invalid-metadata',
          requestId: 'upstream-invalid-dist-tags',
          url: 'https://registry.npmjs.org/-/package/broken/dist-tags',
        }),
      )
    } finally {
      consoleError.mockRestore()
    }
  })

  it('rejects upstream npm package metadata that does not match projected shapes', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const fetchMock: typeof fetch = (input) => {
      const url = String(input)

      if (url === 'https://registry.npmjs.org/broken/latest') {
        return Promise.resolve(
          Response.json({
            dist: {},
            name: 'broken',
            version: '1.0.0',
          }),
        )
      }

      return Promise.resolve(
        Response.json({
          'dist-tags': {
            latest: '1.0.0',
          },
          name: 'broken',
          versions: {
            '1.0.0': {
              dist: {},
              name: 'broken',
              version: '1.0.0',
            },
          },
        }),
      )
    }
    const app = createRegestaApp(createMemoryRegistryAdapters(), {
      npmUpstreamFetch: fetchMock,
    })

    try {
      const packument = await app.request('http://npm.registry.test/broken', {
        headers: {
          'x-request-id': 'upstream-invalid-packument-shape',
        },
      })
      const manifest = await app.request(
        'http://npm.registry.test/broken/latest',
        {
          headers: {
            'x-request-id': 'upstream-invalid-version-shape',
          },
        },
      )

      expect(packument.status).toBe(502)
      await expect(packument.json()).resolves.toMatchObject({
        code: 'upstream_npm_registry_unavailable',
      })
      expect(manifest.status).toBe(502)
      await expect(manifest.json()).resolves.toMatchObject({
        code: 'upstream_npm_registry_unavailable',
      })
      expect(consoleError).toHaveBeenCalledTimes(2)
      expect(consoleError).toHaveBeenCalledWith(
        'Upstream npm registry response did not match projection shape',
        expect.objectContaining({
          kind: 'regesta.npm-upstream-invalid-metadata',
          requestId: 'upstream-invalid-packument-shape',
          url: 'https://registry.npmjs.org/broken',
        }),
      )
      expect(consoleError).toHaveBeenCalledWith(
        'Upstream npm registry response did not match projection shape',
        expect.objectContaining({
          kind: 'regesta.npm-upstream-invalid-metadata',
          requestId: 'upstream-invalid-version-shape',
          url: 'https://registry.npmjs.org/broken/latest',
        }),
      )
    } finally {
      consoleError.mockRestore()
    }
  })

  it('redirects fallback npm tarball routes without fetching upstream tarball bytes', async () => {
    const fetchMock = vi.fn<typeof fetch>()
    const app = createRegestaApp(createMemoryRegistryAdapters(), {
      npmUpstreamFetch: fetchMock,
    })

    const getResponse = await app.request(
      'https://npm.regesta.dev/tinyexec/-/tinyexec-0.0.1.tgz',
    )

    expect(getResponse.status).toBe(302)
    expect(getResponse.headers.get('location')).toBe(
      'https://registry.npmjs.org/tinyexec/-/tinyexec-0.0.1.tgz',
    )
    expect(await getResponse.text()).toBe('')

    const headResponse = await app.request(
      'https://npm.regesta.dev/tinyexec/-/tinyexec-0.0.1.tgz',
      {
        method: 'HEAD',
      },
    )

    expect(headResponse.status).toBe(302)
    expect(headResponse.headers.get('location')).toBe(
      'https://registry.npmjs.org/tinyexec/-/tinyexec-0.0.1.tgz',
    )
    expect(await headResponse.text()).toBe('')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('resolves npm tag endpoints through indexed channel state', async () => {
    const adapters = createMemoryRegistryAdapters()
    const app = createRegestaApp(adapters)
    const packageId = 'npm:example.com/stale-channel'

    await publishRelease(
      {
        artifacts: [
          {
            bytes: bytes('install artifact'),
            mediaType: 'application/gzip',
            role: 'install',
          },
        ],
        config: {
          id: packageId,
          source: {
            include: ['regesta.json'],
          },
          version: '1.0.0',
        },
        createdAt: '2026-06-01T00:00:00.000Z',
        source: bytes('source archive'),
      },
      adapters,
    )
    adapters.database.listPackageReleases = () =>
      Promise.reject(new Error('npm tag endpoints should not list releases'))

    const distTags = await app.request(
      'http://npm.registry.test/-/package/@example.com/stale-channel/dist-tags',
    )
    const manifest = await app.request(
      'http://npm.registry.test/@example.com/stale-channel/latest',
    )

    expect(distTags.status).toBe(200)
    await expect(distTags.json()).resolves.toEqual({
      latest: '1.0.0',
    })
    expect(manifest.status).toBe(200)
    await expect(manifest.json()).resolves.toMatchObject({
      name: '@example.com/stale-channel',
      version: '1.0.0',
    })
  })

  it('derives npm packument modified time from channel events without changing version times', async () => {
    const adapters = createMemoryRegistryAdapters()
    const app = createRegestaApp(adapters)
    const packageId = 'npm:example.com/channel-time'

    await publishRelease(
      {
        artifacts: [
          {
            bytes: bytes('install artifact 1.0.0'),
            mediaType: 'application/gzip',
            role: 'install',
          },
        ],
        config: {
          id: packageId,
          source: {
            include: ['regesta.json'],
          },
          version: '1.0.0',
        },
        createdAt: '2026-06-01T00:00:00.000Z',
        source: bytes('source archive 1.0.0'),
      },
      adapters,
    )
    await publishRelease(
      {
        artifacts: [
          {
            bytes: bytes('install artifact 1.1.0'),
            mediaType: 'application/gzip',
            role: 'install',
          },
        ],
        config: {
          id: packageId,
          source: {
            include: ['regesta.json'],
          },
          version: '1.1.0',
        },
        createdAt: '2026-06-02T00:00:00.000Z',
        source: bytes('source archive 1.1.0'),
      },
      adapters,
    )
    await updatePackageChannel(adapters, {
      channel: 'latest',
      packageId,
      timestamp: '2026-06-03T00:00:00.000Z',
      version: '1.0.0',
    })

    const response = await app.request(
      'http://npm.registry.test/@example.com/channel-time',
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      'dist-tags': {
        latest: '1.0.0',
      },
      time: {
        '1.0.0': '2026-06-01T00:00:00.000Z',
        '1.1.0': '2026-06-02T00:00:00.000Z',
        created: '2026-06-01T00:00:00.000Z',
        modified: '2026-06-03T00:00:00.000Z',
      },
    })
  })
})

function blobPart(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const part = new Uint8Array(bytes.byteLength)
  part.set(bytes)
  return part
}

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value)
}

function publishArtifactDescriptorDigest(
  artifacts: Array<{
    bytes: Uint8Array
    compatibility?: unknown
    filename?: string
    format?: string
    mediaType: string
    role: string
  }>,
) {
  return releasePublishArtifactDescriptorDigest(
    artifacts.map((artifact) => ({
      ...(artifact.compatibility === undefined
        ? {}
        : { compatibility: artifact.compatibility }),
      digest: sha256(artifact.bytes),
      ...(artifact.filename === undefined
        ? {}
        : { filename: artifact.filename }),
      ...(artifact.format === undefined ? {} : { format: artifact.format }),
      mediaType: artifact.mediaType,
      role: artifact.role,
    })),
  )
}

function createSignedPublishAuthorization(input: {
  artifacts: Array<{
    bytes: Uint8Array
    compatibility?: unknown
    filename?: string
    format?: string
    mediaType: string
    role: string
  }>
  auth: ReturnType<typeof createTestDomainAuth>
  config: RegestaConfig
  nonce: string
  source: Uint8Array
  timestamp?: string
}) {
  const normalizedConfig = normalizeRegestaConfig(input.config)

  return input.auth.sign(
    createReleasePublishIntent({
      artifactDescriptorDigest: publishArtifactDescriptorDigest(
        input.artifacts,
      ),
      artifactDigests: input.artifacts.map((artifact) =>
        sha256(artifact.bytes),
      ),
      configDigest: configDigest(normalizedConfig),
      nonce: input.nonce,
      packageId: normalizedConfig.id,
      sourceDigest: sha256(input.source),
      timestamp: input.timestamp ?? new Date().toISOString(),
      version: normalizedConfig.version,
    }),
  )
}

function createSignedPublishForm(input: {
  auth: ReturnType<typeof createTestDomainAuth>
  nonce: string
  prepared: Awaited<ReturnType<typeof prepareFixtureNpmPublish>>
  timestamp: string
}): FormData {
  const form = new FormData()
  const artifacts = input.prepared.artifacts.map((artifact, index) => ({
    filename: artifact.filename,
    format: artifact.format,
    mediaType: artifact.mediaType,
    part: `artifact.${index}`,
    role: artifact.role,
  }))

  form.set('config', JSON.stringify(input.prepared.config))
  form.set(
    'authorization',
    JSON.stringify(
      createSignedPublishAuthorization({
        artifacts: input.prepared.artifacts,
        auth: input.auth,
        config: input.prepared.config,
        nonce: input.nonce,
        source: input.prepared.source,
        timestamp: input.timestamp,
      }),
    ),
  )
  form.set('createdAt', input.timestamp)
  form.set('source', new File([blobPart(input.prepared.source)], 'source.tgz'))
  form.set('artifacts', JSON.stringify(artifacts))

  input.prepared.artifacts.forEach((artifact, index) => {
    form.set(
      `artifact.${index}`,
      new File([blobPart(artifact.bytes)], artifact.filename, {
        type: artifact.mediaType,
      }),
    )
  })

  return form
}

function updateSignedPublishAuthorization(
  form: FormData,
  update: (
    authorization: Record<string, unknown>,
    payload: Record<string, unknown>,
  ) => void,
): void {
  const authorizationText = form.get('authorization')

  if (typeof authorizationText !== 'string') {
    throw new TypeError(
      'Signed publish form did not include authorization JSON',
    )
  }

  const authorization: unknown = JSON.parse(authorizationText)
  if (!isRecord(authorization) || !isRecord(authorization.payload)) {
    throw new TypeError(
      'Signed publish authorization payload must be an object',
    )
  }

  update(authorization, authorization.payload)
  form.set('authorization', JSON.stringify(authorization))
}

function invalidPackageManifestTarball(): Uint8Array {
  return gzipSync(tarArchiveFile('package/package.json', bytes('{')))
}

function packageManifestTarball(value: Record<string, unknown>): Uint8Array {
  return gzipSync(
    tarArchiveFile('package/package.json', bytes(`${JSON.stringify(value)}\n`)),
  )
}

function tarArchiveFile(path: string, content: Uint8Array): Uint8Array {
  const header = new Uint8Array(512)

  writeTarString(header, 0, 100, path)
  writeTarOctal(header, 100, 8, 0o644)
  writeTarOctal(header, 108, 8, 0)
  writeTarOctal(header, 116, 8, 0)
  writeTarOctal(header, 124, 12, content.byteLength)
  writeTarOctal(header, 136, 12, 0)
  header.fill(0x20, 148, 156)
  header[156] = 0x30
  writeTarString(header, 257, 6, 'ustar')
  writeTarString(header, 263, 2, '00')
  writeTarChecksum(header)

  const paddedSize = Math.ceil(content.byteLength / 512) * 512
  const output = new Uint8Array(512 + paddedSize + 1024)
  output.set(header)
  output.set(content, 512)

  return output
}

function writeTarString(
  output: Uint8Array,
  offset: number,
  length: number,
  value: string,
): void {
  for (let index = 0; index < Math.min(value.length, length); index++) {
    output[offset + index] = value.codePointAt(index)!
  }
}

function writeTarOctal(
  output: Uint8Array,
  offset: number,
  length: number,
  value: number,
): void {
  writeTarString(
    output,
    offset,
    length,
    `${value.toString(8).padStart(length - 1, '0')}\0`,
  )
}

function writeTarChecksum(header: Uint8Array): void {
  const checksum = header.reduce((sum, value) => sum + value, 0)
  writeTarString(header, 148, 8, `${checksum.toString(8).padStart(6, '0')}\0 `)
}

function withoutDescription(config: RegestaConfig): RegestaConfig {
  const output: RegestaConfig = { ...config }
  delete output.description
  return output
}

const devLocalhostFetch: typeof fetch = (input) => {
  if (String(input) !== 'http://dev.localhost:4321/.well-known/regesta.json') {
    return Promise.resolve(new Response(null, { status: 404 }))
  }

  return Promise.resolve(Response.json(devLocalhostDomainBinding))
}

function createTestDomainAuth(): {
  binding: DomainBinding
  fetch: typeof fetch
  sign: (intent: WriteIntent) => ReturnType<typeof createWriteAuthorization>
} {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const privateKeyJwk = normalizePrivateKeyJwk(
    privateKey.export({ format: 'jwk' }),
  )
  const publicKeyJwk = normalizePublicKeyJwk(
    publicKey.export({ format: 'jwk' }),
  )
  const binding: DomainBinding = {
    domain: 'example.com',
    keys: [
      {
        alg: 'EdDSA',
        kid: 'ed25519:test',
        publicKeyJwk,
        use: 'regesta-write',
      },
    ],
    object: 'regesta.domain-binding',
  }

  return {
    binding,
    fetch: (input) => {
      if (String(input) !== 'https://example.com/.well-known/regesta.json') {
        return Promise.resolve(new Response(null, { status: 404 }))
      }

      return Promise.resolve(Response.json(binding))
    },
    sign: (intent) =>
      createWriteAuthorization(intent, {
        kid: 'ed25519:test',
        privateKeyJwk,
      }),
  }
}

function normalizePrivateKeyJwk(value: unknown): Ed25519PrivateKeyJwk {
  if (!isRecord(value)) {
    throw new Error('private key JWK must be an object')
  }

  if (
    value.kty !== 'OKP' ||
    value.crv !== 'Ed25519' ||
    typeof value.x !== 'string' ||
    typeof value.d !== 'string'
  ) {
    throw new Error('private key JWK must be Ed25519')
  }

  return {
    crv: value.crv,
    d: value.d,
    kty: value.kty,
    x: value.x,
  }
}

function normalizePublicKeyJwk(value: unknown): Ed25519PublicKeyJwk {
  if (!isRecord(value)) {
    throw new Error('public key JWK must be an object')
  }

  if (
    value.kty !== 'OKP' ||
    value.crv !== 'Ed25519' ||
    typeof value.x !== 'string'
  ) {
    throw new Error('public key JWK must be Ed25519')
  }

  return {
    crv: value.crv,
    kty: value.kty,
    x: value.x,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

async function listenForNpmInstall(
  app: ReturnType<typeof createRegestaApp>,
): Promise<{
  close: () => Promise<void>
  origin: string
}> {
  const server = createServer(async (request, response) => {
    try {
      const host = request.headers.host ?? 'npm.localhost'
      const requestUrl = new URL(request.url ?? '/', `http://${host}`)
      const appResponse = await app.fetch(
        new Request(requestUrl, {
          headers: nodeRequestHeaders(request.headers),
          method: request.method ?? 'GET',
        }),
      )

      response.statusCode = appResponse.status
      response.statusMessage = appResponse.statusText
      appResponse.headers.forEach((value, name) => {
        response.setHeader(name, value)
      })

      if (request.method === 'HEAD' || !appResponse.body) {
        response.end()
        return
      }

      response.end(Buffer.from(await appResponse.arrayBuffer()))
    } catch (error) {
      response.statusCode = 500
      response.end(error instanceof Error ? error.message : 'Internal Error')
    }
  })

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = () => {
      server.off('error', onError)
      resolve()
    }

    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(0)
  })

  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('npm install test server did not expose a TCP port')
  }

  return {
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error)
            return
          }

          resolve()
        })
      }),
    origin: `http://npm.localhost:${address.port}`,
  }
}

function nodeRequestHeaders(headers: IncomingHttpHeaders): Headers {
  const output = new Headers()

  for (const [name, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        output.append(name, item)
      }
    } else if (value !== undefined) {
      output.set(name, value)
    }
  }

  return output
}

function requiredHeader(response: Response, name: string): string {
  const value = response.headers.get(name)

  if (!value) {
    throw new Error(`Expected response header: ${name}`)
  }

  return value
}

function expectNoSensitiveUpstreamRequestHeaders(headers: Headers): void {
  for (const name of [
    'authorization',
    'cookie',
    'npm-auth-token',
    'x-custom-secret',
  ]) {
    expect(headers.get(name)).toBeNull()
  }
}

function expectNoSensitiveUpstreamResponseHeaders(response: Response): void {
  for (const name of [
    'connection',
    'location',
    'set-cookie',
    'www-authenticate',
    'x-upstream-secret',
  ]) {
    expect(response.headers.get(name)).toBeNull()
  }
}

function deferred<T>(): {
  promise: Promise<T>
  reject: (error: unknown) => void
  resolve: (value: T) => void
} {
  let rejectPromise: ((error: unknown) => void) | undefined
  let resolvePromise: ((value: T) => void) | undefined
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve
    rejectPromise = reject
  })

  if (!resolvePromise || !rejectPromise) {
    throw new Error('Failed to create deferred promise')
  }

  return {
    promise,
    reject: rejectPromise,
    resolve: resolvePromise,
  }
}

async function prepareFixtureNpmPublish(projectDir: string): Promise<{
  artifacts: Array<{
    bytes: Uint8Array
    filename: string
    format: string
    mediaType: string
    role: string
  }>
  config: RegestaConfig
  source: Uint8Array
}> {
  const config: RegestaConfig = {
    description: 'Fixture package',
    exports: {
      '.': './src/index.ts',
    },
    id: 'npm:example.com/hello-regesta',
    provenance: {
      level: 'source-attached',
    },
    source: {
      include: ['regesta.json', 'package.json', 'src'],
    },
    version: '0.0.1',
  }
  const outputDir = await mkdtemp(
    join(tmpdir(), 'regesta-server-test-package-'),
  )

  try {
    await execFileAsync('npm', ['pack', '--pack-destination', outputDir], {
      cwd: projectDir,
    })

    const tarballs = (await readdir(outputDir)).filter((file) =>
      file.endsWith('.tgz'),
    )

    if (tarballs.length !== 1) {
      throw new Error(
        `Expected one npm fixture tarball, found ${tarballs.length}`,
      )
    }

    const filename = tarballs[0]!

    return {
      artifacts: [
        {
          bytes: await readFile(join(outputDir, filename)),
          filename,
          format: 'npm-tarball',
          mediaType: 'application/gzip',
          role: 'install',
        },
      ],
      config,
      source: bytes('source archive'),
    }
  } finally {
    await rm(outputDir, { force: true, recursive: true })
  }
}

interface FixtureProjectOptions {
  dependencies?: boolean
}

function expectedPackageChannelEtag(input: {
  channel: string
  packageId: string
  releaseEventId: string
  version: string
}): string {
  return `W/"regesta.channel:${sha256(
    canonicalJson({
      channel: input.channel,
      package: input.packageId,
      releaseEvent: input.releaseEventId,
      version: input.version,
    }),
  )}"`
}

async function createFixtureProject(
  options: FixtureProjectOptions = {},
): Promise<string> {
  const root = join(
    process.cwd(),
    'node_modules',
    '.tmp-regesta-server-test',
    `${Date.now()}-${Math.random().toString(16).slice(2)}`,
  )
  const packageJson: Record<string, unknown> = {
    description: 'Fixture package',
    exports: {
      '.': './src/index.ts',
    },
    name: '@example.com/hello-regesta',
    packageManager: 'npm@11.5.0',
    version: '0.0.1',
  }

  if (options.dependencies ?? true) {
    packageJson.dependencies = {
      '@example.com/base': '^1.0.0',
    }
  }

  await mkdir(join(root, 'src'), { recursive: true })
  await writeFile(join(root, 'src', 'index.ts'), 'export const value = 1\n')
  await writeFile(
    join(root, 'package.json'),
    `${JSON.stringify(packageJson, null, 2)}\n`,
  )
  await writeFile(
    join(root, 'regesta.json'),
    `{
      id: 'npm:example.com/hello-regesta',
      provenance: {
        level: 'source-attached',
      },
      source: {
        include: ['regesta.json', 'package.json', 'src'],
      },
    }\n`,
  )

  return root
}
