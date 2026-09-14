import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, openSync, readSync, statfsSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import type { RecoveryRecord } from '../../packages/tinybird-client/src/recovery';
import {
  validateReconcileFrozenRepairInput,
  type ReconcileFrozenRepairInput,
} from '../../apps/agent-consumer/src/frozen-repair-reconciliation-contract';
import { syncDirectory } from './agent-executor';

const MIN_FREE_BYTES = 1024 ** 3;
const MAX_BATCH_BYTES = 120 * 1024;
const MAX_RECORD_BATCH_BYTES = 4_000_000;

export interface FrozenRepairJournalFence {
  orgId: string;
  migrationProofSha256: string;
  deliverySequence: number;
  oldestDay: string;
  todayDay: string;
  fullVerificationSha256: string;
}

export interface FrozenRepairStorageMeasurement {
  databaseSizeBeforeBytes: number;
  databaseSizeAfterBytes: number;
  releasedRecoveryBytes: number;
  hydratedRepairBytes: number;
  tombstoneBytes: number;
}

export class FrozenRepairReconciliationJournal {
  readonly db: Database;

  constructor(
    private readonly path: string,
    private readonly fence: FrozenRepairJournalFence,
  ) {
    assertDiskSpace(path);
    const create = !existsSync(path);
    if (create) {
      closeSync(openSync(path, 'wx', 0o600));
      syncDirectory(dirname(path));
    } else {
      assertExistingJournal(path);
    }
    this.db = new Database(path, { create: true, strict: true });
    if (create) this.initialize();
    this.assertMetadata();
    this.assertOperationalMetadata();
  }

  close(): void {
    this.db.close();
  }

  get complete(): boolean {
    return this.meta('complete') === 'true';
  }

  get afterId(): number {
    const value = Number(this.meta('after_id'));
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid repair journal cursor');
    return value;
  }

  appendPage(
    entries: Array<{ record: RecoveryRecord; proof: ReconcileFrozenRepairInput }>,
    nextAfterId: number | null,
  ): void {
    if (this.complete) throw new Error('Frozen repair journal inventory is already complete');
    const afterId = this.afterId;
    let priorId = afterId;
    const rows = entries.map(({ record, proof }) => {
      const validated = validateReconcileFrozenRepairInput(proof);
      if (record.id !== validated.recoveryId || record.id <= priorId) {
        throw new Error('Frozen repair journal page is out of order');
      }
      priorId = record.id;
      const recordJson = JSON.stringify(record);
      const proofJson = JSON.stringify(validated);
      return {
        id: record.id,
        disposition: validated.disposition,
        recordJson,
        recordSha256: sha256(recordJson),
        proofJson,
        proofSha256: sha256(proofJson),
      };
    });
    if (
      nextAfterId !== null &&
      (rows.length === 0 || nextAfterId !== rows.at(-1)!.id || nextAfterId <= afterId)
    ) {
      throw new Error('Frozen repair journal page has an invalid cursor');
    }
    assertDiskSpace(
      this.path,
      rows.reduce(
        (bytes, row) =>
          bytes + Buffer.byteLength(row.recordJson) + Buffer.byteLength(row.proofJson),
        0,
      ),
    );
    this.db.transaction(() => {
      for (const row of rows) {
        this.db
          .query(
            `INSERT INTO repairs
             (recovery_id,disposition,record_json,record_sha256,proof_json,proof_sha256,status)
             VALUES (?,?,?,?,?,?,'pending')`,
          )
          .run(
            row.id,
            row.disposition,
            row.recordJson,
            row.recordSha256,
            row.proofJson,
            row.proofSha256,
          );
      }
      this.setMeta('after_id', String(rows.at(-1)?.id ?? afterId));
      if (nextAfterId === null) {
        this.setMeta('record_count', String(this.count()));
        this.setMeta('complete', 'true');
      }
    })();
  }

  assertReadyToMutate(): void {
    if (!this.complete) throw new Error('Frozen repair journal inventory is incomplete');
    this.assertOperationalMetadata();
    const integrity = this.db.query<{ quick_check: string }, []>('PRAGMA quick_check').get();
    if (integrity?.quick_check !== 'ok') throw new Error('Frozen repair journal is corrupt');
    let checked = 0;
    for (const row of this.db
      .query<
        {
          recovery_id: number;
          disposition: string;
          record_json: string;
          record_sha256: string;
          proof_json: string;
          proof_sha256: string;
          status: string;
        },
        []
      >('SELECT * FROM repairs ORDER BY recovery_id')
      .iterate()) {
      validateJournalRow(row);
      checked++;
    }
    if (String(checked) !== this.meta('record_count')) {
      throw new Error('Frozen repair journal record count changed');
    }
    assertDiskSpace(this.path);
  }

