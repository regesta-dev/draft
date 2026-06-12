import type {
  ObjectDescriptorListOptions,
  PackageReleaseListOptions,
  RegistryEventListOptions,
} from './interfaces.ts'

export function assertObjectDescriptorListOptions(
  options: ObjectDescriptorListOptions,
): void {
  if (
    !Number.isSafeInteger(options.limit) ||
    options.limit < 1 ||
    options.limit > 999
  ) {
    throw new TypeError(
      'Object descriptor page limit must be an integer from 1 to 999',
    )
  }
}

export function assertPackageReleaseListOptions(
  options: PackageReleaseListOptions,
): void {
  if (
    !Number.isSafeInteger(options.limit) ||
    options.limit < 1 ||
    options.limit > 999
  ) {
    throw new TypeError(
      'Package release page limit must be an integer from 1 to 999',
    )
  }
}

export function assertEventListOptions(
  options: RegistryEventListOptions,
): void {
  if (
    !Number.isSafeInteger(options.limit) ||
    options.limit < 1 ||
    options.limit > 999
  ) {
    throw new TypeError(
      'Registry event page limit must be an integer from 1 to 999',
    )
  }
}
