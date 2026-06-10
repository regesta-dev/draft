#!/usr/bin/env node
import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import process from 'node:process'
import {
  createReleasePublishIntent,
  createWriteAuthorization,
  releasePublishArtifactDescriptorDigest,
  type Ed25519PrivateKeyJwk,
} from '@regesta/auth'
import { configDigest } from '@regesta/core'
import { parsePackageId, parsePackageVersion, sha256 } from '@regesta/protocol'
import { cac } from 'cac'
import pkg from '../package.json' with { type: 'json' }
import { compareMirrorDirectories, mirrorRegistry } from './mirror.ts'
import { prepareNpmPublish } from './npm-publish.ts'
import { releasePublishArtifactDescriptors } from './publish-intent.ts'
import {
  compareEventLogsFromRegistries,
  verifyEventLogFromRegistry,
  verifyPackageStateFromRegistry,
  verifyReleaseFromRegistry,
} from './verify.ts'

const defaultRegistry = 'http://localhost:4321'

const cli = cac('regesta')

cli
  .command('publish [cwd]', 'Publish a tarball-backed package')
  .option('--auth-key <path>', 'Ed25519 private JWK auth key file')
  .option('--kid <kid>', 'Domain binding key id')
  .option('--registry <url>', 'Registry base URL', { default: defaultRegistry })
  .action(
    async (
      cwd: string | undefined,
      options: { authKey?: string; kid?: string; registry: string },
    ) => {
      const registry = normalizeRegistry(options.registry)
      const projectDir = cwd ?? process.cwd()
      const prepared = await prepareNpmPublish(projectDir)
      const key = await readAuthKey(options.authKey, options.kid)
      const form = new FormData()

      form.set('config', JSON.stringify(prepared.config))
      form.set(
        'authorization',
        JSON.stringify(
          createWriteAuthorization(
            createReleasePublishIntent({
              artifactDescriptorDigest: releasePublishArtifactDescriptorDigest(
                releasePublishArtifactDescriptors(prepared.artifacts),
              ),
              artifactDigests: prepared.artifacts.map((artifact) =>
                sha256(artifact.bytes),
              ),
              configDigest: configDigest(prepared.config),
              nonce: randomBytes(16).toString('base64url'),
              packageId: prepared.config.id,
              sourceDigest: sha256(prepared.source),
              timestamp: new Date().toISOString(),
              version: prepared.config.version,
            }),
            key,
          ),
        ),
      )
      form.set(
        'source',
        new Blob([toArrayBuffer(prepared.source)], {
          type: 'application/vnd.regesta.source-archive+tgz',
        }),
        'source.tgz',
      )
      form.set(
        'artifacts',
        JSON.stringify(
          prepared.artifacts.map((artifact, index) => ({
            filename: artifact.filename,
            format: artifact.format,
            mediaType: artifact.mediaType,
            part: `artifact.${index}`,
            role: artifact.role,
            ...(artifact.compatibility === undefined
              ? {}
              : { compatibility: artifact.compatibility }),
          })),
        ),
      )
      for (const [index, artifact] of prepared.artifacts.entries()) {
        form.set(
          `artifact.${index}`,
          new Blob([toArrayBuffer(artifact.bytes)], {
            type: artifact.mediaType,
          }),
          artifact.filename ?? `artifact-${index}`,
        )
      }

      const response = await fetch(`${registry}/releases`, {
        body: form,
        method: 'POST',
      })
      const body = await response.json()

      if (!response.ok) {
        throw new Error(JSON.stringify(body, null, 2))
      }

      console.info(JSON.stringify(body, null, 2))
    },
  )

cli
  .command('verify <spec>', 'Verify a published package release')
  .option('--registry <url>', 'Registry base URL', { default: defaultRegistry })
  .action(async (spec: string, options: { registry: string }) => {
    const parsed = parsePackageVersion(spec)
    const body = await verifyReleaseFromRegistry({
      packageId: parsed.id,
      registry: options.registry,
      version: parsed.version,
    })

    console.info(JSON.stringify(body, null, 2))

    if (!body.ok) {
      process.exitCode = 1
    }
  })

cli
  .command('verify-log', 'Verify the public registry event log')
  .option('--registry <url>', 'Registry base URL', { default: defaultRegistry })
  .option('--limit <count>', 'Event log page size')
  .option('--max-pages <count>', 'Maximum number of event log pages to fetch')
  .action(
    async (options: {
      limit?: string
      maxPages?: string
      registry: string
    }) => {
      const body = await verifyEventLogFromRegistry({
        limit: parseOptionalPositiveInteger(options.limit, '--limit'),
        maxPages: parseOptionalPositiveInteger(options.maxPages, '--max-pages'),
        registry: options.registry,
      })

      console.info(JSON.stringify(body, null, 2))

      if (!body.ok) {
        process.exitCode = 1
      }
    },
  )

cli
  .command('verify-package <package-id>', 'Verify public package state')
  .option('--registry <url>', 'Registry base URL', { default: defaultRegistry })
  .option('--limit <count>', 'Event log page size')
  .option('--max-pages <count>', 'Maximum number of event log pages to fetch')
  .action(
    async (
      packageId: string,
      options: {
        limit?: string
        maxPages?: string
        registry: string
      },
    ) => {
      const body = await verifyPackageStateFromRegistry({
        limit: parseOptionalPositiveInteger(options.limit, '--limit'),
        maxPages: parseOptionalPositiveInteger(options.maxPages, '--max-pages'),
        packageId: parsePackageId(packageId).id,
        registry: options.registry,
      })

      console.info(JSON.stringify(body, null, 2))

      if (!body.ok) {
        process.exitCode = 1
      }
    },
  )

