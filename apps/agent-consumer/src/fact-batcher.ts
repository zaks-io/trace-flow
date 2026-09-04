import * as Sentry from '@sentry/cloudflare';
import { TRACE_FLOW_PROPAGATION_TARGETS } from '@trace-flow/utils/sentry-tracing';
import { DurableObject } from 'cloudflare:workers';
import { axiomConfigFromEnv, createLogger } from '@trace-flow/logging';
import {
  classifyTinybirdInsertFailure,
  insertRows,
  requireRecoveryReason,
  serializeTinybirdFailure,
  splitUtf8Chunks,
  TinybirdRecoveryStore,
  type ReconcileRecoveryInput,
  type RecoveryPage,
  type RecoveryPageOptions,
  type RecoveryRecord,
} from '@trace-flow/tinybird-client';
import type { AgentConsumerEnv } from './context';
import {
  CATEGORIES,
  DATASOURCES,
  LEGACY_CATEGORIES,
  LEGACY_DATASOURCES,
  ROW_IDENTITY_FIELDS,
  rowIdentity,
  stableHash,
  type Category,
} from './facts';

const BATCH_SIZE = 10_000;
const MAX_NDJSON_BYTES = 900_000;
// Agent dashboards do not need sub-minute ingest visibility; fewer larger inserts reduce part churn.
const FLUSH_INTERVAL_MS = 60_000;
const MAX_SQL_PARAMS = 90;
const MAX_INSERT_ROWS = Math.floor(MAX_SQL_PARAMS / 3);

export const AGENT_FACT_BATCHER_FLUSH_INTERVAL_MS = FLUSH_INTERVAL_MS;

type AddStatus = 'accepted' | 'failed';

interface AgentFactBatch {
  rows: Record<Category, unknown[]>;
  writeClean?: boolean;
  writeLegacy?: boolean;
}

interface AgentFactBatchResult {
  status: AddStatus;
  acceptedRows: number;
  duplicateRows: number;
  repairRows: number;
  blockedRecoveryRows: number;
  blockedRecoveryRecords: number;
}

export interface AgentFactBatcherStats {
  queuedRows: number;
  blockedRecoveryRows: number;
  blockedRecoveryRecords: number;
}

interface StoredFactRow {
  [key: string]: string | number;
  id: number;
  data: string;
}

class AgentFactBatcherBase extends DurableObject<AgentConsumerEnv> {
  private queuedRows = 0;
  private flushAlarmScheduled = false;
  private flushInProgress = false;
  private recovery: TinybirdRecoveryStore;
  private logger = createLogger({
    service: 'agent-consumer',
    runtime: 'durable-object',
    axiom: axiomConfigFromEnv(this.env),
    context: { component: 'agent-fact-batcher' },
  });

  constructor(state: DurableObjectState, env: AgentConsumerEnv) {
    super(state, env);
    this.recovery = new TinybirdRecoveryStore(state.storage);
    void this.ctx.blockConcurrencyWhile(async () => {
      this.initializeSchema();
      this.queuedRows = this.countPendingRows();
      if (this.queuedRows > 0) {
        await this.ctx.storage.setAlarm(Date.now() + 1000);
        this.flushAlarmScheduled = true;
      }
    });
  }

