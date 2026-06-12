import { MemoryRegistryDatabase } from '@regesta/adapters'
import { parsePackageId } from '@regesta/protocol'
import { describe, expect, it, vi } from 'vitest'
import { createNpmRegistryReader } from './reader.ts'

describe('createNpmRegistryReader', () => {
  it('exposes only the package reads needed by npm projection routes', async () => {
    const packageId = parsePackageId('npm:example.com/hello-regesta').id
    const database = new MemoryRegistryDatabase()
    const getPackageChannelVersion = vi.spyOn(
      database,
      'getPackageChannelVersion',
    )
    const getPackageChannels = vi.spyOn(database, 'getPackageChannels')
    const getPackageEventHead = vi.spyOn(database, 'getPackageEventHead')
    const getPackageEventState = vi.spyOn(database, 'getPackageEventState')
    const getPackageReleaseHead = vi.spyOn(database, 'getPackageReleaseHead')
    const getRelease = vi.spyOn(database, 'getRelease')
    const hasPackage = vi.spyOn(database, 'hasPackage')
    const listPackageReleases = vi.spyOn(database, 'listPackageReleases')
    const reader = createNpmRegistryReader({ database })

    await expect(
      reader.database.getPackageChannelVersion(packageId, 'latest'),
    ).resolves.toBeUndefined()
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
      reader.database.getPackageEventHead(packageId),
    ).resolves.toEqual({
      releaseCount: 0,
    })
    await expect(
      reader.database.getPackageReleaseHead(packageId),
    ).resolves.toEqual({
      releaseCount: 0,
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
      'getPackageChannelVersion',
      'getPackageChannels',
      'getPackageEventHead',
      'getPackageEventState',
      'getPackageReleaseHead',
      'getRelease',
      'hasPackage',
      'listPackageReleases',
    ])
    expect(getPackageChannelVersion).toHaveBeenCalledWith(packageId, 'latest')
    expect(getPackageChannels).toHaveBeenCalledWith(packageId)
    expect(getPackageEventHead).toHaveBeenCalledWith(packageId)
    expect(getPackageEventState).toHaveBeenCalledWith(packageId)
    expect(getPackageReleaseHead).toHaveBeenCalledWith(packageId)
    expect(getRelease).toHaveBeenCalledWith(packageId, '1.0.0')
    expect(hasPackage).toHaveBeenCalledWith(packageId)
    expect(listPackageReleases).toHaveBeenCalledWith(packageId)
  })
})
