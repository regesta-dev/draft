import {
  canonicalJson,
  parseObjectDescriptor,
  parseRegistryEvent,
  parseReleaseManifest,
  sha256,
  type PackageId,
} from '@regesta/protocol'
import { RegistryEventIntegrityError, type StoredRelease } from './storage.ts'

export interface StoredReleaseIntegrityOptions {
  channel?: string
  label?: string
  packageId?: PackageId
  version?: string
}

export function assertStoredReleaseIntegrity(
  release: StoredRelease,
  options: StoredReleaseIntegrityOptions = {},
): void {
  parseStoredRelease(release, options)
}

export function parseStoredRelease(
  value: unknown,
  options: StoredReleaseIntegrityOptions = {},
): StoredRelease {
  try {
    return parseStoredReleaseUnchecked(value, options)
  } catch (error) {
    if (error instanceof RegistryEventIntegrityError) {
      throw error
    }

    throw new RegistryEventIntegrityError(errorMessage(error))
  }
}

function parseStoredReleaseUnchecked(
  value: unknown,
  options: StoredReleaseIntegrityOptions,
): StoredRelease {
  const label = options.label ?? 'Stored release'
  const release = readRecord(value, label)
  const event = parseRegistryEvent(release.event, `${label} event`)
  const manifest = parseReleaseManifest(release.manifest, `${label} manifest`)
  const manifestDescriptor = parseObjectDescriptor(
    release.manifestDescriptor,
    `${label} manifestDescriptor`,
  )

  if (options.packageId && manifest.id !== options.packageId) {
    throw new TypeError(
      `${label} manifest id must match requested package id: ${options.packageId}`,
    )
  }

  if (options.version && manifest.version !== options.version) {
    throw new TypeError(
      `${label} manifest version must match requested version: ${options.version}`,
    )
  }

  if (event.eventType !== 'release.published') {
    throw new TypeError(`${label} event must have eventType release.published`)
  }

  if (options.channel !== undefined && event.channel !== options.channel) {
    throw new TypeError(
      `${label} event channel does not match expected channel`,
    )
  }

  if (options.packageId && event.release.id !== options.packageId) {
    throw new TypeError(
      `${label} event package id must match requested package id: ${options.packageId}`,
    )
  }

  if (options.version && event.release.version !== options.version) {
    throw new TypeError(
      `${label} event version must match requested version: ${options.version}`,
    )
  }

  if (event.release.id !== manifest.id) {
    throw new TypeError(
      `${label} event package id does not match release manifest`,
    )
  }

  if (event.release.version !== manifest.version) {
    throw new TypeError(
      `${label} event version does not match release manifest`,
    )
  }

  if (event.release.manifestDigest !== manifestDescriptor.digest) {
    throw new TypeError(
      `${label} event manifest digest must match manifest descriptor`,
    )
  }

  if (event.sourceDigest !== manifest.source.digest) {
    throw new TypeError(`${label} event source digest must match manifest`)
  }

  if (
    canonicalJson(event.artifactDigests) !==
    canonicalJson(manifest.artifacts.map((artifact) => artifact.digest))
  ) {
    throw new TypeError(`${label} event artifact digests must match manifest`)
  }

  if (event.timestamp !== manifest.createdAt) {
    throw new TypeError(`${label} event timestamp must match manifest`)
  }

  const installArtifacts = manifest.artifacts.filter((artifact) => {
    return artifact.role === 'install'
  })

  if (installArtifacts.length !== 1) {
    throw new TypeError(
      `${label} manifest must include exactly one install artifact`,
    )
  }

  assertReleaseManifestDescriptor(manifest, manifestDescriptor, label)

  return {
    event,
    manifest,
    manifestDescriptor,
  }
}

function assertReleaseManifestDescriptor(
  manifest: StoredRelease['manifest'],
  manifestDescriptor: StoredRelease['manifestDescriptor'],
  label: string,
): void {
  const manifestBytes = new TextEncoder().encode(`${canonicalJson(manifest)}\n`)

  if (manifestDescriptor.digest !== sha256(manifestBytes)) {
    throw new TypeError(
      `${label} manifestDescriptor digest must match canonical manifest`,
    )
  }

  if (manifestDescriptor.size !== manifestBytes.byteLength) {
    throw new TypeError(
      `${label} manifestDescriptor size must match canonical manifest`,
    )
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function readRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`)
  }

  return Object.fromEntries(Object.entries(value))
}
