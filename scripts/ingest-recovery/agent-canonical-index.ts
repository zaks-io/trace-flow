import { Database } from 'bun:sqlite';
import { closeSync, existsSync, openSync } from 'node:fs';
import { dirname } from 'node:path';
import { agentAnalyticsDayBounds } from '../../packages/utils/src/agent-retention';
import { syncDirectory } from './agent-executor';
import type { Category } from './agent-data';

export interface CanonicalHashRow {
  category: Category;
  factId: string;
  eventDay: string;
  deliverySequence: number;
  contentHash: string;
  ingestedAtMs: number;
  rowSha256: string;
}

export interface SourceSchema {
  columns: string[];
  meta: { name: string; type: string }[];
}

export class CanonicalHashIndex {
  readonly db: Database;

  constructor(
    path: string,
    readonly orgId: string,
    readonly tinybirdHost: string,
    readonly oldestDay: string,
    readonly todayDay: string,
  ) {
    const create = !existsSync(path);
    if (create) {
      closeSync(openSync(path, 'wx', 0o600));
      syncDirectory(dirname(path));
    }
    this.db = new Database(path, { create: true, strict: true });
    if (create) this.initialize();
    this.assertMetadata();
  }

  close(): void {
    this.db.close();
  }

  get complete(): boolean {
    return this.meta('complete') === 'true';
  }

  get exportDeliverySequence(): number | undefined {
    const value = this.meta('export_delivery_sequence');
    if (value === undefined) return undefined;
    const sequence = Number(value);
    if (!Number.isSafeInteger(sequence) || sequence < 1) {
      throw new Error('Canonical hash index has an invalid delivery fence');
    }
    return sequence;
  }

  beginExport(deliverySequence: number): void {
    if (!Number.isSafeInteger(deliverySequence) || deliverySequence < 1) {
      throw new Error('Canonical export requires a valid delivery fence');
    }
    const existing = this.exportDeliverySequence;
    if (existing !== undefined && existing !== deliverySequence) {
      throw new Error('Canonical hash index became stale before export completed');
    }
    if (existing === undefined) this.setMeta('export_delivery_sequence', String(deliverySequence));
  }

  sourceSchema(category: Category): SourceSchema | undefined {
    const value = this.meta(`schema:${category}`);
    return value ? (JSON.parse(value) as SourceSchema) : undefined;
  }

  saveSourceSchema(category: Category, schema: SourceSchema): void {
    const existing = this.sourceSchema(category);
    if (existing && JSON.stringify(existing) !== JSON.stringify(schema)) {
      throw new Error(`Canonical index ${category} schema changed during export`);
    }
    if (!existing) this.setMeta(`schema:${category}`, JSON.stringify(schema));
  }

  progress(category: Category, eventDay: string): { afterSession: string; afterPk: string } | null {
    return (
      this.db
        .query<{ afterSession: string; afterPk: string }, [string, string]>(
          `SELECT after_session AS afterSession,after_pk AS afterPk FROM progress
           WHERE category=? AND event_day=? AND complete=0`,
        )
        .get(category, eventDay) ?? null
    );
  }

  dayComplete(category: Category, eventDay: string): boolean {
    return (
      this.db
        .query<
          { complete: number },
          [string, string]
        >('SELECT complete FROM progress WHERE category=? AND event_day=?')
        .get(category, eventDay)?.complete === 1
    );
  }

  savePage(
    category: Category,
    eventDay: string,
    rows: CanonicalHashRow[],
    afterSession: string,
    afterPk: string,
  ): void {
    this.db.transaction(() => {
      for (const row of rows) {
        this.db
          .query(
            `INSERT INTO canonical
             (category,fact_id,event_day,delivery_sequence,content_hash,ingested_at_ms,row_sha256)
             VALUES(?,?,?,?,?,?,?)`,
          )
          .run(
            row.category,
            row.factId,
            row.eventDay,
            row.deliverySequence,
            row.contentHash,
            row.ingestedAtMs,
            row.rowSha256,
          );
      }
      this.db
        .query(
          `INSERT INTO progress(category,event_day,after_session,after_pk,complete)
           VALUES(?,?,?,?,0) ON CONFLICT(category,event_day) DO UPDATE SET
           after_session=excluded.after_session,after_pk=excluded.after_pk`,
        )
        .run(category, eventDay, afterSession, afterPk);
    })();
  }

