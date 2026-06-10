import {
  sha256,
  type ObjectDescriptor,
  type Sha256Digest,
} from '@regesta/protocol'

export interface ObjectResponseIntegrityInput {
  actual: {
    bytes: Uint8Array
    descriptor: ObjectDescriptor
  }
  digest: Sha256Digest
  expected: ObjectDescriptor
  label: string
}

export function assertObjectResponseIntegrity(
  input: ObjectResponseIntegrityInput,
): void {
  assertMatchingObjectDescriptor(input)
  assertObjectBytesMatchDescriptor(input)
}

function assertMatchingObjectDescriptor(
  input: ObjectResponseIntegrityInput,
): void {
  const { actual, digest, expected, label } = input

  if (
    actual.descriptor.digest !== expected.digest ||
    actual.descriptor.mediaType !== expected.mediaType ||
    actual.descriptor.size !== expected.size
  ) {
    throw new TypeError(`${label} descriptor changed while reading: ${digest}`)
  }
}

function assertObjectBytesMatchDescriptor(
  input: ObjectResponseIntegrityInput,
): void {
  const { actual, digest, expected, label } = input

  if (actual.bytes.byteLength !== expected.size) {
    throw new TypeError(`${label} byte length changed while reading: ${digest}`)
  }

  if (sha256(actual.bytes) !== expected.digest) {
    throw new TypeError(
      `${label} bytes digest mismatch while reading: ${digest}`,
    )
  }
}
