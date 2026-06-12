import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const protocolSourceRoot = new URL('.', import.meta.url).pathname
const protocolPackageRoot = join(protocolSourceRoot, '..')
const workspaceRoot = join(protocolPackageRoot, '..', '..')

describe('protocol package architecture', () => {
  it('keeps production protocol source independent from implementation layers', async () => {
    const forbiddenPatterns = [
      { label: 'workspace package dependency', pattern: /@regesta\//u },
      { label: 'Hono route dependency', pattern: /\bhono\b/u },
      { label: 'Valibot HTTP validation dependency', pattern: /\bvalibot\b/u },
      { label: 'tar implementation dependency', pattern: /\btar\b/u },
      { label: 'npm packument logic', pattern: /\bpackument\b/u },
      { label: 'npm dist-tags logic', pattern: /dist-tags/u },
      { label: 'npm upstream registry', pattern: /registry\.npmjs\.org/u },
      { label: 'PyPI upstream registry', pattern: /pypi\.org/u },
      { label: 'Cargo upstream registry', pattern: /crates\.io/u },
      { label: 'Cargo upstream index', pattern: /index\.crates\.io/u },
      { label: 'Go upstream proxy', pattern: /proxy\.golang\.org/u },
      { label: 'OCI upstream registry', pattern: /registry-1\.docker\.io/u },
      { label: 'OCI upstream registry', pattern: /\bghcr\.io\b/u },
      { label: 'npm media type', pattern: /application\/vnd\.npm/u },
      { label: 'filesystem implementation', pattern: /node:fs/u },
      { label: 'path implementation', pattern: /node:path/u },
      { label: 'SQLite implementation', pattern: /\bDatabaseSync\b/u },
      { label: 'SQLite storage implementation', pattern: /node:sqlite/u },
      { label: 'network request', pattern: /\bfetch\s*\(/u },
      { label: 'package-manager process execution', pattern: /child_process/u },
    ]
    const violations: string[] = []

    for (const file of await productionSourceFiles(protocolSourceRoot)) {
      const source = await readFile(file, 'utf8')
      for (const { label, pattern } of forbiddenPatterns) {
        if (pattern.test(source)) {
          violations.push(`${relative(protocolSourceRoot, file)}: ${label}`)
        }
      }
    }

    expect(violations).toEqual([])
  })

  it('keeps the protocol package manifest free from runtime dependencies', async () => {
    const manifest = JSON.parse(
      await readFile(join(protocolPackageRoot, 'package.json'), 'utf8'),
    )

    if (!isRecord(manifest)) {
      throw new TypeError('protocol package manifest must be an object')
    }

    expect(manifest.dependencies).toBeUndefined()
    expect(manifest.peerDependencies).toBeUndefined()
  })

  it('keeps package release ordering centralized in the protocol layer', async () => {
    const allowedComparatorFile = join(protocolSourceRoot, 'package.ts')
    const violations: string[] = []

    for (const file of [
      ...(await productionSourceFiles(join(workspaceRoot, 'packages'))),
      ...(await productionSourceFiles(join(workspaceRoot, 'apps/server/src'))),
    ]) {
      if (file === allowedComparatorFile) {
        continue
      }

      const source = await readFile(file, 'utf8')
      if (
        source.includes('createdAt.localeCompare') ||
        source.includes('version.localeCompare')
      ) {
        violations.push(relative(workspaceRoot, file))
      }
    }

    expect(violations).toEqual([])
  })
})

async function productionSourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const files: string[] = []

  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await productionSourceFiles(path)))
      continue
    }

    if (
      entry.isFile() &&
      entry.name.endsWith('.ts') &&
      !isTestSourceFile(path)
    ) {
      files.push(path)
    }
  }

  return files
}

function isTestSourceFile(path: string): boolean {
  return path.endsWith('.test.ts')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
