#!/usr/bin/env node
import process from 'node:process'
import { base64ToBytes, preparePublish } from '@regesta/core'
import { parsePackageVersion } from '@regesta/protocol'
import { cac } from 'cac'

const defaultRegistry = 'http://localhost:4321'

const cli = cac('regesta')

cli
  .command('publish [cwd]', 'Publish a source-native package')
  .option('--registry <url>', 'Registry base URL', { default: defaultRegistry })
  .action(async (cwd: string | undefined, options: { registry: string }) => {
    const projectDir = cwd ?? process.cwd()
    const prepared = await preparePublish(projectDir)
    const response = await fetch(
      `${options.registry.replace(/\/$/, '')}/api/v0/publish`,
      {
        body: JSON.stringify(prepared),
        headers: {
          'content-type': 'application/json',
        },
        method: 'POST',
      },
    )

    const body = (await response.json()) as unknown

    if (!response.ok) {
      throw new Error(JSON.stringify(body, null, 2))
    }

    console.info(JSON.stringify(body, null, 2))
  })

cli
  .command('verify <spec>', 'Verify a published package release')
  .option('--registry <url>', 'Registry base URL', { default: defaultRegistry })
  .action(async (spec: string, options: { registry: string }) => {
    const parsed = parsePackageVersion(spec)
    const [scope, name] = parsed.coordinate.slice(1).split('/')
    const url = `${options.registry.replace(/\/$/, '')}/api/v0/releases/${scope}/${name}/${parsed.version}/verify`
    const response = await fetch(url)
    const body = (await response.json()) as { ok?: boolean }

    console.info(JSON.stringify(body, null, 2))

    if (!response.ok || !body.ok) {
      process.exitCode = 1
    }
  })

cli
  .command('pack [cwd]', 'Prepare publish payload without uploading')
  .action(async (cwd: string | undefined) => {
    const prepared = await preparePublish(cwd ?? process.cwd())

    console.info(
      JSON.stringify(
        {
          config: prepared.config,
          npmTarballBytes: base64ToBytes(prepared.npmTarballBase64).byteLength,
          sourceArchiveBytes: base64ToBytes(prepared.sourceArchiveBase64)
            .byteLength,
        },
        null,
        2,
      ),
    )
  })

cli.help()
cli.version('0.0.0')
cli.parse()
