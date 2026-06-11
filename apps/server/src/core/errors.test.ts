import {
  ObjectCursorNotFoundError,
  PackageChannelConflictError,
  RegistryEventAlreadyExistsError,
  RegistryEventCursorNotFoundError,
  ReleaseAlreadyExistsError,
  ReleaseNotFoundError,
  WriteAuthorizationReplayError,
} from '@regesta/core'
import { assertSha256Digest, parsePackageId } from '@regesta/protocol'
import { describe, expect, it } from 'vitest'
import { coreRegistryKnownErrors } from './errors.ts'

const digest = assertSha256Digest(`sha256:${'1'.repeat(64)}`)
const packageId = parsePackageId('npm:example.com/hello-regesta').id

describe('coreRegistryKnownErrors', () => {
  it('maps core registry errors to stable transport error metadata', () => {
    expect(matchedError(new WriteAuthorizationReplayError(digest))).toEqual({
      code: 'write_authorization_replayed',
      status: 409,
    })
    expect(matchedError(new RegistryEventAlreadyExistsError(digest))).toEqual({
      code: 'registry_event_already_exists',
      status: 409,
    })
    expect(matchedError(new RegistryEventCursorNotFoundError(digest))).toEqual({
      code: 'event_cursor_not_found',
      status: 404,
    })
    expect(matchedError(new ObjectCursorNotFoundError(digest))).toEqual({
      code: 'object_cursor_not_found',
      status: 404,
    })
    expect(
      matchedError(
        new PackageChannelConflictError(packageId, 'latest', '1.0.0', '1.0.1'),
      ),
    ).toEqual({
      code: 'package_channel_conflict',
      status: 409,
    })
    expect(
      matchedError(new ReleaseAlreadyExistsError(packageId, '1.0.0')),
    ).toEqual({
      code: 'release_already_exists',
      status: 409,
    })
    expect(matchedError(new ReleaseNotFoundError(packageId, '1.0.0'))).toEqual({
      code: 'release_not_found',
      status: 404,
    })
  })

  it('does not match unrelated errors', () => {
    expect(matchedError(new Error('unexpected'))).toBeUndefined()
  })
})

function matchedError(error: Error):
  | {
      code: string
      status: number
    }
  | undefined {
  const match = coreRegistryKnownErrors.find((item) => item.match(error))

  return match ? { code: match.code, status: match.status } : undefined
}
