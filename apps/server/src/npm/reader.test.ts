import { createMemoryRegistryAdapters } from '@regesta/adapters'
import { parsePackageId } from '@regesta/protocol'
import { describe, expect, it, vi } from 'vitest'
import { createNpmRegistryReader } from './reader.ts'

describe('createNpmRegistryReader', () => {
  it('exposes only the package reads needed by npm projection routes', async () => {
    const packageId = parsePackageId('npm:example.com/hello-regesta').id
    const adapters = createMemoryRegistryAdapters()
    const getPackageChannels = vi.spyOn(adapters.database, 'getPackageChannels')
    const getPackageEventState = vi.spyOn(
      adapters.database,
      'getPackageEventState',
    )
    const getRelease = vi.spyOn(adapters.database, 'getRelease')
    const hasPackage = vi.spyOn(adapters.database, 'hasPackage')
    const listPackageReleases = vi.spyOn(
      adapters.database,
      'listPackageReleases',
    )
    const reader = createNpmRegistryReader(adapters)

    await expect(
      reader.database.getPackageChannels(packageId),
    ).resolves.toEqual({})
    await expect(
      reader.database.getPackageEventState(packageId),
    ).resolves.toMatchObject({
      state: {
        id: packageId,
        releases: [],
      },
    })
    await expect(
      reader.database.getRelease(packageId, '1.0.0'),
    ).resolves.toBeUndefined()
    await expect(reader.database.hasPackage(packageId)).resolves.toBe(false)
    await expect(
      reader.database.listPackageReleases(packageId),
    ).resolves.toEqual([])

    expect(Object.keys(reader)).toEqual(['database'])
    expect(Object.keys(reader.database).toSorted()).toEqual([
      'getPackageChannels',
      'getPackageEventState',
      'getRelease',
      'hasPackage',
      'listPackageReleases',
    ])
    expect(getPackageChannels).toHaveBeenCalledWith(packageId)
    expect(getPackageEventState).toHaveBeenCalledWith(packageId)
    expect(getRelease).toHaveBeenCalledWith(packageId, '1.0.0')
    expect(hasPackage).toHaveBeenCalledWith(packageId)
    expect(listPackageReleases).toHaveBeenCalledWith(packageId)
  })
})