  nextPendingBatch(): ReconcileFrozenRepairInput[] {
    const proofs: ReconcileFrozenRepairInput[] = [];
    let recordBytes = 0;
    for (const row of this.db
      .query<
        {
          recovery_id: number;
          record_bytes: number;
          proof_json: string;
          proof_sha256: string;
        },
        []
      >(
        `SELECT recovery_id,length(CAST(record_json AS BLOB)) AS record_bytes,
                proof_json,proof_sha256
         FROM repairs WHERE status='pending' ORDER BY recovery_id LIMIT 100`,
      )
      .all()) {
      if (sha256(row.proof_json) !== row.proof_sha256) {
        throw new Error(`Frozen repair journal proof ${row.recovery_id} is corrupt`);
      }
      const proof = validateReconcileFrozenRepairInput(JSON.parse(row.proof_json));
      const candidate = [...proofs, proof];
      if (
        proofs.length > 0 &&
        (Buffer.byteLength(JSON.stringify({ repairs: candidate })) > MAX_BATCH_BYTES ||
          recordBytes + row.record_bytes > MAX_RECORD_BATCH_BYTES)
      ) {
        break;
      }
      proofs.push(proof);
      recordBytes += row.record_bytes;
    }
    if (
      proofs.length > 0 &&
      (Buffer.byteLength(JSON.stringify({ repairs: proofs })) > MAX_BATCH_BYTES ||
        recordBytes > MAX_RECORD_BATCH_BYTES)
    ) {
      throw new Error(`Frozen repair ${proofs[0]!.recoveryId} record or proof exceeds its bound`);
    }
    return proofs;
  }

  confirm(proofs: ReconcileFrozenRepairInput[], storage: FrozenRepairStorageMeasurement): void {
    validateStorageMeasurement(storage);
    this.db.transaction(() => {
      for (const proof of proofs) {
        const changed = this.db
          .query(
            "UPDATE repairs SET status='confirmed' WHERE recovery_id=? AND proof_sha256=? AND status='pending'",
          )
          .run(proof.recoveryId, sha256(JSON.stringify(proof))).changes;
        if (changed !== 1) throw new Error('Frozen repair journal confirmation does not match');
      }
      if (!this.meta('database_size_before_bytes')) {
        this.setMeta('database_size_before_bytes', String(storage.databaseSizeBeforeBytes));
      }
      this.setMeta('database_size_after_bytes', String(storage.databaseSizeAfterBytes));
      this.incrementMeta('batches', 1);
      this.incrementMeta('released_recovery_bytes', storage.releasedRecoveryBytes);
      this.incrementMeta('hydrated_repair_bytes', storage.hydratedRepairBytes);
      this.incrementMeta('tombstone_bytes', storage.tombstoneBytes);
    })();
  }

  report(): {
    total: number;
    exact: number;
    superseded: number;
    expired: number;
    storage: {
      batches: number;
      databaseSizeBeforeBytes: number | null;
      databaseSizeAfterBytes: number | null;
      releasedRecoveryBytes: number;
      hydratedRepairBytes: number;
      tombstoneBytes: number;
    };
  } {
    const report = { total: 0, exact: 0, superseded: 0, expired: 0 };
    for (const row of this.db
      .query<
        { disposition: 'exact' | 'superseded' | 'expired'; count: number },
        []
      >('SELECT disposition,count(*) AS count FROM repairs GROUP BY disposition')
      .all()) {
      report[row.disposition] = Number(row.count);
      report.total += Number(row.count);
    }
    return {
      ...report,
      storage: {
        batches: Number(this.meta('batches')),
        databaseSizeBeforeBytes: optionalNumber(this.meta('database_size_before_bytes')),
        databaseSizeAfterBytes: optionalNumber(this.meta('database_size_after_bytes')),
        releasedRecoveryBytes: Number(this.meta('released_recovery_bytes')),
        hydratedRepairBytes: Number(this.meta('hydrated_repair_bytes')),
        tombstoneBytes: Number(this.meta('tombstone_bytes')),
      },
    };
  }

  private initialize(): void {
    this.db.exec(`
      PRAGMA journal_mode=DELETE;
      PRAGMA synchronous=FULL;
      CREATE TABLE metadata(key TEXT PRIMARY KEY,data TEXT NOT NULL);
      CREATE TABLE repairs(
        recovery_id INTEGER PRIMARY KEY,disposition TEXT NOT NULL,record_json TEXT NOT NULL,
        record_sha256 TEXT NOT NULL,proof_json TEXT NOT NULL,proof_sha256 TEXT NOT NULL,
        status TEXT NOT NULL
      );
    `);
    for (const [key, data] of Object.entries(this.fence)) this.setMeta(key, String(data));
    this.setMeta('after_id', '0');
    this.setMeta('complete', 'false');
    this.setMeta('batches', '0');
    this.setMeta('released_recovery_bytes', '0');
    this.setMeta('hydrated_repair_bytes', '0');
    this.setMeta('tombstone_bytes', '0');
  }

