import { spawn } from 'node:child_process'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { validateLoadSmokeResultFile } from './validate-load-smoke-result.mjs'

export async function resolveLoadSmokeCiResultFile(env = process.env) {
  if (env.REGESTA_LOAD_RESULT_FILE) {
    return env.REGESTA_LOAD_RESULT_FILE
  }

  const directory = await mkdtemp(join(tmpdir(), 'regesta-load-smoke-ci-'))

  return join(directory, 'result.json')
}

export async function runLoadSmokeCi(env = process.env) {
  const resultFile = await resolveLoadSmokeCiResultFile(env)
  const childEnv = {
    ...env,
    REGESTA_LOAD_RESULT_FILE: resultFile,
  }
  const exitCode = await runNode(
    ['--conditions=regesta-source', 'scripts/load-smoke.mjs'],
    childEnv,
  )

  if (exitCode !== 0) {
    return exitCode
  }

  await validateLoadSmokeResultFile(resultFile)
  console.info(`Validated load smoke result: ${resultFile}`)

  return 0
}

function runNode(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      env,
      stdio: 'inherit',
    })

    child.on('error', reject)
    child.on('close', (code, signal) => {
      if (signal) {
        reject(new Error(`Load smoke process terminated by signal: ${signal}`))
        return
      }

      resolve(code ?? 1)
    })
  })
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    process.exitCode = await runLoadSmokeCi()
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