cli
  .command(
    'compare-logs <left-registry> <right-registry>',
    'Compare two public registry event-log views',
  )
  .option('--limit <count>', 'Event log page size')
  .option('--max-pages <count>', 'Maximum number of event log pages to fetch')
  .action(
    async (
      leftRegistry: string,
      rightRegistry: string,
      options: {
        limit?: string
        maxPages?: string
      },
    ) => {
      const body = await compareEventLogsFromRegistries({
        leftRegistry,
        limit: parseOptionalPositiveInteger(options.limit, '--limit'),
        maxPages: parseOptionalPositiveInteger(options.maxPages, '--max-pages'),
        rightRegistry,
      })

      console.info(JSON.stringify(body, null, 2))

      if (!body.ok) {
        process.exitCode = 1
      }
    },
  )

cli
  .command('mirror <output-dir>', 'Mirror public registry facts to a directory')
  .option('--registry <url>', 'Registry base URL', { default: defaultRegistry })
  .option('--limit <count>', 'Event and object inventory page size')
  .option(
    '--max-pages <count>',
    'Maximum number of event or object inventory pages to fetch',
  )
  .action(
    async (
      outputDir: string,
      options: {
        limit?: string
        maxPages?: string
        registry: string
      },
    ) => {
      const body = await mirrorRegistry({
        limit: parseOptionalPositiveInteger(options.limit, '--limit'),
        maxPages: parseOptionalPositiveInteger(options.maxPages, '--max-pages'),
        outputDir,
        registry: options.registry,
      })

      console.info(JSON.stringify(body, null, 2))

      if (!body.ok) {
        process.exitCode = 1
      }
    },
  )

cli
  .command(
    'compare-mirrors <left-dir> <right-dir>',
    'Compare two local mirror directories',
  )
  .action(async (leftDir: string, rightDir: string) => {
    const body = await compareMirrorDirectories({ leftDir, rightDir })

    console.info(JSON.stringify(body, null, 2))

    if (!body.ok) {
      process.exitCode = 1
    }
  })

cli
  .command('pack [cwd]', 'Prepare publish payload without uploading')
  .action(async (cwd: string | undefined) => {
    const prepared = await prepareNpmPublish(cwd ?? process.cwd())

    console.info(
      JSON.stringify(
        {
          config: prepared.config,
          artifactBytes: prepared.artifacts.map((artifact) => ({
            bytes: artifact.bytes.byteLength,
            role: artifact.role,
          })),
          sourceBytes: prepared.source.byteLength,
        },
        null,
        2,
      ),
    )
  })

cli.help().version(pkg.version).parse()

function normalizeRegistry(registry: string): string {
  return registry.replace(/\/$/, '')
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy.buffer
}

function parseOptionalPositiveInteger(
  value: string | undefined,
  label: string,
): number | undefined {
  if (value === undefined) {
    return undefined
  }

  if (!/^[1-9]\d*$/u.test(value)) {
    throw new TypeError(`${label} must be a positive integer`)
  }

  const parsed = Number(value)

  if (!Number.isSafeInteger(parsed)) {
    throw new TypeError(`${label} must be a safe integer`)
  }

  return parsed
}

async function readAuthKey(
  path: string | undefined,
  kid: string | undefined,
): Promise<{ kid: string; privateKeyJwk: Ed25519PrivateKeyJwk }> {
  if (!path) {
    throw new Error('Missing --auth-key for signed publish')
  }

  const value: unknown = JSON.parse(await readFile(path, 'utf8'))
  const keyFile = normalizeAuthKeyFile(value)
  const resolvedKid = kid ?? keyFile.kid

  if (!resolvedKid) {
    throw new Error('Missing --kid or kid in auth key file')
  }

  return {
    kid: resolvedKid,
    privateKeyJwk: keyFile.privateKeyJwk,
  }
}

function normalizeAuthKeyFile(value: unknown): {
  kid?: string
  privateKeyJwk: Ed25519PrivateKeyJwk
} {
  if (!isRecord(value)) {
    throw new Error('Auth key file must be a JSON object')
  }

  const privateKeyJwk =
    value.privateKeyJwk === undefined ? value : value.privateKeyJwk

  return {
    ...(typeof value.kid === 'string' ? { kid: value.kid } : {}),
    privateKeyJwk: normalizePrivateKeyJwk(privateKeyJwk),
  }
}

function normalizePrivateKeyJwk(value: unknown): Ed25519PrivateKeyJwk {
  if (!isRecord(value)) {
    throw new TypeError('privateKeyJwk must be an object')
  }

  if (value.kty !== 'OKP' || value.crv !== 'Ed25519') {
    throw new Error('privateKeyJwk must be an Ed25519 OKP JWK')
  }

  if (typeof value.x !== 'string' || typeof value.d !== 'string') {
    throw new TypeError('privateKeyJwk must include x and d')
  }

  return {
    crv: value.crv,
    d: value.d,
    kty: value.kty,
    x: value.x,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
