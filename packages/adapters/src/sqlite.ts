import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  PackageChannelConflictError,
  RegistryEventAlreadyExistsError,
  RegistryEventCursorNotFoundError,
  RegistryEventIntegrityError,
  ReleaseAlreadyExistsError,
  ReleaseNotFoundError,
  WriteAuthorizationReplayError,
} from '@regesta/core'
import {
  assertSha256Digest,
  canonicalJson,
  parsePackageId,
  type ChannelDeletedEvent,
  type ChannelUpdatedEvent,
  type PackageId,
  type PackageStateRelease,
  type RegistryEvent,
  type Sha256Digest,
} from '@regesta/protocol'
import {
  assertPersistableRegistryEvent,
  assertPersistableStoredRelease,
} from './events.ts'
import { assertEventListOptions } from './pagination.ts'
import type {
  PackageStateSnapshot,
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

      CREATE TABLE IF NOT EXISTS registry_event_releases (
        package_id TEXT NOT NULL,
        version TEXT NOT NULL,
        created_at TEXT NOT NULL,
        manifest_digest TEXT NOT NULL,
        PRIMARY KEY (package_id, version)
      );

      CREATE TABLE IF NOT EXISTS registry_event_channels (
        package_id TEXT NOT NULL,
        channel TEXT NOT NULL,
        version TEXT NOT NULL,
        PRIMARY KEY (package_id, channel)
      );

      CREATE TABLE IF NOT EXISTS registry_event_state_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS registry_stats (
        key TEXT PRIMARY KEY,
        value INTEGER NOT NULL CHECK (value >= 0)
      );

    `)
    this.ensureRegistryEventColumns()
    this.ensureRegistryEventReleaseColumns()
    this.ensureRegistryEventState()
    this.ensureRegistryStats()
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

  countPackages(): Promise<number> {
    return Promise.resolve().then(() => this.registryStat('package_count'))
  }

  appendEvent(event: RegistryEvent): Promise<void> {
    assertPersistableRegistryEvent(event)

    const authorizationPayloadDigest = eventAuthorizationPayloadDigest(event)

    try {
      this.db.exec('BEGIN IMMEDIATE')
      this.assertEventCanBeInserted(event, authorizationPayloadDigest)
      this.assertRegistryEventCanBeApplied(event)
      this.insertRegistryEvent(event, authorizationPayloadDigest)
      this.applyRegistryEventState(event)
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
      this.assertEventCanBeInserted(event, authorizationPayloadDigest)
      this.assertEventReleaseExists(event.package, event.version)
      this.assertEventChannelVersion(
        event.package,
        event.channel,
        event.previousVersion,
      )
      this.insertRegistryEvent(event, authorizationPayloadDigest)
      this.applyRegistryEventState(event)
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
      this.assertEventCanBeInserted(event, authorizationPayloadDigest)
      this.assertEventChannelVersion(
        event.package,
        event.channel,
        event.previousVersion,
      )
      this.insertRegistryEvent(event, authorizationPayloadDigest)
      this.applyRegistryEventState(event)
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
      this.assertEventCanBeInserted(release.event, authorizationPayloadDigest)
      if (this.releaseExists(packageId, release.manifest.version)) {
        throw new ReleaseAlreadyExistsError(packageId, release.manifest.version)
      }
      const newPackage = !this.packageExists(packageId)
      this.assertRegistryEventCanBeApplied(release.event)
      this.insertRegistryEvent(release.event, authorizationPayloadDigest)
      this.applyRegistryEventState(release.event)
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
      if (newPackage) {
        this.incrementRegistryStat('package_count', 1)
      }
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

  getPackageEventHead(packageId: PackageId): Promise<{
    lastEventId?: Sha256Digest
    lastEventTimestamp?: string
    modifiedAt?: string
    releaseCount: number
  }> {
    const releaseCountRow = this.db
      .prepare(
        `SELECT COUNT(*) AS count, MAX(created_at) AS modified_at
          FROM registry_event_releases
          WHERE package_id = ?`,
      )
      .get(packageId)
    const lastEventRow = this.db
      .prepare(
        `SELECT id, timestamp
          FROM registry_events
          WHERE package_id = ?
          ORDER BY sequence DESC
          LIMIT 1`,
      )
      .get(packageId)

    if (!releaseCountRow) {
      throw new TypeError('Package release count query did not return a row')
    }

    return Promise.resolve({
      ...(lastEventRow
        ? {
            lastEventId: requiredSha256Digest(lastEventRow, 'id'),
            lastEventTimestamp: requiredText(lastEventRow, 'timestamp'),
          }
        : {}),
      ...optionalModifiedAt(releaseCountRow, lastEventRow),
      releaseCount: requiredNonNegativeInteger(releaseCountRow, 'count'),
    })
  }

  getPackageEventState(packageId: PackageId): Promise<PackageStateSnapshot> {
    const parsed = parsePackageId(packageId)
    const releaseRows = this.db
      .prepare(
        `SELECT version, created_at, manifest_digest
          FROM registry_event_releases
          WHERE package_id = ?
          ORDER BY created_at ASC, version ASC`,
      )
      .all(packageId)
    const channelRows = this.db
      .prepare(
        `SELECT channel, version
          FROM registry_event_channels
          WHERE package_id = ?
          ORDER BY channel ASC`,
      )
      .all(packageId)
    const lastEventRow = this.db
      .prepare(
        `SELECT id, timestamp
          FROM registry_events
          WHERE package_id = ?
          ORDER BY sequence DESC
          LIMIT 1`,
      )
      .get(packageId)
    const channels = Object.fromEntries(
      channelRows.map((row) => [
        requiredText(row, 'channel'),
        requiredText(row, 'version'),
      ]),
    )

    return Promise.resolve({
      ...(lastEventRow
        ? {
            lastEventId: requiredSha256Digest(lastEventRow, 'id'),
            lastEventTimestamp: requiredText(lastEventRow, 'timestamp'),
          }
        : {}),
      state: {
        ...(Object.keys(channels).length === 0 ? {} : { channels }),
        ecosystem: parsed.ecosystem,
        id: packageId,
        name: parsed.name,
        object: 'regesta.package-state',
        releases: releaseRows.map((row) => {
          return {
            createdAt: requiredText(row, 'created_at'),
            manifestDigest: requiredSha256Digest(row, 'manifest_digest'),
            version: requiredText(row, 'version'),
          } satisfies PackageStateRelease
        }),
      },
    })
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

  hasPackage(packageId: PackageId): Promise<boolean> {
    return Promise.resolve(this.packageExists(packageId))
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
      this.db.exec('BEGIN IMMEDIATE')
      const newPackage = !this.packageExists(packageId)
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
      if (newPackage) {
        this.incrementRegistryStat('package_count', 1)
      }
      this.db.exec('COMMIT')
    } catch (error) {
      this.rollbackTransaction()

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

  private packageExists(packageId: PackageId): boolean {
    return Boolean(
      this.db
        .prepare(
          `SELECT 1
          FROM releases
          WHERE package_id = ?
          LIMIT 1`,
        )
        .get(packageId),
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

  private ensureRegistryEventReleaseColumns(): void {
    const columns = new Set(
      this.db
        .prepare(`PRAGMA table_info(registry_event_releases)`)
        .all()
        .map((row) => requiredText(row, 'name')),
    )

    if (columns.has('created_at') && columns.has('manifest_digest')) {
      return
    }

    this.db.exec(`
      DROP TABLE registry_event_releases;

      CREATE TABLE registry_event_releases (
        package_id TEXT NOT NULL,
        version TEXT NOT NULL,
        created_at TEXT NOT NULL,
        manifest_digest TEXT NOT NULL,
        PRIMARY KEY (package_id, version)
      );

      DELETE FROM registry_event_state_meta
        WHERE key = 'rebuilt';
    `)
  }

  private ensureRegistryEventState(): void {
    if (this.registryEventStateExists()) {
      return
    }

    try {
      this.db.exec('BEGIN IMMEDIATE')
      this.db.prepare(`DELETE FROM registry_event_channels`).run()
      this.db.prepare(`DELETE FROM registry_event_releases`).run()

      const rows = this.db
        .prepare(
          `SELECT event_json
            FROM registry_events
            ORDER BY sequence ASC`,
        )
        .all()

      for (const row of rows) {
        const event = decodeRegistryEvent(requiredText(row, 'event_json'))
        this.assertRegistryEventCanBeApplied(event)
        this.applyRegistryEventState(event)
      }

      this.db
        .prepare(
          `INSERT INTO registry_event_state_meta (key, value)
            VALUES ('rebuilt', '1')
            ON CONFLICT(key)
            DO UPDATE SET value = excluded.value`,
        )
        .run()
      this.db.exec('COMMIT')
    } catch (error) {
      this.rollbackTransaction()
      throw error
    }
  }

  private registryEventStateExists(): boolean {
    return Boolean(
      this.db
        .prepare(
          `SELECT 1
            FROM registry_event_state_meta
            WHERE key = 'rebuilt'
            LIMIT 1`,
        )
        .get(),
    )
  }

  private assertRegistryEventCanBeApplied(event: RegistryEvent): void {
    switch (event.eventType) {
      case 'release.published': {
        if (this.eventReleaseExists(event.release.id, event.release.version)) {
          throw new RegistryEventIntegrityError(
            `Registry event release version already exists: ${event.release.version}`,
          )
        }
        break
      }
      case 'channel.updated': {
        this.assertEventReleaseExists(event.package, event.version)
        this.assertEventChannelVersion(
          event.package,
          event.channel,
          event.previousVersion,
        )
        break
      }
      case 'channel.deleted': {
        this.assertEventChannelVersion(
          event.package,
          event.channel,
          event.previousVersion,
        )
        break
      }
    }
  }

  private applyRegistryEventState(event: RegistryEvent): void {
    switch (event.eventType) {
      case 'release.published': {
        this.db
          .prepare(
            `INSERT INTO registry_event_releases (
              package_id,
              version,
              created_at,
              manifest_digest
            ) VALUES (?, ?, ?, ?)`,
          )
          .run(
            event.release.id,
            event.release.version,
            event.timestamp,
            event.release.manifestDigest,
          )
        this.db
          .prepare(
            `INSERT INTO registry_event_channels (package_id, channel, version)
              VALUES (?, ?, ?)
              ON CONFLICT(package_id, channel)
              DO UPDATE SET version = excluded.version`,
          )
          .run(event.release.id, event.channel, event.release.version)
        break
      }
      case 'channel.updated': {
        this.db
          .prepare(
            `INSERT INTO registry_event_channels (package_id, channel, version)
              VALUES (?, ?, ?)
              ON CONFLICT(package_id, channel)
              DO UPDATE SET version = excluded.version`,
          )
          .run(event.package, event.channel, event.version)
        break
      }
      case 'channel.deleted': {
        this.db
          .prepare(
            `DELETE FROM registry_event_channels
              WHERE package_id = ? AND channel = ?`,
          )
          .run(event.package, event.channel)
        break
      }
    }
  }

  private ensureRegistryStats(): void {
    if (this.registryStatExists('package_count')) {
      return
    }

    const row = this.db
      .prepare('SELECT COUNT(DISTINCT package_id) AS count FROM releases')
      .get()
    if (!row) {
      throw new TypeError('Package count query did not return a row')
    }

    this.db
      .prepare(
        `INSERT INTO registry_stats (key, value)
          VALUES ('package_count', ?)
          ON CONFLICT(key)
          DO UPDATE SET value = excluded.value`,
      )
      .run(requiredNumber(row, 'count'))
  }

  private registryStatExists(key: string): boolean {
    return Boolean(
      this.db
        .prepare(
          `SELECT 1
          FROM registry_stats
          WHERE key = ?
          LIMIT 1`,
        )
        .get(key),
    )
  }

  private registryStat(key: string): number {
    const row = this.db
      .prepare(
        `SELECT value
          FROM registry_stats
          WHERE key = ?`,
      )
      .get(key)

    if (!row) {
      throw new TypeError(`SQLite registry statistic is missing: ${key}`)
    }

    return requiredNonNegativeInteger(row, 'value')
  }

  private incrementRegistryStat(key: string, increment: number): void {
    const result = this.db
      .prepare(
        `UPDATE registry_stats
          SET value = value + ?
          WHERE key = ?`,
      )
      .run(increment, key)

    if (result.changes !== 1) {
      throw new TypeError(`SQLite registry statistic is missing: ${key}`)
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

  private assertEventCanBeInserted(
    event: RegistryEvent,
    authorizationPayloadDigest: Sha256Digest | null,
  ): void {
    if (this.eventExists(event.id)) {
      throw new RegistryEventAlreadyExistsError(event.id)
    }

    if (
      authorizationPayloadDigest &&
      this.authorizationPayloadDigestExists(authorizationPayloadDigest)
    ) {
      throw new WriteAuthorizationReplayError(authorizationPayloadDigest)
    }
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

  private assertEventReleaseExists(
    packageId: PackageId,
    version: string,
  ): void {
    if (!this.eventReleaseExists(packageId, version)) {
      throw new RegistryEventIntegrityError(
        `Registry event channel target version does not exist: ${version}`,
      )
    }
  }

  private assertEventChannelVersion(
    packageId: PackageId,
    channel: string,
    expectedVersion: string | undefined,
  ): void {
    const actualVersion = this.eventChannelVersion(packageId, channel)

    if (actualVersion !== expectedVersion) {
      throw new RegistryEventIntegrityError(
        `Registry event previousVersion does not match indexed event channel state: ${packageId}#${channel}`,
      )
    }
  }

  private eventReleaseExists(packageId: PackageId, version: string): boolean {
    return Boolean(
      this.db
        .prepare(
          `SELECT 1
            FROM registry_event_releases
            WHERE package_id = ? AND version = ?
            LIMIT 1`,
        )
        .get(packageId, version),
    )
  }

  private eventChannelVersion(
    packageId: PackageId,
    channel: string,
  ): string | undefined {
    const row = this.db
      .prepare(
        `SELECT version
          FROM registry_event_channels
          WHERE package_id = ? AND channel = ?`,
      )
      .get(packageId, channel)

    return row ? requiredText(row, 'version') : undefined
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

function requiredSha256Digest(row: SqliteRow, column: string): Sha256Digest {
  return assertSha256Digest(requiredText(row, column))
}

function requiredNumber(row: SqliteRow, column: string): number {
  const value = row[column]

  if (typeof value !== 'number') {
    throw new TypeError(`SQLite column ${column} must be a number`)
  }

  return value
}

function requiredNonNegativeInteger(row: SqliteRow, column: string): number {
  const value = requiredNumber(row, column)

  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError(
      `SQLite column ${column} must be a non-negative integer`,
    )
  }

  return value
}

function optionalModifiedAt(
  releaseCountRow: SqliteRow,
  lastEventRow: SqliteRow | undefined,
): { modifiedAt?: string } {
  const releaseModifiedAt = optionalText(releaseCountRow, 'modified_at')
  const lastEventTimestamp = lastEventRow
    ? requiredText(lastEventRow, 'timestamp')
    : undefined
  const modifiedAt = latestTimestamp(
    [releaseModifiedAt, lastEventTimestamp].filter(
      (value) => value !== undefined,
    ),
  )

  return modifiedAt ? { modifiedAt } : {}
}

function optionalText(row: SqliteRow, column: string): string | undefined {
  const value = row[column]

  if (value === null || value === undefined) {
    return undefined
  }

  if (typeof value !== 'string') {
    throw new TypeError(`SQLite column ${column} must be text`)
  }

  return value
}

function latestTimestamp(timestamps: string[]): string | undefined {
  return timestamps.toSorted().at(-1)
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
