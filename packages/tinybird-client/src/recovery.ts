import type { DurableObjectStorage } from '@cloudflare/workers-types';

export type RecoveryKind = 'tinybird_insert' | 'repair' | 'dlq';
export type RecoveryState = 'blocked' | 'resolved';
export type RecoveryClassification = 'rejected' | 'uncertain' | 'changed' | 'dead_letter';

export interface RecoveryRecord {
  id: number;
  kind: RecoveryKind;
  state: RecoveryState;
  classification: RecoveryClassification;
  target: string | null;
  payload: string;
  outcome: string;
  createdAtMs: number;
  resolvedAtMs: number | null;
  resolution: string | null;
  resolutionReason: string | null;
}

export interface RecoveryPageOptions {
  afterId?: number;
  limit?: number;
  state?: RecoveryState;
}

export interface RecoveryPage {
  records: RecoveryRecord[];
  nextAfterId: number | null;
}

export interface ReconcileRecoveryInput {
  recoveryId: number;
  action: 'confirm-written' | 'confirm-not-written' | 'retain-original';
  reason: string;
}

export interface ReplayDlqInput {
  recoveryId: number;
  reason: string;
}

interface StoredRecoveryRecord {
  [key: string]: string | number | null;
  id: number;
  kind: RecoveryKind;
  state: 'in_flight' | RecoveryState;
  classification: RecoveryClassification | null;
  target: string | null;
  target_key: string | null;
  payload: string;
  outcome: string;
  created_at_ms: number;
  resolved_at_ms: number | null;
  resolution: string | null;
  resolution_reason: string | null;
}

const RECOVERY_CHUNK_BYTES = 900_000;
const RECOVERY_PAGE_BYTES = 4_000_000;

export class TinybirdRecoveryStore {
  constructor(private readonly storage: DurableObjectStorage) {}

