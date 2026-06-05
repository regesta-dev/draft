import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  canonicalJson,
  type CanonicalJsonValue,
  type PackageId,
  type RegistryEvent,
} from '@regesta/protocol'
import type { RegistryDatabase, StoredRelease } from './interfaces.ts'

type SqliteRow = Record<string, unknown>

export class SQLiteRegistryDatabase implements RegistryDatabase {
  private readonly db: DatabaseSync

  constructor(path: string) {
    if (path !== ':memory:') {
      mkdirSync(dirname(path), { recursive: true })
    }

    this.db = new DatabaseSync(path, { timeout: 5000 })
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;

      CREATE TABLE IF NOT EXISTS releases (
        package_id TEXT NOT NULL,
        version TEXT NOT NULL,
        created_at TEXT NOT NULL,
        manifest_json TEXT NOT NULL,
        manifest_descriptor_json TEXT NOT NULL,
        event_json TEXT NOT NULL,
        PRIMARY KEY (package_id, version)
      );

      CREATE INDEX IF NOT EXISTS releases_package_created_idx
        ON releases (package_id, created_at);

      CREATE TABLE IF NOT EXISTS package_channels (
        package_id TEXT NOT NULL,
        channel TEXT NOT NULL,
        version TEXT NOT NULL,
        PRIMARY KEY (package_id, channel)
      );

      CREATE TABLE IF NOT EXISTS registry_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        event_type TEXT NOT NULL,
        package_id TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        event_json TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS registry_events_package_sequence_idx
        ON registry_events (package_id, sequence);
    `)
  }

  appendEvent(event: RegistryEvent): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO registry_events (
          id,
          event_type,
          package_id,
          timestamp,
          event_json
        ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        event.id,
        event.eventType,
        eventPackageId(event),
        event.timestamp,
        encodeJson(event),
      )

    return Promise.resolve()
  }

  deletePackageChannel(
    packageId: PackageId,
    channel: string,
  ): Promise<string | undefined> {
    const previousVersion = this.channelVersion(packageId, channel)

    this.db
      .prepare(
        `DELETE FROM package_channels
          WHERE package_id = ? AND channel = ?`,
      )
      .run(packageId, channel)

    return Promise.resolve(previousVersion)
  }

  getEventLog(): Promise<RegistryEvent[]> {
    const rows = this.db
      .prepare(
        `SELECT event_json
          FROM registry_events
          ORDER BY sequence ASC`,
      )
      .all()

    return Promise.resolve(
      rows.map((row) => decodeRegistryEvent(requiredText(row, 'event_json'))),
    )
  }

  getPackageChannels(packageId: PackageId): Promise<Record<string, string>> {
    const rows = this.db
      .prepare(
        `SELECT channel, version
          FROM package_channels
          WHERE package_id = ?
          ORDER BY channel ASC`,
      )
      .all(packageId)

    return Promise.resolve(
      Object.fromEntries(
        rows.map((row) => [
          requiredText(row, 'channel'),
          requiredText(row, 'version'),
        ]),
      ),
    )
  }

  getRelease(
    packageId: PackageId,
    version: string,
  ): Promise<StoredRelease | undefined> {
    const row = this.db
      .prepare(
        `SELECT manifest_json, manifest_descriptor_json, event_json
          FROM releases
          WHERE package_id = ? AND version = ?`,
      )
      .get(packageId, version)

    return Promise.resolve(row ? decodeStoredRelease(row) : undefined)
  }

  listPackageReleases(packageId: PackageId): Promise<StoredRelease[]> {
    const rows = this.db
      .prepare(
        `SELECT manifest_json, manifest_descriptor_json, event_json
          FROM releases
          WHERE package_id = ?
          ORDER BY created_at ASC, version ASC`,
      )
      .all(packageId)

    return Promise.resolve(rows.map((row) => decodeStoredRelease(row)))
  }

  async putRelease(release: StoredRelease): Promise<void> {
    const packageId = release.manifest.id

    if (await this.getRelease(packageId, release.manifest.version)) {
      throw new Error(
        `Release already exists: ${packageId}@${release.manifest.version}`,
      )
    }

    this.db
      .prepare(
        `INSERT INTO releases (
          package_id,
          version,
          created_at,
          manifest_json,
          manifest_descriptor_json,
          event_json
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        packageId,
        release.manifest.version,
        release.manifest.createdAt,
        encodeJson(release.manifest),
        encodeJson(release.manifestDescriptor),
        encodeJson(release.event),
      )
  }

  setPackageChannel(
    packageId: PackageId,
    channel: string,
    version: string,
  ): Promise<string | undefined> {
    const previousVersion = this.channelVersion(packageId, channel)

    this.db
      .prepare(
        `INSERT INTO package_channels (package_id, channel, version)
          VALUES (?, ?, ?)
          ON CONFLICT(package_id, channel)
          DO UPDATE SET version = excluded.version`,
      )
      .run(packageId, channel, version)

    return Promise.resolve(previousVersion)
  }

  close(): void {
    this.db.close()
  }

  private channelVersion(
    packageId: PackageId,
    channel: string,
  ): string | undefined {
    const row = this.db
      .prepare(
        `SELECT version
          FROM package_channels
          WHERE package_id = ? AND channel = ?`,
      )
      .get(packageId, channel)

    return row ? requiredText(row, 'version') : undefined
  }
}

function decodeStoredRelease(row: SqliteRow): StoredRelease {
  return {
    event: decodeRegistryEvent(requiredText(row, 'event_json')),
    manifest: decodeJson(requiredText(row, 'manifest_json')),
    manifestDescriptor: decodeJson(
      requiredText(row, 'manifest_descriptor_json'),
    ),
  }
}

function decodeRegistryEvent(json: string): RegistryEvent {
  return decodeJson(json)
}

function decodeJson<T>(json: string): T {
  return JSON.parse(json)
}

function encodeJson(value: unknown): string {
  return canonicalJson(toCanonicalJsonValue(value))
}

function eventPackageId(event: RegistryEvent): PackageId {
  return event.eventType === 'release.published'
    ? event.release.id
    : event.package
}

function requiredText(row: SqliteRow, column: string): string {
  const value = row[column]

  if (typeof value !== 'string') {
    throw new TypeError(`SQLite column ${column} must be text`)
  }

  return value
}

function toCanonicalJsonValue(value: unknown): CanonicalJsonValue {
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'number' ||
    typeof value === 'string'
  ) {
    return value
  }

  if (Array.isArray(value)) {
    return value.map((item) => toCanonicalJsonValue(item))
  }

  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        toCanonicalJsonValue(item),
      ]),
    )
  }

  throw new TypeError('SQLite JSON value must be canonical JSON compatible')
}
