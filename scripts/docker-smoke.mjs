#!/usr/bin/env node
import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { setTimeout as sleep } from 'node:timers/promises'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const workspaceRoot = new URL('..', import.meta.url)
const suffix = randomUUID().slice(0, 8)
const image = `regesta-draft-smoke:${suffix}`
const container = `regesta-draft-smoke-${suffix}`
const volume = `regesta-draft-smoke-${suffix}`
const installDir = await mkdtemp(join(tmpdir(), 'regesta-docker-smoke-'))
let dockerAvailable = false
let runningContainer = false

try {
  await assertDockerAvailable()
  dockerAvailable = true
  await runInteractive('docker', ['build', '-t', image, '.'])
  await run('docker', ['volume', 'create', volume])

  let baseUrl = await startContainer()
  await waitForReady(baseUrl)
  await runInteractive('node', [
    '--conditions=regesta-source',
    'packages/cli/src/index.ts',
    'publish',
    'examples/hello-regesta',
    '--registry',
    baseUrl,
    '--auth-key',
    'apps/server/src/dev/private-key.json',
  ])

  await stopContainer()

  baseUrl = await startContainer()
  await waitForReady(baseUrl)
  await runInteractive('node', [
    '--conditions=regesta-source',
    'packages/cli/src/index.ts',
    'verify',
    'npm:dev.localhost/hello-regesta@0.0.5',
    '--registry',
    baseUrl,
  ])
  await runInteractive('node', [
    '--conditions=regesta-source',
    'packages/cli/src/index.ts',
    'verify-log',
    '--registry',
    baseUrl,
  ])
  await runInteractive('node', [
    '--conditions=regesta-source',
    'packages/cli/src/index.ts',
    'verify-package',
    'npm:dev.localhost/hello-regesta',
    '--registry',
    baseUrl,
  ])

  const deploymentInfo = await getJson(baseUrl)
  assertMatch(deploymentInfo, {
    object: 'regesta.deployment-info',
    statistics: {
      packages: 1,
    },
  })

  const packageState = await getJson(
    `${baseUrl}/packages/${encodeURIComponent(
      'npm:dev.localhost/hello-regesta',
    )}`,
  )
  assertMatch(packageState, {
    channels: {
      latest: '0.0.5',
    },
    id: 'npm:dev.localhost/hello-regesta',
  })

  const packument = await getJson(
    `${baseUrl}/@dev.localhost/hello-regesta`,
    `npm.localhost:${new URL(baseUrl).port}`,
  )
  assertMatch(packument, {
    'dist-tags': {
      latest: '0.0.5',
    },
    description: 'Minimal Regesta v0 example package.',
    name: '@dev.localhost/hello-regesta',
  })
  await assertPackumentTarballRedirect(packument, baseUrl)

  await npmInstallSmoke(baseUrl)

  console.info('Docker smoke passed')
} catch (error) {
  console.error(smokeErrorMessage(error))
  process.exitCode = 1
} finally {
  await cleanup()
}

async function assertDockerAvailable() {
  try {
    await run('docker', ['version', '--format', '{{.Server.Version}}'])
  } catch (error) {
    throw new Error(
      [
        'Docker smoke requires a running Docker daemon.',
        'Start Docker and retry `pnpm smoke:docker`.',
        commandErrorMessage(error),
      ]
        .filter(Boolean)
        .join(' '),
      { cause: error },
    )
  }
}

async function startContainer() {
  await run('docker', [
    'run',
    '-d',
    '--name',
    container,
    '-e',
    'NODE_ENV=development',
    '-e',
    'REGESTA_DATA_DIR=/data',
    '-v',
    `${volume}:/data`,
    '-p',
    '127.0.0.1::4321',
    image,
  ])
  runningContainer = true

  const portOutput = await run('docker', ['port', container, '4321/tcp'])
  const port = parsePublishedPort(portOutput)

  return `http://127.0.0.1:${port}`
}

async function stopContainer() {
  if (!runningContainer) {
    return
  }

  await run('docker', ['rm', '-f', container], { allowFailure: true })
  runningContainer = false
}

async function waitForReady(baseUrl) {
  const deadline = Date.now() + 30_000
  let lastError

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/ready`)
      if (response.ok) {
        assertMatch(await response.json(), {
          checks: {
            checkpoints: true,
          },
          kind: 'regesta.readiness',
          ok: true,
        })
        return
      }

      lastError = new Error(`Readiness check returned ${response.status}`)
    } catch (error) {
      lastError = error
    }

    await sleep(500)
  }

  throw (
    lastError ?? new Error('Timed out waiting for container readiness check')
  )
}

async function npmInstallSmoke(baseUrl) {
  const registryUrl = `http://npm.localhost:${new URL(baseUrl).port}`

  await writeFile(join(installDir, 'package.json'), '{"private":true}\n')
  await runInteractive(
    'npm',
    [
      'install',
      '--audit=false',
      '--fund=false',
      '--ignore-scripts',
      '--package-lock=false',
      '--replace-registry-host=never',
      '--registry',
      registryUrl,
      '--cache',
      join(installDir, '.npm-cache'),
      '@dev.localhost/hello-regesta@latest',
    ],
    {
      ...process.env,
      npm_config_update_notifier: 'false',
    },
    installDir,
  )

  const installedPackageJson = JSON.parse(
    await readFile(
      join(
        installDir,
        'node_modules',
        '@dev.localhost',
        'hello-regesta',
        'package.json',
      ),
      'utf8',
    ),
  )

  assertMatch(installedPackageJson, {
    name: '@dev.localhost/hello-regesta',
    version: '0.0.5',
  })
}