  async addFacts(batch: AgentFactBatch): Promise<AgentFactBatchResult> {
    let acceptedRows = 0;
    let duplicateRows = 0;
    let repairRows = 0;
    const repairs: { payload: string; outcome: string; dedupeKey: string }[] = [];
    const now = Date.now();

    try {
      validateWriteTargets(batch);
      this.ctx.storage.transactionSync(() => {
        for (const category of CATEGORIES) {
          for (const row of batch.rows[category]) {
            const factId = rowIdentity(row, ROW_IDENTITY_FIELDS[category]);
            const contentHash = stableHash(row);
            const existing = [
              ...this.ctx.storage.sql.exec<{ content_hash: string; data: string | null }>(
                'SELECT content_hash, data FROM fact_ledger WHERE category = ? AND fact_id = ?',
                category,
                factId,
              ),
            ][0];

            if (existing?.content_hash === contentHash) {
              duplicateRows++;
              continue;
            }

            if (existing) {
              repairRows++;
              const changedData = JSON.stringify(row);
              const priorRepair = [
                ...this.ctx.storage.sql.exec<{ id: number }>(
                  `SELECT id FROM fact_repairs
                 WHERE category = ? AND fact_id = ? AND old_hash = ? AND new_hash = ? LIMIT 1`,
                  category,
                  factId,
                  existing.content_hash,
                  contentHash,
                ),
              ][0];
              if (!priorRepair) {
                this.ctx.storage.sql.exec(
                  `INSERT INTO fact_repairs (category, fact_id, old_hash, new_hash, seen_at_ms, data)
                   VALUES (?, ?, ?, ?, ?, ?)`,
                  category,
                  factId,
                  existing.content_hash,
                  contentHash,
                  now,
                  inlinePayload(changedData),
                );
              }
              repairs.push({
                payload: changedData,
                outcome: JSON.stringify({
                  category,
                  factId,
                  oldHash: existing.content_hash,
                  newHash: contentHash,
                  originalPayload: existing.data,
                }),
                dedupeKey: JSON.stringify([category, factId, existing.content_hash, contentHash]),
              });
              continue;
            }

            const rowData = JSON.stringify(row);
            this.ctx.storage.sql.exec(
              `INSERT INTO fact_ledger (category, fact_id, content_hash, first_seen_at_ms, data)
               VALUES (?, ?, ?, ?, ?)`,
              category,
              factId,
              contentHash,
              now,
              inlinePayload(rowData),
            );
            if (batch.writeClean !== false) {
              this.insertPendingFact('pending_facts', category, rowData, now);
            }
            // Only mirror categories that have a legacy datasource. review_unit_attributions has
            // no legacy table, so a dual-mode row here would never be drained by flush() and would
            // wedge the pending count (and thus the flush alarm) forever.
            if (batch.writeLegacy && (LEGACY_CATEGORIES as Category[]).includes(category)) {
              this.insertPendingFact('legacy_pending_facts', category, rowData, now);
            }
            acceptedRows++;
          }
        }
      });

      for (const repair of repairs) {
        this.recovery.preserveRepair(repair.payload, repair.outcome, repair.dedupeKey);
      }

      this.queuedRows = this.countPendingRows();
      if (repairRows > 0) {
        this.logger.warn('agent_fact_batcher.repair_rows_detected', { repairRows });
      }

      if (this.queuedRows >= BATCH_SIZE) {
        await this.flush();
      } else if (this.queuedRows > 0) {
        await this.scheduleFlush();
      }

      return {
        status: 'accepted',
        acceptedRows,
        duplicateRows,
        repairRows,
        blockedRecoveryRows: this.recovery.countBlockedRows(),
        blockedRecoveryRecords: this.recovery.countBlockedRecords(),
      };
    } catch (error) {
      this.logger.error('agent_fact_batcher.add_failed', error);
      Sentry.captureException(error, { tags: { operation: 'agent_fact_batcher.add' } });
      return {
        status: 'failed',
        acceptedRows,
        duplicateRows,
        repairRows,
        blockedRecoveryRows: this.recovery.countBlockedRows(),
        blockedRecoveryRecords: this.recovery.countBlockedRecords(),
      };
    } finally {
      await this.logger.flush();
    }
  }

  async alarm(): Promise<void> {
    this.flushAlarmScheduled = false;
    await this.flush();
  }

