import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createSourceArchive } from './source-archive.ts'
import type { RegestaConfig, RegestaSourceConfig } from '@regesta/protocol'

describe('createSourceArchive', () => {
  it('creates a deterministic source archive from safe relative entries', async () => {
    const projectDir = await sourceProject()

    try {
      const archive = await createSourceArchive(
        projectDir,
        sourceConfig({
          exclude: ['src/ignored.ts'],
          include: ['src/', 'package.json'],
        }),
      )

      expect(archive.bytes.byteLength).toBeGreaterThan(0)
      expect(archive.entries).toEqual(['package.json', 'regesta.json', 'src/'])
    } finally {
      await rm(projectDir, { force: true, recursive: true })
    }
  })

  it('rejects unsafe source include paths before creating an archive', async () => {
    const projectDir = await sourceProject()
    const cases: Array<{
      message: string
      path: string
    }> = [
      {
        message: 'regesta source include paths must be relative',
        path: '/etc/passwd',
      },
      {
        message:
          'regesta source include paths must not contain control characters',
        path: 'src/\nindex.ts',
      },
      {
        message:
          'regesta source include paths must not contain parent directory segments',
        path: '../secret.txt',
      },
      {
        message: 'regesta source include paths must use forward slashes',
        path: String.raw`src\index.ts`,
      },
      {
        message: 'regesta source include paths must be normalized',
        path: './src/index.ts',
      },
      {
        message: 'regesta source include paths must be normalized',
        path: 'src//index.ts',
      },
    ]

    try {
      for (const item of cases) {
        await expect(
          createSourceArchive(
            projectDir,
            sourceConfig({
              include: [item.path],
            }),
          ),
          item.path,
        ).rejects.toThrow(item.message)
      }
    } finally {
      await rm(projectDir, { force: true, recursive: true })
    }
  })

  it('rejects unsafe source exclude paths before creating an archive', async () => {
    const projectDir = await sourceProject()

    try {
      await expect(
        createSourceArchive(
          projectDir,
          sourceConfig({
            exclude: ['../secret.txt'],
            include: ['package.json'],
          }),
        ),
      ).rejects.toThrow(
        'regesta source exclude paths must not contain parent directory segments',
      )
      await expect(
        createSourceArchive(
          projectDir,
          sourceConfig({
            exclude: ['dist/\ncache'],
            include: ['package.json'],
          }),
        ),
      ).rejects.toThrow(
        'regesta source exclude paths must not contain control characters',
      )
    } finally {
      await rm(projectDir, { force: true, recursive: true })
    }
  })

  it('rejects source exclude paths that would remove regesta.json', async () => {
    const projectDir = await sourceProject()

    try {
      for (const path of ['regesta.json', 'regesta.json/']) {
        await expect(
          createSourceArchive(
            projectDir,
            sourceConfig({
              exclude: [path],
              include: ['package.json'],
            }),
          ),
          path,
        ).rejects.toThrow(
          'regesta source exclude must not exclude regesta.json',
        )
      }
    } finally {
      await rm(projectDir, { force: true, recursive: true })
    }
  })
})

async function sourceProject(): Promise<string> {
  const projectDir = await mkdtemp(join(tmpdir(), 'regesta-source-archive-'))
  await mkdir(join(projectDir, 'src'), { recursive: true })
  await writeFile(join(projectDir, 'package.json'), '{"type":"module"}\n')
  await writeFile(join(projectDir, 'regesta.json'), '{}\n')
  await writeFile(join(projectDir, 'src/index.ts'), 'export const value = 1\n')
  await writeFile(
    join(projectDir, 'src/ignored.ts'),
    'export const value = 2\n',
  )
  return projectDir
}

function sourceConfig(source: RegestaSourceConfig): RegestaConfig {
  return {
    id: 'npm:example.com/source-archive',
    provenance: {
      level: 'source-attached',
    },
    source,
    version: '0.0.1',
  }
}