async function assertPackumentTarballRedirect(packument, baseUrl) {
  const port = new URL(baseUrl).port
  const tarball = packument.versions?.['0.0.5']?.dist?.tarball
  if (typeof tarball !== 'string') {
    throw new TypeError('npm packument version did not include dist.tarball')
  }

  const tarballUrl = new URL(tarball)
  if (
    tarballUrl.hostname !== 'npm.localhost' ||
    tarballUrl.port !== port ||
    tarballUrl.pathname !==
      '/@dev.localhost/hello-regesta/-/hello-regesta-0.0.5.tgz'
  ) {
    throw new Error(
      `Expected npm metadata tarball to be an npm projection tarball URL: ${tarball}`,
    )
  }

  const location = await getRedirectWithHostHeader(
    `${baseUrl}${tarballUrl.pathname}`,
    `npm.localhost:${port}`,
  )
  const objectUrl = new URL(location)
  if (
    objectUrl.hostname !== 'localhost' ||
    objectUrl.port !== port ||
    !objectUrl.pathname.startsWith('/objects/sha256:')
  ) {
    throw new Error(
      `Expected npm tarball route to redirect to a core object URL, got ${location}`,
    )
  }

  const response = await fetch(objectUrl)
  if (!response.ok) {
    throw new Error(
      `${location} returned ${response.status}: ${await response.text()}`,
    )
  }

  if ((await response.arrayBuffer()).byteLength === 0) {
    throw new Error(`Core object tarball was empty: ${location}`)
  }
}

async function getJson(url, host) {
  if (host) {
    return getJsonWithHostHeader(url, host)
  }

  const response = await fetch(url, {
    headers: {},
  })

  if (!response.ok) {
    throw new Error(
      `${url} returned ${response.status}: ${await response.text()}`,
    )
  }

  return response.json()
}

function getJsonWithHostHeader(rawUrl, host) {
  const url = new URL(rawUrl)

  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        headers: {
          accept: 'application/json',
          host,
        },
        hostname: url.hostname,
        method: 'GET',
        path: `${url.pathname}${url.search}`,
        port: url.port,
      },
      (response) => {
        let body = ''
        response.setEncoding('utf8')
        response.on('data', (chunk) => {
          body += chunk
        })
        response.on('end', () => {
          if (
            !response.statusCode ||
            response.statusCode < 200 ||
            response.statusCode >= 300
          ) {
            reject(
              new Error(
                `${rawUrl} returned ${response.statusCode ?? 'unknown'}: ${body}`,
              ),
            )
            return
          }

          try {
            resolve(JSON.parse(body))
          } catch (error) {
            reject(error)
          }
        })
      },
    )

    request.on('error', reject)
    request.end()
  })
}

function getRedirectWithHostHeader(rawUrl, host) {
  const url = new URL(rawUrl)

  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        headers: {
          host,
        },
        hostname: url.hostname,
        method: 'GET',
        path: `${url.pathname}${url.search}`,
        port: url.port,
      },
      (response) => {
        response.resume()
        response.on('end', () => {
          if (response.statusCode !== 302) {
            reject(
              new Error(
                `${rawUrl} returned ${response.statusCode ?? 'unknown'}, expected 302`,
              ),
            )
            return
          }

          resolve(response.headers.location)
        })
      },
    )

    request.on('error', reject)
    request.end()
  })
}

function assertMatch(value, expected) {
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (
      expectedValue &&
      typeof expectedValue === 'object' &&
      !Array.isArray(expectedValue)
    ) {
      assertMatch(value?.[key], expectedValue)
      continue
    }

    if (value?.[key] !== expectedValue) {
      throw new Error(
        `Expected ${key} to be ${JSON.stringify(expectedValue)}, got ${JSON.stringify(
          value?.[key],
        )}`,
      )
    }
  }
}

function parsePublishedPort(output) {
  const match = output.match(/:(\d+)\s*$/u)
  if (!match) {
    throw new Error(`Could not parse Docker published port: ${output}`)
  }

  return match[1]
}

async function cleanup() {
  await stopContainer()
  await rm(installDir, { force: true, recursive: true })

  if (!dockerAvailable) {
    return
  }

  await run('docker', ['volume', 'rm', '-f', volume], { allowFailure: true })
  await run('docker', ['image', 'rm', '-f', image], { allowFailure: true })
}

async function run(file, args, options = {}) {
  try {
    const { stdout } = await execFileAsync(file, args, {
      cwd: workspaceRoot,
      encoding: 'utf8',
    })

    return stdout.trim()
  } catch (error) {
    if (options.allowFailure) {
      return ''
    }

    throw error
  }
}

function runInteractive(file, args, env = process.env, cwd = workspaceRoot) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd,
      env,
      stdio: 'inherit',
    })

    child.on('error', reject)
    child.on('exit', (code) => {
      if (code === 0) {
        resolve()
        return
      }

      reject(new Error(`${file} ${args.join(' ')} exited with ${code}`))
    })
  })
}

function smokeErrorMessage(error) {
  return `Docker smoke failed: ${errorMessage(error)}`
}

function commandErrorMessage(error) {
  if (!error || typeof error !== 'object') {
    return ''
  }

  const stderr =
    'stderr' in error && typeof error.stderr === 'string'
      ? error.stderr.trim()
      : ''
  const stdout =
    'stdout' in error && typeof error.stdout === 'string'
      ? error.stdout.trim()
      : ''

  return stderr || stdout
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}
