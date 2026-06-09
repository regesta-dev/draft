import type { RegistryEventListOptions } from './interfaces.ts'

export function assertEventListOptions(
  options: RegistryEventListOptions,
): void {
  if (
    options.limit !== undefined &&
    (!Number.isSafeInteger(options.limit) ||
      options.limit < 1 ||
      options.limit > 999)
  ) {
    throw new TypeError(
      'Registry event page limit must be an integer from 1 to 999',
    )
  }
}
