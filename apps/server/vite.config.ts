import { execFileSync } from 'node:child_process'
import process from 'node:process'
import { nitro } from 'nitro/vite'
import { defineConfig } from 'vite'

const gitStatus = gitOutput(['status', '--porcelain'], { allowEmpty: true })

export default defineConfig({
  define: {
    __REGESTA_BUILD_TIME__: JSON.stringify(
      nonEmptyString(process.env.REGESTA_BUILD_TIME) ??
        new Date().toISOString(),
    ),
    __REGESTA_GIT_DIRTY__: JSON.stringify(
      envBoolean(process.env.REGESTA_GIT_DIRTY) ??
        (gitStatus === undefined ? null : gitStatus.length > 0),
    ),
    __REGESTA_GIT_SHA__: JSON.stringify(
      nonEmptyString(process.env.REGESTA_GIT_SHA) ??
        gitOutput(['rev-parse', '--short=12', 'HEAD']) ??
        'unknown',
    ),
  },
  plugins: [nitro()],
})

function gitOutput(
  args: string[],
  options: { allowEmpty?: boolean } = {},
): string | undefined {
  try {
    const output = execFileSync('git', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()

    return options.allowEmpty || output.length > 0 ? output : undefined
  } catch {
    return undefined
  }
}

function envBoolean(value: string | undefined): boolean | undefined {
  if (value === '1' || value === 'true') {
    return true
  }

  if (value === '0' || value === 'false') {
    return false
  }
}

function nonEmptyString(value: string | undefined): string | undefined {
  return value && value.length > 0 ? value : undefined
}
