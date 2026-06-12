import {
  assertRegistryEventIntegrity,
  assertStoredReleaseIntegrity,
  type StoredRelease,
} from '@regesta/core'
import type { RegistryEvent } from '@regesta/protocol'

export function assertPersistableRegistryEvent(event: RegistryEvent): void {
  assertRegistryEventIntegrity(event)
}

export function assertPersistableStoredRelease(
  release: StoredRelease,
  channel: string,
): void {
  assertStoredReleaseIntegrity(release, {
    channel,
    label: 'Stored release',
  })
}