  private assertMetadata(): void {
    for (const [key, data] of Object.entries(this.fence)) {
      if (this.meta(key) !== String(data)) {
        throw new Error('Frozen repair journal belongs to another verification fence');
      }
    }
  }

  private assertOperationalMetadata(): void {
    const complete = this.meta('complete');
    if (complete !== 'true' && complete !== 'false') {
      throw new Error('Frozen repair journal completion state is corrupt');
    }
    void this.afterId;
    for (const key of [
      'batches',
      'released_recovery_bytes',
      'hydrated_repair_bytes',
      'tombstone_bytes',
    ]) {
      requireNonnegativeSafeInteger(this.meta(key), key);
    }
    const before = optionalSafeInteger(this.meta('database_size_before_bytes'));
    const after = optionalSafeInteger(this.meta('database_size_after_bytes'));
    if ((before === null) !== (after === null) || (before !== null && after! > before)) {
      throw new Error('Frozen repair journal storage measurements are corrupt');
    }
  }

  private count(): number {
    return Number(
      this.db.query<{ count: number }, []>('SELECT count(*) AS count FROM repairs').get()?.count,
    );
  }

  private meta(key: string): string | undefined {
    return this.db
      .query<{ data: string }, [string]>('SELECT data FROM metadata WHERE key=?')
      .get(key)?.data;
  }

  private setMeta(key: string, data: string): void {
    this.db.query('INSERT OR REPLACE INTO metadata VALUES(?,?)').run(key, data);
  }

  private incrementMeta(key: string, value: number): void {
    this.setMeta(key, String(Number(this.meta(key)) + value));
  }
}

function validateJournalRow(row: {
  recovery_id: number;
  disposition: string;
  record_json: string;
  record_sha256: string;
  proof_json: string;
  proof_sha256: string;
  status: string;
}): void {
  if (
    sha256(row.record_json) !== row.record_sha256 ||
    sha256(row.proof_json) !== row.proof_sha256 ||
    !['pending', 'confirmed'].includes(row.status)
  ) {
    throw new Error(`Frozen repair journal record ${row.recovery_id} is corrupt`);
  }
  const record = JSON.parse(row.record_json) as RecoveryRecord;
  const proof = validateReconcileFrozenRepairInput(JSON.parse(row.proof_json));
  if (
    record.id !== row.recovery_id ||
    proof.recoveryId !== row.recovery_id ||
    proof.disposition !== row.disposition ||
    sha256(record.payload) !== proof.expectedPayloadSha256 ||
    sha256(record.outcome) !== proof.expectedOutcomeSha256
  ) {
    throw new Error(`Frozen repair journal record ${row.recovery_id} does not match its proof`);
  }
}

function assertDiskSpace(path: string, additionalBytes = 0): void {
  const stats = statfsSync(dirname(path));
  const available = Number(stats.bavail) * Number(stats.bsize);
  if (!Number.isSafeInteger(available) || available - additionalBytes < MIN_FREE_BYTES) {
    throw new Error('Frozen repair journal needs at least 1 GiB of free disk space');
  }
}

function assertExistingJournal(path: string): void {
  const details = statSync(path);
  if ((details.mode & 0o077) !== 0) {
    throw new Error('Frozen repair journal must have 0600 permissions');
  }
  if (details.size < 16) throw new Error('Refusing to overwrite a non-journal file');
  const header = Buffer.alloc(16);
  const descriptor = openSync(path, 'r');
  try {
    readSync(descriptor, header, 0, header.length, 0);
  } finally {
    closeSync(descriptor);
  }
  if (header.toString('utf8') !== 'SQLite format 3\u0000') {
    throw new Error('Refusing to overwrite a non-journal file');
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function optionalNumber(value: string | undefined): number | null {
  return value === undefined ? null : Number(value);
}

function validateStorageMeasurement(storage: FrozenRepairStorageMeasurement): void {
  for (const [key, value] of Object.entries(storage)) {
    requireNonnegativeSafeInteger(String(value), key);
  }
  if (storage.databaseSizeAfterBytes > storage.databaseSizeBeforeBytes) {
    throw new Error('Frozen repair journal storage measurement grew');
  }
}

function requireNonnegativeSafeInteger(value: string | undefined, key: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Frozen repair journal metadata ${key} is corrupt`);
  }
  return parsed;
}

function optionalSafeInteger(value: string | undefined): number | null {
  return value === undefined ? null : requireNonnegativeSafeInteger(value, 'storage measurement');
}
