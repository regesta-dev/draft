import {
  ObjectCursorNotFoundError,
  PackageChannelConflictError,
  RegistryEventAlreadyExistsError,
  RegistryEventCursorNotFoundError,
  ReleaseAlreadyExistsError,
  ReleaseNotFoundError,
  WriteAuthorizationReplayError,
} from '@regesta/core'

export interface CoreRegistryKnownError {
  code: string
  match: (error: Error) => boolean
  status: 400 | 401 | 403 | 404 | 409 | 422
}

export const coreRegistryKnownErrors = [
  {
    code: 'write_authorization_replayed',
    match: (error) => error instanceof WriteAuthorizationReplayError,
    status: 409,
  },
  {
    code: 'registry_event_already_exists',
    match: (error) => error instanceof RegistryEventAlreadyExistsError,
    status: 409,
  },
  {
    code: 'event_cursor_not_found',
    match: (error) => error instanceof RegistryEventCursorNotFoundError,
    status: 404,
  },
  {
    code: 'object_cursor_not_found',
    match: (error) => error instanceof ObjectCursorNotFoundError,
    status: 404,
  },
  {
    code: 'package_channel_conflict',
    match: (error) => error instanceof PackageChannelConflictError,
    status: 409,
  },
  {
    code: 'release_already_exists',
    match: (error) => error instanceof ReleaseAlreadyExistsError,
    status: 409,
  },
  {
    code: 'release_not_found',
    match: (error) => error instanceof ReleaseNotFoundError,
    status: 404,
  },
] satisfies CoreRegistryKnownError[]
