import { createMemoryRegistryAdapters } from '@regesta/adapters'
import { parsePackageId } from '@regesta/protocol'
import { describe, expect, it, vi } from 'vitest'
import { createNpmRegistryReader } from './reader.ts'

describe('createNpmRegistryReader', () => {
  it('exposes only the package reads needed by npm projection routes', async () => {
    const packageId = parsePackageId('npm:example.com/hello-regesta').id
    const adapters = createMemoryRegistryAdapters()
    const listPackageEvents = vi.spyOn(adapters.database, 'listPackageEvents')
    const listPackageReleases = vi.spyOn(
      adapters.database,
      'listPackageReleases',
    )
    const reader = createNpmRegistryReader(adapters)

    await expect(reader.database.listPackageEvents(packageId)).resolves.toEqual(
      [],
    )
    await expect(
      reader.database.listPackageReleases(packageId),
    ).resolves.toEqual([])

    expect(Object.keys(reader)).toEqual(['database'])
    expect(Object.keys(reader.database).toSorted()).toEqual([
      'listPackageEvents',
      'listPackageReleases',
    ])
    expect(listPackageEvents).toHaveBeenCalledWith(packageId)
    expect(listPackageReleases).toHaveBeenCalledWith(packageId)
  })
})
