import { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, openSync } from 'node:fs';
import { dirname } from 'node:path';
import { syncDirectory } from './agent-executor';
import type { Category } from './agent-data';

export type FrozenWorkStatus = 'ready' | 'missing' | 'conflict' | 'expired' | 'confirmed';

export interface FrozenSourceMetadata {
  category: Category;
  factId: string;
  sourceHash: string;
  payloadBytes: number;
  eventDay: string;
  ingestedAt: string;
}

export interface FrozenBatch {
  deliveryId: string;
  createdAtMs: number;
  facts: Array<Pick<FrozenSourceMetadata, 'category' | 'factId' | 'sourceHash'>>;
}

const MAX_BATCH_ROWS = 100;
const MAX_BATCH_BYTES = 850_000;

export class FrozenRecoveryJournal {
  readonly db: Database;

  constructor(path: string, orgId: string, censusSha256: string) {
    const create = !existsSync(path);
    if (create) {
      closeSync(openSync(path, 'wx', 0o600));
      syncDirectory(dirname(path));
    }
    this.db = new Database(path, { create: true, strict: true });
    if (create) this.initialize(orgId, censusSha256);
    this.assertMetadata(orgId, censusSha256);
  }

  close(): void {
    this.db.close();
  }

  recordInspection(
    requested: Array<{ category: Category; factId: string }>,
    found: FrozenSourceMetadata[],
    expiredBeforeDay: string,
  ): void {
    const requestedKeys = new Set(requested.map(factKey));
    const foundByKey = new Map<string, FrozenSourceMetadata>();
    for (const source of found) {
      const key = factKey(source);
      if (!requestedKeys.has(key) || foundByKey.has(key)) {
        throw new Error('Frozen source inspection returned an unexpected identity');
      }
      foundByKey.set(key, source);
    }
    this.db.transaction(() => {
      for (const identity of requested) {
        const source = foundByKey.get(factKey(identity));
        if (!source) {
          this.insertStatus(identity, 'missing');
          continue;
        }
        validateSourceMetadata(source);
        const status: FrozenWorkStatus = source.eventDay < expiredBeforeDay ? 'expired' : 'ready';
        this.db
          .query(
            `INSERT INTO facts
             (category,fact_id,source_hash,payload_bytes,event_day,ingested_at,status)
             VALUES (?,?,?,?,?,?,?)
             ON CONFLICT(category,fact_id) DO UPDATE SET
               source_hash=excluded.source_hash,
               payload_bytes=excluded.payload_bytes,
               event_day=excluded.event_day,
               ingested_at=excluded.ingested_at,
               status=excluded.status
             WHERE facts.status NOT IN ('confirmed','conflict')`,
          )
          .run(
            source.category,
            source.factId,
            source.sourceHash,
            source.payloadBytes,
            source.eventDay,
            source.ingestedAt,
            status,
          );
      }
    })();
  }

  markConflicts(identities: Array<{ category: Category; factId: string }>): void {
    this.db.transaction(() => {
      for (const identity of identities) this.setStatus(identity, 'conflict', 'ready');
    })();
  }

  pendingBatches(): FrozenBatch[] {
    return this.db
      .query<{ delivery_id: string; created_at_ms: number }, []>(
        "SELECT delivery_id,created_at_ms FROM batches WHERE status='pending' ORDER BY batch_index",
      )
      .all()
      .map((batch) => this.batch(batch.delivery_id, batch.created_at_ms));
  }

  nextReadyCandidates(): FrozenSourceMetadata[] {
    const rows = this.db
      .query<FrozenSourceMetadata, []>(
        `SELECT category,fact_id AS factId,source_hash AS sourceHash,payload_bytes AS payloadBytes,
                event_day AS eventDay,ingested_at AS ingestedAt
         FROM facts WHERE status='ready' AND delivery_id IS NULL
         ORDER BY category,fact_id LIMIT ${MAX_BATCH_ROWS}`,
      )
      .all();
    const selected: FrozenSourceMetadata[] = [];
    let bytes = 0;
    for (const row of rows) {
      const rowBytes = row.payloadBytes + Buffer.byteLength(row.factId) + 256;
      if (selected.length > 0 && bytes + rowBytes > MAX_BATCH_BYTES) break;
      selected.push(row);
      bytes += rowBytes;
    }
    return selected;
  }

