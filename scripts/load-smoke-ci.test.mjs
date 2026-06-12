import { stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveLoadSmokeCiResultFile } from './load-smoke-ci.mjs'

describe('resolveLoadSmokeCiResultFile', () => {
  it('uses an explicitly configured result file', async () => {
    await expect(
      resolveLoadSmokeCiResultFile({
        REGESTA_LOAD_RESULT_FILE: 'artifacts/load-smoke.json',
      }),
    ).resolves.toBe('artifacts/load-smoke.json')
  })

  it('creates a temporary result file path when one is not configured', async () => {
    const resultFile = await resolveLoadSmokeCiResultFile({})
    const resultDirectory = await stat(dirname(resultFile))

    expect(resultFile).toMatch(/regesta-load-smoke-ci-.+\/result\.json$/u)
    expect(resultDirectory.isDirectory()).toBe(true)
  })
})