  private initializeSchema(): void {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS fact_ledger (
        category TEXT NOT NULL,
        fact_id TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        first_seen_at_ms INTEGER NOT NULL,
        data TEXT,
        PRIMARY KEY (category, fact_id)
      )
    `);
    this.ensureColumn('fact_ledger', 'data', 'TEXT');
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS fact_repairs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        category TEXT NOT NULL,
        fact_id TEXT NOT NULL,
        old_hash TEXT NOT NULL,
        new_hash TEXT NOT NULL,
        seen_at_ms INTEGER NOT NULL,
        data TEXT
      )
    `);
    this.ensureColumn('fact_repairs', 'data', 'TEXT');
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS pending_facts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        category TEXT NOT NULL,
        data TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        sent_at_ms INTEGER
      )
    `);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS legacy_pending_facts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        category TEXT NOT NULL,
        data TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        sent_at_ms INTEGER
      )
    `);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS fact_payload_chunks (
        table_name TEXT NOT NULL,
        row_id INTEGER NOT NULL,
        chunk_index INTEGER NOT NULL,
        data TEXT NOT NULL,
        PRIMARY KEY (table_name, row_id, chunk_index)
      )
    `);
    this.ensureColumn('pending_facts', 'sent_at_ms', 'INTEGER');
    this.ensureColumn('legacy_pending_facts', 'sent_at_ms', 'INTEGER');
    this.ctx.storage.sql.exec(
      'CREATE INDEX IF NOT EXISTS idx_pending_facts_category_id ON pending_facts(category, id)',
    );
    this.ctx.storage.sql.exec(
      'CREATE INDEX IF NOT EXISTS idx_legacy_pending_facts_category_id ON legacy_pending_facts(category, id)',
    );
    this.recovery.initialize();
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const existing = [
      ...this.ctx.storage.sql.exec<{ name: string }>(
        `SELECT name FROM pragma_table_info('${table}') WHERE name = ?`,
        column,
      ),
    ];
    if (existing.length === 0) {
      this.ctx.storage.sql.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }

  private insertPendingFact(
    table: 'pending_facts' | 'legacy_pending_facts',
    category: Category,
    data: string,
    createdAtMs: number,
  ): void {
    const oversized = new TextEncoder().encode(data).byteLength > MAX_NDJSON_BYTES;
    this.ctx.storage.sql.exec(
      `INSERT INTO ${table} (category, data, created_at_ms) VALUES (?, ?, ?)`,
      category,
      oversized ? '' : data,
      createdAtMs,
    );
    if (!oversized) return;
    const rowId = this.ctx.storage.sql
      .exec<{ id: number }>('SELECT last_insert_rowid() AS id')
      .one().id;
    for (const [index, chunk] of splitUtf8Chunks(data, MAX_NDJSON_BYTES).entries()) {
      this.ctx.storage.sql.exec(
        `INSERT INTO fact_payload_chunks (table_name, row_id, chunk_index, data) VALUES (?, ?, ?, ?)`,
        table,
        rowId,
        index,
        chunk,
      );
    }
  }

  private countPendingRows(): number {
    return (
      this.countTablePendingRows('pending_facts') +
      this.countTablePendingRows('legacy_pending_facts')
    );
  }

  private countTablePendingRows(table: 'pending_facts' | 'legacy_pending_facts'): number {
    return (
      [
        ...this.ctx.storage.sql.exec<{ count: number }>(
          `SELECT COUNT(*) AS count FROM ${table} AS p
           WHERE sent_at_ms IS NULL AND NOT EXISTS (
             SELECT 1 FROM recovery_items AS i JOIN recovery_records AS r ON r.id = i.recovery_id
             WHERE i.row_id = p.id AND i.target_key = ? || ':' || p.category
               AND r.state IN ('in_flight', 'blocked')
           )`,
          table,
        ),
      ][0]?.count ?? 0
    );
  }

  private async scheduleFlush(): Promise<void> {
    if (this.flushAlarmScheduled) {
      return;
    }
    await this.ctx.storage.setAlarm(Date.now() + FLUSH_INTERVAL_MS);
    this.flushAlarmScheduled = true;
  }

  private async flush(): Promise<void> {
    if (this.flushInProgress || this.queuedRows === 0) {
      return;
    }

    this.flushInProgress = true;
    try {
      for (const category of CATEGORIES) {
        await this.flushCategory('pending_facts', DATASOURCES[category], category);
      }
      for (const category of LEGACY_CATEGORIES) {
        await this.flushCategory('legacy_pending_facts', LEGACY_DATASOURCES[category], category);
      }
    } finally {
      this.queuedRows = this.countPendingRows();
      this.flushInProgress = false;
      if (this.queuedRows > 0) {
        await this.scheduleFlush();
      }
      await this.logger.flush();
    }
  }

  private async flushCategory(
    table: 'pending_facts' | 'legacy_pending_facts',
    datasource: string,
    category: Category,
  ): Promise<void> {
    this.deleteSentFacts(table, category);

    const targetKey = `${table}:${category}`;
    const rows = [
      ...this.ctx.storage.sql.exec<StoredFactRow>(
        `SELECT id, data
         FROM ${table} AS p
         WHERE category = ? AND sent_at_ms IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM recovery_items AS i JOIN recovery_records AS r ON r.id = i.recovery_id
             WHERE i.row_id = p.id AND i.target_key = ? AND r.state IN ('in_flight', 'blocked')
           )
         ORDER BY id
         LIMIT ?`,
        category,
        targetKey,
        BATCH_SIZE,
      ),
    ].map((row) => ({ ...row, data: this.loadFactData(table, row.id, row.data) }));
    for (const batch of splitRowsByBytes(rows)) {
      await this.sendFactBatch(table, datasource, category, targetKey, batch);
    }
    this.deleteSentFacts(table, category);
  }

  private async sendFactBatch(
    table: 'pending_facts' | 'legacy_pending_facts',
    datasource: string,
    category: Category,
    targetKey: string,
    rows: StoredFactRow[],
  ): Promise<void> {
    if (rows.length === 0) return;
    const rowIds = rows.map((row) => row.id);
    let facts: unknown[];
    try {
      facts = rows.map((row) => normalizePendingFact(category, JSON.parse(row.data)));
    } catch (error) {
      if (rows.length > 1) {
        const middle = Math.ceil(rows.length / 2);
        await this.sendFactBatch(table, datasource, category, targetKey, rows.slice(0, middle));
        await this.sendFactBatch(table, datasource, category, targetKey, rows.slice(middle));
        return;
      }
      this.recovery.preserveInsert(
        datasource,
        targetKey,
        `[${rows[0]?.data ?? ''}]`,
        rowIds,
        'rejected',
        serializeTinybirdFailure(error),
      );
      return;
    }

    const payload = JSON.stringify(facts);
    if (new TextEncoder().encode(payload).byteLength > MAX_NDJSON_BYTES) {
      if (rows.length > 1) {
        const middle = Math.ceil(rows.length / 2);
        await this.sendFactBatch(table, datasource, category, targetKey, rows.slice(0, middle));
        await this.sendFactBatch(table, datasource, category, targetKey, rows.slice(middle));
        return;
      }
      this.recovery.preserveInsert(
        datasource,
        targetKey,
        payload,
        rowIds,
        'rejected',
        JSON.stringify({ reason: 'row_too_large' }),
      );
      return;
    }

    const recoveryId = this.recovery.beginInsert(datasource, targetKey, payload, rowIds);
    try {
      await insertRows(facts, this.env.TINYBIRD_TOKEN, datasource, this.env.TINYBIRD_HOST);
      this.markFactsSent(table, rowIds);
      this.recovery.discardIntent(recoveryId);
    } catch (error) {
      const classification = classifyTinybirdInsertFailure(error);
      if (classification === 'retryable') {
        this.recovery.discardIntent(recoveryId);
        throw error;
      }
      if (isPayloadTooLarge(error) && rows.length > 1) {
        this.recovery.discardIntent(recoveryId);
        const middle = Math.ceil(rows.length / 2);
        await this.sendFactBatch(table, datasource, category, targetKey, rows.slice(0, middle));
        await this.sendFactBatch(table, datasource, category, targetKey, rows.slice(middle));
        return;
      }
      this.recovery.blockInsert(recoveryId, classification, serializeTinybirdFailure(error));
      const sanitizedError = new Error(
        error instanceof Error ? error.message : 'Tinybird insert failed',
      );
      this.logger.error('agent_fact_batcher.tinybird_insert_blocked', sanitizedError, {
        datasource,
        classification,
        rowCount: rows.length,
      });
      Sentry.captureException(sanitizedError, {
        tags: { operation: 'agent_fact_insert', classification },
      });
    }
  }

  private markFactsSent(table: 'pending_facts' | 'legacy_pending_facts', ids: number[]): void {
    this.ctx.storage.transactionSync(() => this.markFactsSentSync(table, ids));
  }

  private loadFactData(
    table: 'pending_facts' | 'legacy_pending_facts',
    rowId: number,
    fallback: string,
  ): string {
    if (fallback.length > 0) return fallback;
    const chunks = [
      ...this.ctx.storage.sql.exec<{ data: string }>(
        `SELECT data FROM fact_payload_chunks WHERE table_name = ? AND row_id = ? ORDER BY chunk_index`,
        table,
        rowId,
      ),
    ];
    if (chunks.length === 0) throw new Error(`fact ${table}:${rowId} has no payload`);
    return chunks.map((chunk) => chunk.data).join('');
  }

  private markFactsSentSync(table: 'pending_facts' | 'legacy_pending_facts', ids: number[]): void {
    const sentAt = Date.now();
    for (let i = 0; i < ids.length; i += MAX_INSERT_ROWS) {
      const chunk = ids.slice(i, i + MAX_INSERT_ROWS);
      this.ctx.storage.sql.exec(
        `UPDATE ${table} SET sent_at_ms = ? WHERE id IN (${chunk.map(() => '?').join(',')})`,
        sentAt,
        ...chunk,
      );
    }
  }

  private deleteSentFacts(
    table: 'pending_facts' | 'legacy_pending_facts',
    category: Category,
  ): void {
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        `DELETE FROM fact_payload_chunks WHERE table_name = ? AND row_id IN (
           SELECT id FROM ${table} WHERE category = ? AND sent_at_ms IS NOT NULL
         )`,
        table,
        category,
      );
      this.ctx.storage.sql.exec(
        `DELETE FROM ${table} WHERE category = ? AND sent_at_ms IS NOT NULL`,
        category,
      );
    });
  }

  getStats(): AgentFactBatcherStats {
    return {
      queuedRows: this.queuedRows,
      blockedRecoveryRows: this.recovery.countBlockedRows(),
      blockedRecoveryRecords: this.recovery.countBlockedRecords(),
    };
  }

  listRecovery(options: RecoveryPageOptions = {}): RecoveryPage {
    return this.recovery.list(options);
  }

  getRecovery(recoveryId: number): RecoveryRecord {
    return this.recovery.get(recoveryId);
  }

  async reconcileRecovery(input: ReconcileRecoveryInput): Promise<RecoveryRecord> {
    if (!['confirm-written', 'confirm-not-written', 'retain-original'].includes(input.action)) {
      throw new Error('invalid recovery action');
    }
    requireRecoveryReason(input.reason);
    const record = this.recovery.get(input.recoveryId);
    if (record.state !== 'blocked') throw new Error('recovery record is not blocked');
    if (record.kind === 'repair') {
      if (input.action !== 'retain-original')
        throw new Error('repair records can only retain-original');
      return this.recovery.resolve(record.id, input.action, input.reason);
    }
    if (record.kind !== 'tinybird_insert') throw new Error('DLQ records must use replayDlq');
    if (input.action === 'retain-original')
      throw new Error('insert recovery requires a write confirmation');
    const target = parseFactTargetKey(this.recovery.getTargetKey(record.id));
    const ids = this.recovery.rowIds(record.id);
    if (input.action === 'confirm-not-written') {
      await this.ctx.storage.setAlarm(Date.now() + 1000);
      this.flushAlarmScheduled = true;
    }
    const resolved = this.recovery.resolveWithMutation(
      record.id,
      input.action,
      input.reason,
      () => {
        if (input.action === 'confirm-written') this.markFactsSentSync(target.table, ids);
      },
    );
    if (input.action === 'confirm-written') this.deleteSentFacts(target.table, target.category);
    this.queuedRows = this.countPendingRows();
    return resolved;
  }

  preserveDlq(payload: string, outcome: string, dedupeKey: string): RecoveryRecord {
    return this.recovery.preserveDlq(payload, outcome, dedupeKey);
  }

  resolveDlq(recoveryId: number, reason: string): RecoveryRecord {
    const record = this.recovery.get(recoveryId);
    if (record.kind !== 'dlq') throw new Error('recovery record is not a DLQ message');
    return this.recovery.resolve(recoveryId, 'replayed', reason);
  }
}

function splitRowsByBytes(rows: StoredFactRow[]): StoredFactRow[][] {
  const batches: StoredFactRow[][] = [];
  let current: StoredFactRow[] = [];
  let bytes = 0;
  for (const row of rows) {
    const rowBytes = new TextEncoder().encode(row.data).byteLength + (current.length > 0 ? 1 : 0);
    if (current.length > 0 && bytes + rowBytes > MAX_NDJSON_BYTES) {
      batches.push(current);
      current = [];
      bytes = 0;
    }
    current.push(row);
    bytes += rowBytes;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

function inlinePayload(value: string): string {
  return new TextEncoder().encode(value).byteLength <= MAX_NDJSON_BYTES ? value : '';
}

function isPayloadTooLarge(error: unknown): boolean {
  return error instanceof Error && (error as Error & { status?: unknown }).status === 413;
}

function parseFactTargetKey(value: string): {
  table: 'pending_facts' | 'legacy_pending_facts';
  category: Category;
} {
  const [table, category, extra] = value.split(':');
  if (extra || (table !== 'pending_facts' && table !== 'legacy_pending_facts')) {
    throw new Error('invalid fact recovery target');
  }
  if (!(CATEGORIES as readonly string[]).includes(category ?? '')) {
    throw new Error('invalid fact recovery category');
  }
  return { table, category: category as Category };
}

function normalizePendingFact(category: Category, row: unknown): unknown {
  if (category !== 'tool_events' || !isRecord(row)) {
    return row;
  }

  return {
    ...row,
    error_category: row.error_category ?? 'unknown',
    error_category_coverage:
      row.error_category_coverage ?? (row.status === 'failure' ? 'unknown' : 'not_applicable'),
    is_navigation: row.is_navigation ?? 0,
    navigation_kind: row.navigation_kind ?? 'none',
    navigation_hint_coverage: row.navigation_hint_coverage ?? 'unknown',
    navigation_path_hint: row.navigation_path_hint ?? '',
    navigation_pattern_hint: row.navigation_pattern_hint ?? '',
  };
}

function validateWriteTargets(batch: AgentFactBatch): void {
  const writesClean = batch.writeClean !== false;
  const writesLegacy = batch.writeLegacy === true;
  for (const category of CATEGORIES) {
    if (batch.rows[category].length === 0) continue;
    if (writesClean || (writesLegacy && (LEGACY_CATEGORIES as Category[]).includes(category))) {
      continue;
    }
    throw new Error(`no Tinybird write target for ${category}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export const AgentFactBatcher = Sentry.instrumentDurableObjectWithSentry(
  (env: AgentConsumerEnv) => ({
    dsn: env.SENTRY_DSN,
    release: env.CF_VERSION_METADATA?.id,
    environment: env.SENTRY_ENVIRONMENT ?? 'development',
    tracesSampleRate: 1.0,
    tracePropagationTargets: TRACE_FLOW_PROPAGATION_TARGETS,
    // Must match the calling Worker: the stub appends a trailing metadata argument that only an
    // RPC-instrumented Durable Object strips back off before the method sees its args.
    enableRpcTracePropagation: true,
  }),
  AgentFactBatcherBase,
);

export type AgentFactBatcherInstance = InstanceType<typeof AgentFactBatcher>;