  createBatch(selected: FrozenSourceMetadata[], now = Date.now()): FrozenBatch {
    if (selected.length === 0 || selected.length > MAX_BATCH_ROWS) {
      throw new Error('Frozen recovery batch size is invalid');
    }
    return this.db.transaction(() => {
      const deliveryId = randomUUID();
      const batchIndex = Number(
        this.db.query<{ value: number }, []>('SELECT count(*) AS value FROM batches').get()?.value,
      );
      this.db
        .query(
          "INSERT INTO batches(batch_index,delivery_id,created_at_ms,status) VALUES(?,?,?,'pending')",
        )
        .run(batchIndex, deliveryId, now);
      for (const row of selected) {
        const changed = this.db
          .query(
            "UPDATE facts SET delivery_id=? WHERE category=? AND fact_id=? AND status='ready' AND delivery_id IS NULL",
          )
          .run(deliveryId, row.category, row.factId).changes;
        if (changed !== 1) throw new Error('Frozen recovery fact is no longer ready');
      }
      return this.batch(deliveryId, now);
    })();
  }

  confirm(deliveryId: string): void {
    this.db.transaction(() => {
      const changed = this.db
        .query("UPDATE batches SET status='confirmed' WHERE delivery_id=? AND status='pending'")
        .run(deliveryId).changes;
      if (changed !== 1) throw new Error('Frozen recovery batch is not pending');
      this.db.query("UPDATE facts SET status='confirmed' WHERE delivery_id=?").run(deliveryId);
    })();
  }

  report(): Record<FrozenWorkStatus | 'total', number> {
    const report = { total: 0, ready: 0, missing: 0, conflict: 0, expired: 0, confirmed: 0 };
    for (const row of this.db
      .query<
        { status: FrozenWorkStatus; count: number },
        []
      >('SELECT status,count(*) AS count FROM facts GROUP BY status')
      .all()) {
      report[row.status] = Number(row.count);
      report.total += Number(row.count);
    }
    return report;
  }

  private batch(deliveryId: string, createdAtMs: number): FrozenBatch {
    const facts = this.db
      .query<{ category: Category; factId: string; sourceHash: string }, [string]>(
        `SELECT category,fact_id AS factId,source_hash AS sourceHash FROM facts
         WHERE delivery_id=? ORDER BY category,fact_id`,
      )
      .all(deliveryId);
    if (facts.length === 0) throw new Error('Frozen recovery batch has no facts');
    return { deliveryId, createdAtMs, facts };
  }

  private insertStatus(identity: { category: Category; factId: string }, status: FrozenWorkStatus) {
    this.db
      .query(
        `INSERT INTO facts(category,fact_id,status) VALUES(?,?,?)
         ON CONFLICT(category,fact_id) DO NOTHING`,
      )
      .run(identity.category, identity.factId, status);
  }

  private setStatus(
    identity: { category: Category; factId: string },
    status: FrozenWorkStatus,
    expected: FrozenWorkStatus,
  ) {
    this.db
      .query('UPDATE facts SET status=? WHERE category=? AND fact_id=? AND status=?')
      .run(status, identity.category, identity.factId, expected);
  }

  private initialize(orgId: string, censusSha256: string): void {
    this.db.exec(`
      PRAGMA journal_mode=DELETE;
      PRAGMA synchronous=FULL;
      CREATE TABLE metadata(key TEXT PRIMARY KEY,data TEXT NOT NULL);
      CREATE TABLE facts(
        category TEXT NOT NULL,fact_id TEXT NOT NULL,source_hash TEXT,payload_bytes INTEGER,
        event_day TEXT,ingested_at TEXT,status TEXT NOT NULL,delivery_id TEXT,
        PRIMARY KEY(category,fact_id)
      ) WITHOUT ROWID;
      CREATE TABLE batches(
        batch_index INTEGER PRIMARY KEY,delivery_id TEXT NOT NULL UNIQUE,
        created_at_ms INTEGER NOT NULL,status TEXT NOT NULL
      );
    `);
    this.db.query('INSERT INTO metadata VALUES(?,?)').run('org_id', orgId);
    this.db.query('INSERT INTO metadata VALUES(?,?)').run('census_sha256', censusSha256);
  }

  private assertMetadata(orgId: string, censusSha256: string): void {
    const get = (key: string) =>
      this.db.query<{ data: string }, [string]>('SELECT data FROM metadata WHERE key=?').get(key)
        ?.data;
    if (get('org_id') !== orgId || get('census_sha256') !== censusSha256) {
      throw new Error('Frozen recovery journal belongs to another organization or census');
    }
  }
}

function factKey(value: { category: Category; factId: string }): string {
  return `${value.category}\u0000${value.factId}`;
}

function validateSourceMetadata(value: FrozenSourceMetadata): void {
  if (
    !/^[a-f0-9]{16}$/.test(value.sourceHash) ||
    !Number.isSafeInteger(value.payloadBytes) ||
    value.payloadBytes < 2 ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value.eventDay) ||
    !Number.isFinite(Date.parse(value.ingestedAt.replace(' ', 'T') + 'Z'))
  ) {
    throw new Error('Invalid frozen source inspection result');
  }
}
