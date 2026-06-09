import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  PackageChannelConflictError,
  RegistryEventAlreadyExistsError,
  RegistryEventCursorNotFoundError,
  ReleaseAlreadyExistsError,
  ReleaseNotFoundError,
  WriteAuthorizationReplayError,
} from '@regesta/core'
import {
  canonicalJson,
  type ChannelDeletedEvent,
  type ChannelUpdatedEvent,
  type PackageId,
  type RegistryEvent,
  type Sha256Digest,
} from '@regesta/protocol'
import {
  assertAppendableRegistryEvent,
  assertPersistableRegistryEvent,
  assertPersistableStoredRelease,
} from './events.ts'
import { assertEventListOptions } from './pagination.ts'
import type {
  RegistryDatabase,
  RegistryEventListOptions,
  StoredRelease,
} from './interfaces.ts'

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
        authorization_payload_digest TEXT,
        event_json TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS registry_events_package_sequence_idx
        ON registry_events (package_id, sequence);

    `)
    this.ensureRegistryEventColumns()
    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS registry_events_authorization_payload_digest_unique_idx
        ON registry_events (authorization_payload_digest)
        WHERE authorization_payload_digest IS NOT NULL;
    `)
  }

  checkReadiness(): Promise<void> {
    this.db.prepare('SELECT 1').get()
    return Promise.resolve()
  }

  appendEvent(event: RegistryEvent): Promise<void> {
    assertPersistableRegistryEvent(event)

    const authorizationPayloadDigest = eventAuthorizationPayloadDigest(event)

    try {
      if (this.eventExists(event.id)) {
        throw new RegistryEventAlreadyExistsError(event.id)
      }

      if (
        authorizationPayloadDigest &&
        this.authorizationPayloadDigestExists(authorizationPayloadDigest)
      ) {
        throw new WriteAuthorizationReplayError(authorizationPayloadDigest)
      }

      assertAppendableRegistryEvent(this.packageEvents(event), event)
      this.insertRegistryEvent(event, authorizationPayloadDigest)
    } catch (error) {
      if (isSqliteUniqueEventIdError(error)) {
        throw new RegistryEventAlreadyExistsError(event.id)
      }

      if (
        authorizationPayloadDigest &&
        isSqliteUniqueAuthorizationPayloadDigestError(error)
      ) {
        throw new WriteAuthorizationReplayError(authorizationPayloadDigest)
      }

      throw error
    }

    return Promise.resolve()
  }

  commitPackageChannelUpdate(event: ChannelUpdatedEvent): Promise<void> {
    assertPersistableRegistryEvent(event)

    const authorizationPayloadDigest = eventAuthorizationPayloadDigest(event)

    try {
      this.db.exec('BEGIN IMMEDIATE')
      this.assertExpectedChannelVersion(
        event.package,
        event.channel,
        event.previousVersion,
        this.channelVersion(event.package, event.channel),
      )
      this.assertReleaseExists(event.package, event.version)
      this.insertRegistryEvent(event, authorizationPayloadDigest)
      this.db
        .prepare(
          `INSERT INTO package_channels (package_id, channel, version)
          VALUES (?, ?, ?)
          ON CONFLICT(package_id, channel)
          DO UPDATE SET version = excluded.version`,
        )
        .run(event.package, event.channel, event.version)
      this.db.exec('COMMIT')
    } catch (error) {
      this.rollbackTransaction()

      if (isSqliteUniqueEventIdError(error)) {
        throw new RegistryEventAlreadyExistsError(event.id)
      }

      if (
        authorizationPayloadDigest &&
        isSqliteUniqueAuthorizationPayloadDigestError(error)
      ) {
        throw new WriteAuthorizationReplayError(authorizationPayloadDigest)
      }

      throw error
    }

    return Promise.resolve()
  }

  commitPackageChannelDelete(event: ChannelDeletedEvent): Promise<void> {
    assertPersistableRegistryEvent(event)

    const authorizationPayloadDigest = eventAuthorizationPayloadDigest(event)

    try {
      this.db.exec('BEGIN IMMEDIATE')
      this.assertExpectedChannelVersion(
        event.package,
        event.channel,
        event.previousVersion,
        this.channelVersion(event.package, event.channel),
      )
      this.insertRegistryEvent(event, authorizationPayloadDigest)
      this.db
        .prepare(
          `DELETE FROM package_channels
          WHERE package_id = ? AND channel = ?`,
        )
        .run(event.package, event.channel)
      this.db.exec('COMMIT')
    } catch (error) {
      this.rollbackTransaction()

      if (isSqliteUniqueEventIdError(error)) {
        throw new RegistryEventAlreadyExistsError(event.id)
      }

      if (
        authorizationPayloadDigest &&
        isSqliteUniqueAuthorizationPayloadDigestError(error)
      ) {
        throw new WriteAuthorizationReplayError(authorizationPayloadDigest)
      }

      throw error
    }

    return Promise.resolve()
  }

  commitPublishedRelease(
    release: StoredRelease,
    channel: string,
  ): Promise<void> {
    assertPersistableStoredRelease(release, channel)

    const authorizationPayloadDigest = eventAuthorizationPayloadDigest(
      release.event,
    )
    const packageId = release.manifest.id

    try {
      this.db.exec('BEGIN IMMEDIATE')
      this.insertRegistryEvent(release.event, authorizationPayloadDigest)
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
      this.db
        .prepare(
          `INSERT INTO package_channels (package_id, channel, version)
          VALUES (?, ?, ?)
          ON CONFLICT(package_id, channel)
          DO UPDATE SET version = excluded.version`,
        )
        .run(packageId, channel, release.manifest.version)
      this.db.exec('COMMIT')
    } catch (error) {
      this.rollbackTransaction()

      if (isSqliteUniqueEventIdError(error)) {
        throw new RegistryEventAlreadyExistsError(release.event.id)
      }

      if (
        authorizationPayloadDigest &&
        isSqliteUniqueAuthorizationPayloadDigestError(error)
      ) {
        throw new WriteAuthorizationReplayError(authorizationPayloadDigest)
      }

      if (isSqliteUniqueReleaseError(error)) {
        throw new ReleaseAlreadyExistsError(packageId, release.manifest.version)
      }

      throw error
    }

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

  listEvents(options: RegistryEventListOptions = {}): Promise<RegistryEvent[]> {
    assertEventListOptions(options)

    const afterSequence = options.after
      ? this.eventSequence(options.after)
      : undefined

    if (options.after && afterSequence === undefined) {
      return Promise.reject(new RegistryEventCursorNotFoundError(options.after))
    }

    const rows =
      options.limit === undefined
        ? this.db
            .prepare(
              `SELECT event_json
                FROM registry_events
                WHERE sequence > ?
                ORDER BY sequence ASC`,
            )
            .all(afterSequence ?? 0)
        : this.db
            .prepare(
              `SELECT event_json
                FROM registry_events
                WHERE sequence > ?
                ORDER BY sequence ASC
                LIMIT ?`,
            )
            .all(afterSequence ?? 0, options.limit)

    return Promise.resolve(
      rows.map((row) => decodeRegistryEvent(requiredText(row, 'event_json'))),
    )
  }

  getEvent(id: Sha256Digest): Promise<RegistryEvent | undefined> {
    const row = this.db
      .prepare(
        `SELECT event_json
          FROM registry_events
          WHERE id = ?`,
      )
      .get(id)

    return Promise.resolve(
      row ? decodeRegistryEvent(requiredText(row, 'event_json')) : undefined,
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

  hasAuthorizationPayloadDigest(payloadDigest: Sha256Digest): Promise<boolean> {
    const row = this.db
      .prepare(
        `SELECT 1
          FROM registry_events
          WHERE authorization_payload_digest = ?
          LIMIT 1`,
      )
      .get(payloadDigest)

    return Promise.resolve(Boolean(row))
  }

  listPackageEvents(packageId: PackageId): Promise<RegistryEvent[]> {
    const rows = this.db
      .prepare(
        `SELECT event_json
          FROM registry_events
          WHERE package_id = ?
          ORDER BY sequence ASC`,
      )
      .all(packageId)

    return Promise.resolve(
      rows.map((row) => decodeRegistryEvent(requiredText(row, 'event_json'))),
    )
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
    assertPersistableStoredRelease(release, release.event.channel)

    const packageId = release.manifest.id

    if (await this.getRelease(packageId, release.manifest.version)) {
      throw new ReleaseAlreadyExistsError(packageId, release.manifest.version)
    }

    try {
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
    } catch (error) {
      if (isSqliteUniqueReleaseError(error)) {
        throw new ReleaseAlreadyExistsError(packageId, release.manifest.version)
      }

      throw error
    }
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

  private eventSequence(id: Sha256Digest): number | undefined {
    const row = this.db
      .prepare(
        `SELECT sequence
          FROM registry_events
          WHERE id = ?`,
      )
      .get(id)

    return row ? requiredNumber(row, 'sequence') : undefined
  }

  private eventExists(id: Sha256Digest): boolean {
    return Boolean(
      this.db
        .prepare(
          `SELECT 1
          FROM registry_events
          WHERE id = ?
          LIMIT 1`,
        )
        .get(id),
    )
  }

  private authorizationPayloadDigestExists(
    payloadDigest: Sha256Digest,
  ): boolean {
    return Boolean(
      this.db
        .prepare(
          `SELECT 1
          FROM registry_events
          WHERE authorization_payload_digest = ?
          LIMIT 1`,
        )
        .get(payloadDigest),
    )
  }

  private packageEvents(event: RegistryEvent): RegistryEvent[] {
    const packageId = eventPackageId(event)
    const rows = this.db
      .prepare(
        `SELECT event_json
          FROM registry_events
          WHERE package_id = ?
          ORDER BY sequence ASC`,
      )
      .all(packageId)

    return rows.map((row) =>
      decodeRegistryEvent(requiredText(row, 'event_json')),
    )
  }

  private ensureRegistryEventColumns(): void {
    const columns = this.db
      .prepare(`PRAGMA table_info(registry_events)`)
      .all()
      .map((row) => requiredText(row, 'name'))

    if (!columns.includes('authorization_payload_digest')) {
      this.db.exec(`
        ALTER TABLE registry_events
          ADD COLUMN authorization_payload_digest TEXT;
      `)

      const rows = this.db
        .prepare(`SELECT sequence, event_json FROM registry_events`)
        .all()

      for (const row of rows) {
        const payloadDigest = decodeRegistryEvent(
          requiredText(row, 'event_json'),
        ).authorization?.payloadDigest

        if (payloadDigest) {
          this.db
            .prepare(
              `UPDATE registry_events
                SET authorization_payload_digest = ?
                WHERE sequence = ?`,
            )
            .run(payloadDigest, requiredNumber(row, 'sequence'))
        }
      }
    }
  }

  private rollbackTransaction(): void {
    try {
      this.db.exec('ROLLBACK')
    } catch {
      // Ignore rollback failures so the original write error is preserved.
    }
  }

  private insertRegistryEvent(
    event: RegistryEvent,
    authorizationPayloadDigest: Sha256Digest | null,
  ): void {
    this.db
      .prepare(
        `INSERT INTO registry_events (
          id,
          event_type,
          package_id,
          timestamp,
          authorization_payload_digest,
          event_json
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.id,
        event.eventType,
        eventPackageId(event),
        event.timestamp,
        authorizationPayloadDigest,
        encodeJson(event),
      )
  }

  private assertExpectedChannelVersion(
    packageId: PackageId,
    channel: string,
    expectedVersion: string | undefined,
    actualVersion: string | undefined,
  ): void {
    if (actualVersion !== expectedVersion) {
      throw new PackageChannelConflictError(
        packageId,
        channel,
        expectedVersion,
        actualVersion,
      )
    }
  }

  private assertReleaseExists(packageId: PackageId, version: string): void {
    if (!this.releaseExists(packageId, version)) {
      throw new ReleaseNotFoundError(packageId, version)
    }
  }

  private releaseExists(packageId: PackageId, version: string): boolean {
    return Boolean(
      this.db
        .prepare(
          `SELECT 1
          FROM releases
          WHERE package_id = ? AND version = ?
          LIMIT 1`,
        )
        .get(packageId, version),
    )
  }
}

function decodeStoredRelease(row: SqliteRow): StoredRelease {
  const event = decodeRegistryEvent(requiredText(row, 'event_json'))
  const release: StoredRelease = {
    event,
    manifest: decodeJson(requiredText(row, 'manifest_json')),
    manifestDescriptor: decodeJson(
      requiredText(row, 'manifest_descriptor_json'),
    ),
  }
  const channel = event.eventType === 'release.published' ? event.channel : ''

  assertPersistableStoredRelease(release, channel)

  return release
}

function decodeRegistryEvent(json: string): RegistryEvent {
  const event = decodeJson<RegistryEvent>(json)

  assertPersistableRegistryEvent(event)

  return event
}

function decodeJson<T>(json: string): T {
  return JSON.parse(json)
}

function encodeJson(value: unknown): string {
  return canonicalJson(value)
}

function eventPackageId(event: RegistryEvent): PackageId {
  return event.eventType === 'release.published'
    ? event.release.id
    : event.package
}

function eventAuthorizationPayloadDigest(
  event: RegistryEvent,
): Sha256Digest | null {
  return event.authorization?.payloadDigest ?? null
}

function requiredText(row: SqliteRow, column: string): string {
  const value = row[column]

  if (typeof value !== 'string') {
    throw new TypeError(`SQLite column ${column} must be text`)
  }

  return value
}

function requiredNumber(row: SqliteRow, column: string): number {
  const value = row[column]

  if (typeof value !== 'number') {
    throw new TypeError(`SQLite column ${column} must be a number`)
  }

  return value
}

function isSqliteUniqueAuthorizationPayloadDigestError(
  error: unknown,
): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    error.code === 'ERR_SQLITE_ERROR' &&
    error.message.includes('authorization_payload_digest')
  )
}

function isSqliteUniqueEventIdError(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    error.code === 'ERR_SQLITE_ERROR' &&
    error.message.includes('registry_events.id')
  )
}

function isSqliteUniqueReleaseError(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    error.code === 'ERR_SQLITE_ERROR' &&
    error.message.includes('releases.package_id')
  )
}