  finishDay(category: Category, eventDay: string): void {
    this.db
      .query(
        `INSERT INTO progress(category,event_day,after_session,after_pk,complete)
         VALUES(?,?, '', '',1) ON CONFLICT(category,event_day) DO UPDATE SET complete=1`,
      )
      .run(category, eventDay);
  }

  finishExport(deliverySequence: number): void {
    if (this.exportDeliverySequence !== deliverySequence) {
      throw new Error('Canonical export delivery fence changed');
    }
    this.setMeta('complete', 'true');
  }

  get(category: Category, factId: string): CanonicalHashRow | null {
    return (
      this.db
        .query<CanonicalHashRow, [string, string]>(
          `SELECT category,fact_id AS factId,event_day AS eventDay,
                  delivery_sequence AS deliverySequence,content_hash AS contentHash,
                  ingested_at_ms AS ingestedAtMs,row_sha256 AS rowSha256
           FROM canonical WHERE category=? AND fact_id=?`,
        )
        .get(category, factId) ?? null
    );
  }

  private initialize(): void {
    this.db.exec(`
      PRAGMA journal_mode=DELETE;
      PRAGMA synchronous=FULL;
      CREATE TABLE metadata(key TEXT PRIMARY KEY,data TEXT NOT NULL);
      CREATE TABLE canonical(
        category TEXT NOT NULL,fact_id TEXT NOT NULL,event_day TEXT NOT NULL,
        delivery_sequence INTEGER NOT NULL,content_hash TEXT NOT NULL,
        ingested_at_ms INTEGER NOT NULL,row_sha256 TEXT NOT NULL,
        PRIMARY KEY(category,fact_id)
      ) WITHOUT ROWID;
      CREATE TABLE progress(
        category TEXT NOT NULL,event_day TEXT NOT NULL,after_session TEXT NOT NULL,
        after_pk TEXT NOT NULL,complete INTEGER NOT NULL,
        PRIMARY KEY(category,event_day)
      ) WITHOUT ROWID;
    `);
    for (const [key, data] of [
      ['org_id', this.orgId],
      ['tinybird_host', this.tinybirdHost],
      ['oldest_day', this.oldestDay],
      ['today_day', this.todayDay],
      ['complete', 'false'],
    ]) {
      this.setMeta(key, data);
    }
  }

  private assertMetadata(): void {
    if (
      this.meta('org_id') !== this.orgId ||
      this.meta('tinybird_host') !== this.tinybirdHost ||
      this.meta('oldest_day') !== this.oldestDay ||
      this.meta('today_day') !== this.todayDay
    ) {
      throw new Error('Canonical hash index belongs to another target or retention window');
    }
  }

  private meta(key: string): string | undefined {
    return this.db
      .query<{ data: string }, [string]>('SELECT data FROM metadata WHERE key=?')
      .get(key)?.data;
  }

  private setMeta(key: string, data: string): void {
    this.db.query('INSERT OR REPLACE INTO metadata VALUES(?,?)').run(key, data);
  }
}

export function currentCanonicalIndex(
  path: string,
  orgId: string,
  host: string,
): CanonicalHashIndex {
  const { oldestDay, today } = agentAnalyticsDayBounds(Date.now());
  return new CanonicalHashIndex(path, orgId, host, oldestDay, today);
}

export function canonicalDeliveryFence(state: unknown): number {
  const value = state as {
    migration?: { complete?: unknown };
    coordinator?: { activeDeliveries?: unknown; lastDeliverySequence?: unknown };
  };
  if (
    value?.migration?.complete !== true ||
    value?.coordinator?.activeDeliveries !== 0 ||
    !Number.isSafeInteger(value?.coordinator?.lastDeliverySequence) ||
    (value.coordinator!.lastDeliverySequence as number) < 1
  ) {
    throw new Error('Canonical export requires a quiescent completed ingestion migration');
  }
  return value.coordinator.lastDeliverySequence as number;
}

export function assertSameCanonicalFence(expected: number, state: unknown): void {
  if (canonicalDeliveryFence(state) !== expected) {
    throw new Error('Canonical facts changed during frozen ledger verification');
  }
}

export function assertCurrentCanonicalWindow(index: CanonicalHashIndex): void {
  const { oldestDay, today } = agentAnalyticsDayBounds(Date.now());
  if (index.oldestDay !== oldestDay || index.todayDay !== today) {
    throw new Error('Analytics retention window changed during frozen ledger verification');
  }
}
