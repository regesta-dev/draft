import process from 'node:process'
import serverPackageJson from '../../package.json' with { type: 'json' }

declare const __REGESTA_BUILD_TIME__: string | undefined
declare const __REGESTA_GIT_DIRTY__: boolean | null | undefined
declare const __REGESTA_GIT_SHA__: string | undefined

export function createDeploymentInfo() {
  return {
    api: {
      version: 'v0',
    },
    build: {
      time: buildTime(),
    },
    git: {
      dirty: gitDirty(),
      sha: gitSha(),
    },
    object: 'regesta.deployment-info',
    runtime: {
      name: 'node',
      version: process.versions.node,
    },
    service: serverPackageJson.name,
    version: serverPackageJson.version,
  }
}

function buildTime(): string {
  const value =
    typeof __REGESTA_BUILD_TIME__ === 'string'
      ? __REGESTA_BUILD_TIME__
      : process.env.REGESTA_BUILD_TIME

  return nonEmptyString(value) ?? 'unknown'
}

function gitSha(): string {
  const value =
    typeof __REGESTA_GIT_SHA__ === 'string'
      ? __REGESTA_GIT_SHA__
      : process.env.REGESTA_GIT_SHA

  return nonEmptyString(value) ?? 'unknown'
}

function gitDirty(): boolean | null {
  if (typeof __REGESTA_GIT_DIRTY__ === 'boolean') {
    return __REGESTA_GIT_DIRTY__
  }

  if (typeof __REGESTA_GIT_DIRTY__ === 'object') {
    return null
  }

  return envBoolean(process.env.REGESTA_GIT_DIRTY) ?? null
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