  initialize(): void {
    this.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS recovery_records (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        state TEXT NOT NULL,
        classification TEXT,
        target TEXT,
        target_key TEXT,
        dedupe_key TEXT,
        payload TEXT NOT NULL,
        outcome TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        resolved_at_ms INTEGER,
        resolution TEXT,
        resolution_reason TEXT
      )
    `);
    this.ensureColumn('recovery_records', 'dedupe_key', 'TEXT');
    this.storage.sql.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_recovery_dlq_dedupe
       ON recovery_records(kind, dedupe_key) WHERE kind = 'dlq' AND dedupe_key IS NOT NULL`,
    );
    this.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS recovery_items (
        recovery_id INTEGER NOT NULL,
        row_id INTEGER NOT NULL,
        target_key TEXT NOT NULL,
        PRIMARY KEY (recovery_id, row_id, target_key)
      )
    `);
    this.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS recovery_payload_chunks (
        recovery_id INTEGER NOT NULL,
        chunk_index INTEGER NOT NULL,
        data TEXT NOT NULL,
        PRIMARY KEY (recovery_id, chunk_index)
      )
    `);
    this.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS recovery_outcome_chunks (
        recovery_id INTEGER NOT NULL,
        chunk_index INTEGER NOT NULL,
        data TEXT NOT NULL,
        PRIMARY KEY (recovery_id, chunk_index)
      )
    `);
    this.storage.sql.exec(
      'CREATE INDEX IF NOT EXISTS idx_recovery_items_row_target ON recovery_items(row_id, target_key)',
    );
    const interrupted = [
      ...this.storage.sql.exec<{ id: number }>(
        `SELECT id FROM recovery_records WHERE state = 'in_flight'`,
      ),
    ];
    for (const { id } of interrupted) {
      this.storage.sql.exec(
        `UPDATE recovery_records SET state = 'blocked', classification = 'uncertain', outcome = ?
         WHERE id = ?`,
        JSON.stringify({ reason: 'worker_restarted_with_in_flight_insert' }),
        id,
      );
      this.storage.sql.exec('DELETE FROM recovery_outcome_chunks WHERE recovery_id = ?', id);
    }
  }

  beginInsert(target: string, targetKey: string, payload: string, rowIds: number[]): number {
    return this.insertRecord(
      'tinybird_insert',
      'in_flight',
      null,
      target,
      targetKey,
      payload,
      JSON.stringify({ startedAtMs: Date.now() }),
      rowIds,
    );
  }

  preserveInsert(
    target: string,
    targetKey: string,
    payload: string,
    rowIds: number[],
    classification: 'rejected' | 'uncertain',
    outcome: string,
  ): number {
    return this.insertRecord(
      'tinybird_insert',
      'blocked',
      classification,
      target,
      targetKey,
      payload,
      outcome,
      rowIds,
    );
  }

  blockInsert(id: number, classification: 'rejected' | 'uncertain', outcome: string): void {
    this.storage.transactionSync(() => {
      this.storage.sql.exec(
        `UPDATE recovery_records SET state = 'blocked', classification = ?, outcome = ''
         WHERE id = ? AND state = 'in_flight'`,
        classification,
        id,
      );
      this.storage.sql.exec('DELETE FROM recovery_outcome_chunks WHERE recovery_id = ?', id);
      for (const [index, chunk] of splitUtf8Chunks(outcome, RECOVERY_CHUNK_BYTES).entries()) {
        this.storage.sql.exec(
          'INSERT INTO recovery_outcome_chunks (recovery_id, chunk_index, data) VALUES (?, ?, ?)',
          id,
          index,
          chunk,
        );
      }
    });
  }

  preserveRepair(payload: string, outcome: string, dedupeKey: string): RecoveryRecord {
    const existing = [
      ...this.storage.sql.exec<{ id: number }>(
        `SELECT id FROM recovery_records WHERE kind = 'repair' AND dedupe_key = ?`,
        dedupeKey,
      ),
    ][0];
    if (existing) return this.get(existing.id);
    return this.get(
      this.insertRecord(
        'repair',
        'blocked',
        'changed',
        null,
        null,
        payload,
        outcome,
        [],
        dedupeKey,
      ),
    );
  }

  preserveDlq(payload: string, outcome: string, dedupeKey: string): RecoveryRecord {
    const existing = [
      ...this.storage.sql.exec<{ id: number }>(
        `SELECT id FROM recovery_records WHERE kind = 'dlq' AND dedupe_key = ?`,
        dedupeKey,
      ),
    ][0];
    if (existing) return this.get(existing.id);
    return this.get(
      this.insertRecord(
        'dlq',
        'blocked',
        'dead_letter',
        null,
        null,
        payload,
        outcome,
        [],
        dedupeKey,
      ),
    );
  }

  discardIntent(id: number): void {
    this.storage.transactionSync(() => {
      this.storage.sql.exec('DELETE FROM recovery_items WHERE recovery_id = ?', id);
      this.storage.sql.exec('DELETE FROM recovery_payload_chunks WHERE recovery_id = ?', id);
      this.storage.sql.exec('DELETE FROM recovery_outcome_chunks WHERE recovery_id = ?', id);
      this.storage.sql.exec(
        'DELETE FROM recovery_records WHERE id = ? AND state = ?',
        id,
        'in_flight',
      );
    });
  }

  list(options: RecoveryPageOptions = {}): RecoveryPage {
    const { afterId, limit, state } = validateRecoveryPageOptions(options);
    const rows = [
      ...this.storage.sql.exec<StoredRecoveryRecord>(
        'SELECT * FROM recovery_records WHERE id > ? AND state = ? ORDER BY id LIMIT ?',
        afterId,
        state,
        limit + 1,
      ),
    ];
    const records: RecoveryRecord[] = [];
    let bytes = 0;
    for (const row of rows.slice(0, limit)) {
      const record = this.toRecoveryRecord(row);
      const recordBytes = new TextEncoder().encode(JSON.stringify(record)).byteLength;
      if (records.length > 0 && bytes + recordBytes > RECOVERY_PAGE_BYTES) break;
      records.push(record);
      bytes += recordBytes;
    }
    const lastId = records[records.length - 1]?.id ?? null;
    const hasMore = rows.some((row) => lastId === null || row.id > lastId);
    return { records, nextAfterId: hasMore ? lastId : null };
  }

  get(id: number): RecoveryRecord {
    return this.toRecoveryRecord(this.getStored(id));
  }

  getTargetKey(id: number): string {
    const value = this.getStored(id).target_key;
    if (!value) throw new Error('recovery record has no target key');
    return value;
  }

  rowIds(id: number): number[] {
    return [
      ...this.storage.sql.exec<{ row_id: number }>(
        'SELECT row_id FROM recovery_items WHERE recovery_id = ? ORDER BY row_id',
        id,
      ),
    ].map((row) => row.row_id);
  }

  resolve(id: number, resolution: string, reason: string): RecoveryRecord {
    return this.resolveWithMutation(id, resolution, reason, () => undefined);
  }

  resolveWithMutation(
    id: number,
    resolution: string,
    reason: string,
    mutate: () => void,
  ): RecoveryRecord {
    const record = this.getStored(id);
    if (record.state !== 'blocked') throw new Error('recovery record is not blocked');
    const validatedReason = requireRecoveryReason(reason);
    this.storage.transactionSync(() => {
      mutate();
      this.storage.sql.exec('DELETE FROM recovery_items WHERE recovery_id = ?', id);
      this.storage.sql.exec(
        `UPDATE recovery_records SET state = 'resolved', resolved_at_ms = ?, resolution = ?,
         resolution_reason = ? WHERE id = ?`,
        Date.now(),
        resolution,
        validatedReason,
        id,
      );
    });
    return this.get(id);
  }

  countBlockedRows(): number {
    return this.storage.sql
      .exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM recovery_items AS i
       JOIN recovery_records AS r ON r.id = i.recovery_id WHERE r.state = 'blocked'`,
      )
      .one().count;
  }

  countBlockedRecords(): number {
    return this.storage.sql
      .exec<{
        count: number;
      }>(`SELECT COUNT(*) AS count FROM recovery_records WHERE state = 'blocked'`)
      .one().count;
  }

  private insertRecord(
    kind: RecoveryKind,
    state: 'in_flight' | 'blocked',
    classification: RecoveryClassification | null,
    target: string | null,
    targetKey: string | null,
    payload: string,
    outcome: string,
    rowIds: number[],
    dedupeKey: string | null = null,
  ): number {
    let id = 0;
    this.storage.transactionSync(() => {
      this.storage.sql.exec(
        `INSERT INTO recovery_records
           (kind, state, classification, target, target_key, dedupe_key, payload, outcome, created_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        kind,
        state,
        classification,
        target,
        targetKey,
        dedupeKey,
        '',
        '',
        Date.now(),
      );
      id = this.storage.sql.exec<{ id: number }>('SELECT last_insert_rowid() AS id').one().id;
      for (const [index, chunk] of splitUtf8Chunks(payload, RECOVERY_CHUNK_BYTES).entries()) {
        this.storage.sql.exec(
          'INSERT INTO recovery_payload_chunks (recovery_id, chunk_index, data) VALUES (?, ?, ?)',
          id,
          index,
          chunk,
        );
      }
      for (const [index, chunk] of splitUtf8Chunks(outcome, RECOVERY_CHUNK_BYTES).entries()) {
        this.storage.sql.exec(
          'INSERT INTO recovery_outcome_chunks (recovery_id, chunk_index, data) VALUES (?, ?, ?)',
          id,
          index,
          chunk,
        );
      }
      for (const rowId of rowIds) {
        if (!targetKey) throw new Error('recovery row requires a target key');
        this.storage.sql.exec(
          'INSERT INTO recovery_items (recovery_id, row_id, target_key) VALUES (?, ?, ?)',
          id,
          rowId,
          targetKey,
        );
      }
    });
    return id;
  }

  private getStored(id: number): StoredRecoveryRecord {
    if (!Number.isSafeInteger(id) || id < 1) throw new Error('invalid recovery id');
    const row = [
      ...this.storage.sql.exec<StoredRecoveryRecord>(
        'SELECT * FROM recovery_records WHERE id = ?',
        id,
      ),
    ][0];
    if (!row) throw new Error('recovery record not found');
    return row;
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const existing = [
      ...this.storage.sql.exec<{ name: string }>(
        `SELECT name FROM pragma_table_info('${table}') WHERE name = ?`,
        column,
      ),
    ];
    if (existing.length === 0)
      this.storage.sql.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  private toRecoveryRecord(row: StoredRecoveryRecord): RecoveryRecord {
    if (row.state === 'in_flight' || row.classification === null)
      throw new Error('in-flight record is private');
    const chunks = [
      ...this.storage.sql.exec<{ data: string }>(
        'SELECT data FROM recovery_payload_chunks WHERE recovery_id = ? ORDER BY chunk_index',
        row.id,
      ),
    ];
    const outcomeChunks = [
      ...this.storage.sql.exec<{ data: string }>(
        'SELECT data FROM recovery_outcome_chunks WHERE recovery_id = ? ORDER BY chunk_index',
        row.id,
      ),
    ];
    return {
      id: row.id,
      kind: row.kind,
      state: row.state,
      classification: row.classification,
      target: row.target,
      payload: chunks.length > 0 ? chunks.map((chunk) => chunk.data).join('') : row.payload,
      outcome:
        outcomeChunks.length > 0 ? outcomeChunks.map((chunk) => chunk.data).join('') : row.outcome,
      createdAtMs: row.created_at_ms,
      resolvedAtMs: row.resolved_at_ms,
      resolution: row.resolution,
      resolutionReason: row.resolution_reason,
    };
  }
}

export function requireRecoveryReason(reason: string): string {
  const normalized = reason.trim();
  if (!normalized) throw new Error('recovery reason is required');
  return normalized;
}

export function serializeTinybirdFailure(error: unknown): string {
  if (!(error instanceof Error)) return JSON.stringify({ value: String(error) });
  const record = error as Error & { status?: unknown; reason?: unknown; responseText?: unknown };
  return JSON.stringify({
    name: error.name,
    message: error.message,
    status: typeof record.status === 'number' ? record.status : null,
    reason: typeof record.reason === 'string' ? record.reason : null,
    responseText: typeof record.responseText === 'string' ? record.responseText : null,
  });
}

function validateRecoveryPageOptions(options: RecoveryPageOptions): Required<RecoveryPageOptions> {
  const afterId = options.afterId ?? 0;
  const limit = options.limit ?? 50;
  const state = options.state ?? 'blocked';
  if (!Number.isSafeInteger(afterId) || afterId < 0)
    throw new Error('afterId must be a non-negative integer');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw new Error('limit must be between 1 and 100');
  if (state !== 'blocked' && state !== 'resolved') throw new Error('invalid recovery state');
  return { afterId, limit, state };
}

export function splitUtf8Chunks(value: string, maxBytes: number): string[] {
  if (new TextEncoder().encode(value).byteLength <= maxBytes) return [value];
  const chunks: string[] = [];
  let start = 0;
  while (start < value.length) {
    let low = start + 1;
    let high = Math.min(value.length, start + maxBytes);
    let end = low;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const candidate = value.slice(start, middle);
      if (new TextEncoder().encode(candidate).byteLength <= maxBytes) {
        end = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    if (end < value.length && isHighSurrogate(value.charCodeAt(end - 1))) end--;
    if (end <= start) throw new Error('could not split recovery payload');
    chunks.push(value.slice(start, end));
    start = end;
  }
  return chunks;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}
