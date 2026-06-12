import { describe, expect, it } from 'vitest'
import { sha256 } from './digest.ts'
import {
  assertPackageChannel,
  assertPackageVersion,
  comparePackageReleaseOrder,
  parsePackageChannels,
  parsePackageState,
  type PackageState,
} from './package.ts'

describe('assertPackageChannel', () => {
  it('returns custom channel names', () => {
    expect(assertPackageChannel('latest')).toBe('latest')
    expect(assertPackageChannel('beta')).toBe('beta')
    expect(assertPackageChannel('internal-preview')).toBe('internal-preview')
  })

  it('rejects invalid runtime inputs', () => {
    expect(() => assertPackageChannel(JSON.parse('null'))).toThrow(
      'Package channel must be a non-empty string',
    )
    expect(() => assertPackageChannel('')).toThrow(
      'Package channel must be a non-empty string',
    )
    expect(() => assertPackageChannel('latest\r\nx')).toThrow(
      'Package channel must not include control characters',
    )
  })
})

describe('assertPackageVersion', () => {
  it('returns ecosystem-defined version strings', () => {
    expect(assertPackageVersion('1.0.0')).toBe('1.0.0')
    expect(assertPackageVersion('2026.06.09')).toBe('2026.06.09')
  })

  it('rejects invalid runtime inputs', () => {
    expect(() => assertPackageVersion(JSON.parse('null'))).toThrow(
      'Package version must be a non-empty string',
    )
    expect(() => assertPackageVersion('')).toThrow(
      'Package version must be a non-empty string',
    )
    expect(() => assertPackageVersion('1.0.0\r\nx')).toThrow(
      'Package version must not include control characters',
    )
  })
})

describe('parsePackageChannels', () => {
  it('parses ecosystem-defined channels', () => {
    expect(
      parsePackageChannels(
        {
          beta: '2.0.0-beta.1',
          latest: '1.0.0',
        },
        'Package channels',
      ),
    ).toEqual({
      beta: '2.0.0-beta.1',
      latest: '1.0.0',
    })
  })

  it('rejects invalid channel values', () => {
    expect(() =>
      parsePackageChannels(
        {
          latest: 1,
        },
        'Package channels',
      ),
    ).toThrow('Package channels latest must be a non-empty string')
  })
})

describe('comparePackageReleaseOrder', () => {
  it('sorts releases by creation timestamp first', () => {
    const releases = [
      { createdAt: '2026-06-02T00:00:00.000Z', version: '1.0.0' },
      { createdAt: '2026-06-01T00:00:00.000Z', version: '2.0.0' },
    ]

    expect(releases.toSorted(comparePackageReleaseOrder)).toEqual([
      { createdAt: '2026-06-01T00:00:00.000Z', version: '2.0.0' },
      { createdAt: '2026-06-02T00:00:00.000Z', version: '1.0.0' },
    ])
  })

  it('uses release version as a deterministic tie-breaker', () => {
    const releases = [
      { createdAt: '2026-06-01T00:00:00.000Z', version: '2.0.0' },
      { createdAt: '2026-06-01T00:00:00.000Z', version: '1.0.0' },
    ]

    expect(releases.toSorted(comparePackageReleaseOrder)).toEqual([
      { createdAt: '2026-06-01T00:00:00.000Z', version: '1.0.0' },
      { createdAt: '2026-06-01T00:00:00.000Z', version: '2.0.0' },
    ])
  })
})

describe('parsePackageState', () => {
  it('parses package states without unsafe narrowing', () => {
    const state = packageState()

    expect(parsePackageState(state)).toEqual(state)
  })

  it('parses package states for future ecosystem keys', () => {
    const state: PackageState = {
      ...packageState(),
      ecosystem: 'maven',
      id: 'maven:example.com/group/artifact',
      name: 'example.com/group/artifact',
    }

    expect(parsePackageState(state)).toEqual(state)
  })

  it('rejects package states whose ecosystem does not match the package id', () => {
    expect(() =>
      parsePackageState({
        ...packageState(),
        ecosystem: 'cargo',
      }),
    ).toThrow('Package state ecosystem must match package id')
  })

  it('rejects package states whose name does not match the package id', () => {
    expect(() =>
      parsePackageState({
        ...packageState(),
        name: 'example.com/other',
      }),
    ).toThrow('Package state name must match package id')
  })

  it('rejects package states with unknown fields', () => {
    expect(() =>
      parsePackageState({
        ...packageState(),
        operatorHint: 'not verified',
      }),
    ).toThrow('Package state must not include unknown field: operatorHint')
  })

  it('rejects package states whose releases are not ordered by timestamp', () => {
    const state = packageState()

    expect(() =>
      parsePackageState({
        ...state,
        releases: [
          {
            createdAt: '2026-06-02T00:00:00.000Z',
            manifestDigest: sha256(bytes('manifest 2')),
            version: '2.0.0',
          },
          {
            createdAt: '2026-06-01T00:00:00.000Z',
            manifestDigest: sha256(bytes('manifest 1')),
            version: '1.0.0',
          },
        ],
      }),
    ).toThrow('Package state releases must be ordered by createdAt and version')
  })

  it('rejects package states whose releases do not use version as the tie-breaker', () => {
    const state = packageState()

    expect(() =>
      parsePackageState({
        ...state,
        releases: [
          {
            createdAt: '2026-06-01T00:00:00.000Z',
            manifestDigest: sha256(bytes('manifest 2')),
            version: '2.0.0',
          },
          {
            createdAt: '2026-06-01T00:00:00.000Z',
            manifestDigest: sha256(bytes('manifest 1')),
            version: '1.0.0',
          },
        ],
      }),
    ).toThrow('Package state releases must be ordered by createdAt and version')
  })

  it('rejects package states with duplicate release versions', () => {
    const state = packageState()

    expect(() =>
      parsePackageState({
        ...state,
        releases: [
          {
            createdAt: '2026-06-01T00:00:00.000Z',
            manifestDigest: sha256(bytes('manifest 1')),
            version: '1.0.0',
          },
          {
            createdAt: '2026-06-02T00:00:00.000Z',
            manifestDigest: sha256(bytes('manifest 2')),
            version: '1.0.0',
          },
        ],
      }),
    ).toThrow(
      'Package state releases must not include duplicate version: 1.0.0',
    )
  })

  it('rejects package states whose channels target missing release versions', () => {
    expect(() =>
      parsePackageState({
        ...packageState(),
        channels: {
          latest: '2.0.0',
        },
      }),
    ).toThrow(
      'Package state channels latest must target an existing release version: 2.0.0',
    )
  })

  it('rejects invalid release manifest digests', () => {
    const state = packageState()

    expect(() =>
      parsePackageState({
        ...state,
        releases: [
          {
            ...state.releases[0],
            manifestDigest: 'sha256:not-valid',
          },
        ],
      }),
    ).toThrow('Invalid sha256 digest')
  })
})

function packageState(): PackageState {
  return {
    channels: {
      beta: '1.0.0',
      latest: '1.0.0',
    },
    ecosystem: 'npm',
    id: 'npm:example.com/hello-regesta',
    name: 'example.com/hello-regesta',
    object: 'regesta.package-state',
    releases: [
      {
        createdAt: '2026-06-01T00:00:00.000Z',
        manifestDigest: sha256(bytes('manifest')),
        version: '1.0.0',
      },
    ],
  }
}

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value)
}
