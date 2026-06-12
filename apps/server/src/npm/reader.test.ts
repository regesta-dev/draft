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
    await expect(
      reader.database.listPackageReleases(packageId, { limit: 1 }),
    ).resolves.toEqual([])

    expect(Object.keys(reader)).toEqual(['database'])
    expect(Object.keys(reader.database).toSorted()).toEqual([
      'getPackageChannelVersion',
      'getPackageChannels',
      'getPackageEventHead',
      'getPackageEventState',
      'getPackageReleaseHead',
      'getRelease',
      'listPackageReleases',
    ])
    expect(getPackageChannelVersion).toHaveBeenCalledWith(packageId, 'latest')
    expect(getPackageChannels).toHaveBeenCalledWith(packageId)
    expect(getPackageEventHead).toHaveBeenCalledWith(packageId)
    expect(getPackageEventState).toHaveBeenCalledWith(packageId)
    expect(getPackageReleaseHead).toHaveBeenCalledWith(packageId)
    expect(getRelease).toHaveBeenCalledWith(packageId, '1.0.0')
    expect(listPackageReleases).toHaveBeenCalledWith(packageId, { limit: 1 })
  })

  it('does not expose write or storage capabilities from the source database', () => {
    const database = Object.assign(new MemoryRegistryDatabase(), {
      commitPublishedRelease: vi.fn(),
      objects: {
        get: vi.fn(),
        put: vi.fn(),
      },
      queue: {
        enqueue: vi.fn(),
      },
      signer: {
        sign: vi.fn(),
      },
    })
    const reader = createNpmRegistryReader({ database })

    expect(reader.database).not.toBe(database)
    expect(Object.keys(reader.database).toSorted()).toEqual([
      'getPackageChannelVersion',
      'getPackageChannels',
      'getPackageEventHead',
      'getPackageEventState',
      'getPackageReleaseHead',
      'getRelease',
      'listPackageReleases',
    ])
    expect('commitPublishedRelease' in reader.database).toBe(false)
    expect('objects' in reader.database).toBe(false)
    expect('queue' in reader.database).toBe(false)
    expect('signer' in reader.database).toBe(false)
  })
})
