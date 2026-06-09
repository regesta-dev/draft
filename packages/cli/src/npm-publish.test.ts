import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readNpmRegestaConfig } from './npm-publish.ts'

describe('readNpmRegestaConfig', () => {
  it('infers normalized publish config fields from package.json', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'regesta-npm-config-'))

    try {
      await writeFile(
        join(projectDir, 'package.json'),
        `${JSON.stringify(
          {
            description: 'Package description',
            exports: {
              '.': './dist/index.mjs',
            },
            name: '@example.com/hello-regesta',
            repository: {
              type: 'git',
              url: 'https://github.com/example/hello-regesta.git',
            },
            version: '1.2.3',
          },
          null,
          2,
        )}\n`,
      )
      await writeFile(
        join(projectDir, 'regesta.json'),
        `{
          // id and version are inferred by the npm client.
          languages: ['typescript'],
          provenance: {
            level: 'source-attached',
          },
          source: {
            include: ['regesta.json', 'package.json', 'src'],
          },
        }\n`,
      )

      await expect(readNpmRegestaConfig(projectDir)).resolves.toEqual({
        description: 'Package description',
        exports: {
          '.': './dist/index.mjs',
        },
        id: 'npm:example.com/hello-regesta',
        languages: ['typescript'],
        provenance: {
          level: 'source-attached',
        },
        repository: 'https://github.com/example/hello-regesta.git',
        source: {
          include: ['regesta.json', 'package.json', 'src'],
        },
        version: '1.2.3',
      })
    } finally {
      await rm(projectDir, { force: true, recursive: true })
    }
  })

  it('rejects non-npm package ids for the npm-first publisher', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'regesta-npm-config-'))

    try {
      await writeFile(
        join(projectDir, 'package.json'),
        `${JSON.stringify(
          {
            name: '@example.com/hello-regesta',
            version: '1.2.3',
          },
          null,
          2,
        )}\n`,
      )
      await writeFile(
        join(projectDir, 'regesta.json'),
        `{
          id: 'pypi:example.com/hello-regesta',
          source: {
            include: ['regesta.json'],
          },
        }\n`,
      )

      await expect(readNpmRegestaConfig(projectDir)).rejects.toThrow(
        'npm publish config must use npm ecosystem: pypi:example.com/hello-regesta',
      )
    } finally {
      await rm(projectDir, { force: true, recursive: true })
    }
  })

  it('does not accept package as a regesta.json id alias', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'regesta-npm-config-'))

    try {
      await writeFile(
        join(projectDir, 'package.json'),
        `${JSON.stringify(
          {
            name: '@example.com/hello-regesta',
            version: '1.2.3',
          },
          null,
          2,
        )}\n`,
      )
      await writeFile(
        join(projectDir, 'regesta.json'),
        `{
          package: '@example.com/hello-regesta',
          source: {
            include: ['regesta.json'],
          },
        }\n`,
      )

      await expect(readNpmRegestaConfig(projectDir)).rejects.toThrow(
        'regesta.json must not include unknown field: package',
      )
    } finally {
      await rm(projectDir, { force: true, recursive: true })
    }
  })
})
