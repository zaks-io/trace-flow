import { sentryRequestPrivacy } from '@trace-flow/utils/sentry-tracing';
import * as Sentry from '@sentry/cloudflare';
import { normalizeAnalyticsKey } from '@trace-flow/utils';
import {
  durableSentryTraceHeader,
  captureSafeException,
  sentryTraceLinks,
  TRACE_FLOW_PROPAGATION_TARGETS,
} from '@trace-flow/utils/sentry-tracing';
import { DurableObject } from 'cloudflare:workers';
import { axiomConfigFromEnv, createLogger } from '@trace-flow/logging';
import type { OTLPQueueMessage, TinybirdTrace } from '@trace-flow/types';
import {
  classifyTinybirdInsertFailure,
  describeTinybirdInsertFailure,
  requireReconcileAction,
  requireRecoveryReason,
  serializeTinybirdFailure,
  splitUtf8Chunks,
  TinybirdRecoveryStore,
  type ReconcileRecoveryInput,
  type RecoveryPage,
  type RecoveryPageOptions,
  type RecoveryRecord,
} from '@trace-flow/tinybird-client';
import type { Env } from './index';
import { insertIntoTinybirdWithRetry } from './tinybird';
import { traceLedgerEntry } from './ledger';

const BATCH_SIZE = 10_000;
const MAX_NDJSON_BYTES = 900_000;
// Dashboard freshness tolerates minute-level latency; sparse traffic should batch for ClickHouse.
const FLUSH_INTERVAL_MS = 60_000;
const MAX_JITTER_MS = 1000;
// Threshold for emitting a Sentry alert when a shard has been unable to flush.
// One hour gives enough headroom that a transient Tinybird outage doesn't page,
// but catches the silent-bake scenario (shard 7 went 51 days unnoticed).
const STALE_FLUSH_THRESHOLD_MS = 60 * 60 * 1000;
// Cloudflare DO SQLite limits bind params; stay well under the limit
const MAX_SQL_PARAMS = 90;
// Include durable producer context without exceeding SQLite's bind limit.
const MAX_INSERT_ROWS = Math.floor(MAX_SQL_PARAMS / 3);

export const TRACE_BATCHER_BATCH_SIZE = BATCH_SIZE;
export const TRACE_BATCHER_FLUSH_INTERVAL_MS = FLUSH_INTERVAL_MS;
export const TRACE_BATCHER_MAX_JITTER_MS = MAX_JITTER_MS;
export const TRACE_BATCHER_MAX_INSERT_ROWS = MAX_INSERT_ROWS;

type MessageTraceStatus = 'inserted' | 'duplicate' | 'failed';

interface TraceInsertSummary {
  messageInserted: boolean;
  queuedTraces: number;
  duplicateTraces: number;
  repairTraces: number;
}

interface StoredTraceRow {
  [key: string]: string | number | null;
  id: number;
  data: string;
  clean_sent_at_ms: number | null;
  legacy_sent_at_ms: number | null;
  producer_sentry_trace: string | null;
}

interface TinybirdTraceTarget {
  datasource: string;
  sentColumn: 'clean_sent_at_ms' | 'legacy_sent_at_ms';
}

export interface MessageTraceBatchItem {
  messageId: string;
  traces: TinybirdTrace[];
  importedExecution?: OTLPQueueMessage['importedExecution'];
}

export interface MessageTraceBatchOptions {
  sentryTraceHeaders?: Record<string, string>;
}

export interface MessageTraceResult {
  messageId: string;
  status: MessageTraceStatus;
}

export interface TraceBatcherStats {
  queuedTraces: number;
  blockedRecoveryRows: number;
  blockedRecoveryRecords: number;
  oldestQueuedTraceTime: number | null;
  lastSuccessfulFlushTime: number;
  lastFlushTime: number;
}

class TraceBatcherBase extends DurableObject<Env> {
  private lastFlushTime: number = Date.now();
  private lastSuccessfulFlushTime: number = Date.now();
  private flushAlarmScheduled = false;
  private durableState: DurableObjectState;
  private recovery: TinybirdRecoveryStore;
  private traceCount = 0;
  private flushInProgress = false;
  private logger = createLogger({
    service: 'proxy-consumer',
    runtime: 'durable-object',
    axiom: axiomConfigFromEnv(this.env),
    context: {
      component: 'trace-batcher',
    },
  });

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.durableState = state;
    this.recovery = new TinybirdRecoveryStore(state.storage);

    this.initializeSchema();

    const result = this.durableState.storage.sql.exec<{
      last_flush_time: number;
      last_successful_flush_time: number;
    }>('SELECT last_flush_time, last_successful_flush_time FROM metadata WHERE id = 1');
    const rows = [...result];
    if (rows.length > 0 && rows[0]) {
      this.lastFlushTime = rows[0].last_flush_time;
      this.lastSuccessfulFlushTime = rows[0].last_successful_flush_time;
    }

    this.traceCount = this.countHealthyTraces();

    // If we restart (e.g. after a deploy) with traces already queued, schedule
    // an immediate flush. Without this, stuck traces from a previous version
    // sit until new queue traffic happens to land on this shard.
    if (this.traceCount > 0) {
      void this.durableState.storage.setAlarm(Date.now() + 1000);
      this.flushAlarmScheduled = true;

      const ageMs = Date.now() - this.lastSuccessfulFlushTime;
      if (ageMs > STALE_FLUSH_THRESHOLD_MS) {
        Sentry.captureMessage('TraceBatcher started with stale queue', {
          level: 'warning',
          tags: { operation: 'startup', stale_shard: 'true' },
          extra: {
            queuedTraces: this.traceCount,
            lastSuccessfulFlushAgeMs: ageMs,
          },
        });
      }
    }
  }

  private initializeSchema(): void {
    this.durableState.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS traces (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        data TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        clean_sent_at_ms INTEGER,
        legacy_sent_at_ms INTEGER
      )
    `);
    this.durableState.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS trace_payload_chunks (
        trace_id INTEGER NOT NULL,
        chunk_index INTEGER NOT NULL,
        data TEXT NOT NULL,
        PRIMARY KEY (trace_id, chunk_index)
      )
    `);
    this.ensureColumn('traces', 'clean_sent_at_ms', 'INTEGER');
    this.ensureColumn('traces', 'legacy_sent_at_ms', 'INTEGER');
    this.ensureColumn('traces', 'producer_sentry_trace', 'TEXT');

    this.durableState.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS processed_messages (
        message_id TEXT PRIMARY KEY,
        processed_at_ms INTEGER NOT NULL
      )
    `);

    this.durableState.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS trace_ledger (
        trace_key TEXT PRIMARY KEY,
        content_hash TEXT NOT NULL,
        first_seen_at_ms INTEGER NOT NULL
      )
    `);

    this.durableState.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS trace_repairs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        trace_key TEXT NOT NULL,
        old_hash TEXT NOT NULL,
        new_hash TEXT NOT NULL,
        seen_at_ms INTEGER NOT NULL
      )
    `);
    this.ensureColumn('trace_repairs', 'data', 'TEXT');

    this.recovery.initialize();

    this.durableState.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS metadata (
        id INTEGER PRIMARY KEY,
        last_flush_time INTEGER NOT NULL,
        last_successful_flush_time INTEGER NOT NULL
      )
    `);

    let needsMigration = false;
    try {
      const rows = [
        ...this.durableState.storage.sql.exec<{ last_successful_flush_time: number | null }>(
          'SELECT last_successful_flush_time FROM metadata WHERE id = 1',
        ),
      ];
      needsMigration = rows.length > 0 && rows[0]?.last_successful_flush_time === null;
    } catch {
      // Column doesn't exist yet on pre-existing DOs
      needsMigration = true;
    }
    if (needsMigration) {
      try {
        this.durableState.storage.sql.exec(
          'ALTER TABLE metadata ADD COLUMN last_successful_flush_time INTEGER',
        );
      } catch {
        // Column already exists
      }
      this.durableState.storage.sql.exec(
        'UPDATE metadata SET last_successful_flush_time = last_flush_time WHERE last_successful_flush_time IS NULL',
      );
    }

    const metadataExists = [
      ...this.durableState.storage.sql.exec<{ count: number }>(
        'SELECT COUNT(*) as count FROM metadata WHERE id = 1',
      ),
    ];

    if (metadataExists[0]?.count === 0) {
      const now = Date.now();
      this.durableState.storage.sql.exec(
        'INSERT INTO metadata (id, last_flush_time, last_successful_flush_time) VALUES (1, ?, ?)',
        now,
        now,
      );
    }
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const existing = [
      ...this.durableState.storage.sql.exec<{ name: string }>(
        `SELECT name FROM pragma_table_info('${table}') WHERE name = ?`,
        column,
      ),
    ];
    if (existing.length === 0) {
      this.durableState.storage.sql.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }

  async addMessageTraces(
    items: MessageTraceBatchItem[],
    options: MessageTraceBatchOptions = {},
  ): Promise<MessageTraceResult[]> {
    for (const [messageId, header] of Object.entries(options.sentryTraceHeaders ?? {})) {
      if (
        !items.some((item) => item.messageId === messageId) ||
        !durableSentryTraceHeader({ 'sentry-trace': header })
      ) {
        throw new Error('Invalid trace batch producer context');
      }
    }
    if (items.length === 0) {
      return [];
    }

    const now = Date.now();
    const results: MessageTraceResult[] = [];
    let insertedTraceCount = 0;

    for (const item of items) {
      try {
        const summary = this.insertMessageTraces(
          item,
          now,
          options.sentryTraceHeaders?.[item.messageId] ?? null,
        );
        if (summary.messageInserted) {
          insertedTraceCount += summary.queuedTraces;
        }
        if (summary.repairTraces > 0) {
          this.logger.warn('consumer.trace_repair_rows_detected', {
            messageId: item.messageId,
            repairTraces: summary.repairTraces,
          });
        }
        results.push({
          messageId: item.messageId,
          status: summary.messageInserted ? 'inserted' : 'duplicate',
        });
      } catch (error) {
        this.logger
          .child({ traceId: item.traces[0]?.TraceId })
          .error('consumer.trace_insert_failed', error, {
            messageId: item.messageId,
          });
        results.push({ messageId: item.messageId, status: 'failed' });
      }
    }

    this.traceCount = this.countHealthyTraces();

    if (this.traceCount > 0) {
      if (this.traceCount >= BATCH_SIZE && insertedTraceCount > 0) {
        await this.flush();
      } else {
        const currentAlarm = await this.durableState.storage.getAlarm();
        if (!currentAlarm) {
          await this.scheduleFlush();
        }
      }
    }

    await this.logger.flush();
    return results;
  }

  async alarm(): Promise<void> {
    this.flushAlarmScheduled = false;

    const timeSinceLastFlush = Date.now() - this.lastFlushTime;
    const jitter = Math.floor(Math.random() * MAX_JITTER_MS);
    const flushThreshold = FLUSH_INTERVAL_MS + jitter;

    if (timeSinceLastFlush >= flushThreshold && this.traceCount > 0) {
      await this.flush();
    } else if (this.traceCount > 0) {
      await this.scheduleFlush();
    }
  }

  private async scheduleFlush(): Promise<void> {
    if (this.flushAlarmScheduled) {
      return;
    }

    const jitter = Math.floor(Math.random() * MAX_JITTER_MS);
    const nextFlushTime = this.lastFlushTime + FLUSH_INTERVAL_MS + jitter;
    const delay = Math.max(0, nextFlushTime - Date.now());
    const alarmTime = Date.now() + delay;

    await this.durableState.storage.setAlarm(alarmTime);
    this.flushAlarmScheduled = true;
  }

  private async flush(): Promise<void> {
    if (this.flushInProgress) {
      return;
    }

    if (this.traceCount === 0) {
      return;
    }

    this.flushInProgress = true;

    let lastSuccessfulFlushTime = this.lastSuccessfulFlushTime;

    try {
      const targets = tinybirdWriteTargets(this.env);
      for (const target of targets) {
        const rows = this.selectHealthyRows(target);
        for (const batch of splitRowsByBytes(rows)) {
          const result = await this.sendTraceBatch(target, batch);
          if (result === 'retryable') break;
          if (result === 'confirmed') lastSuccessfulFlushTime = Date.now();
        }
      }
      this.deleteFullySentTraces(
        [...this.durableState.storage.sql.exec<{ id: number }>('SELECT id FROM traces')].map(
          (row) => row.id,
        ),
        targets,
      );
    } finally {
      this.traceCount = this.countHealthyTraces();
      this.lastFlushTime = Date.now();
      this.lastSuccessfulFlushTime = lastSuccessfulFlushTime;
      this.updateFlushTimes();

      if (this.flushAlarmScheduled) {
        void this.durableState.storage.deleteAlarm();
        this.flushAlarmScheduled = false;
      }

      this.flushInProgress = false;

      // Flush logs BEFORE rescheduling: scheduleFlush awaits storage.setAlarm,
      // which can throw on rare CF storage errors. If logs aren't flushed
      // first, error context is lost at exactly the moment you need it most.
      await this.logger.flush();

      // If the queue didn't fully drain (Tinybird error, SQLite error, etc),
      // reschedule. Otherwise the residual traces sit indefinitely until new
      // queue traffic happens to land on this shard — that's how shard 7 baked
      // 33k traces for 51 days after a single bad flush.
      if (this.traceCount > 0) {
        await this.scheduleFlush();
      }
    }
  }

  private selectHealthyRows(target: TinybirdTraceTarget): StoredTraceRow[] {
    return [
      ...this.durableState.storage.sql.exec<StoredTraceRow>(
        `SELECT id, data, clean_sent_at_ms, legacy_sent_at_ms, producer_sentry_trace
         FROM traces AS t
         WHERE ${target.sentColumn} IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM recovery_items AS i
             JOIN recovery_records AS r ON r.id = i.recovery_id
             WHERE i.row_id = t.id AND i.target_key = ? AND r.state IN ('in_flight', 'blocked')
           )
         ORDER BY id
         LIMIT ?`,
        target.sentColumn,
        BATCH_SIZE,
      ),
    ].map((row) => ({ ...row, data: this.loadTraceData(row.id, row.data) }));
  }

  private loadTraceData(traceId: number, fallback: string): string {
    if (fallback.length > 0) return fallback;
    const chunks = [
      ...this.durableState.storage.sql.exec<{ data: string }>(
        'SELECT data FROM trace_payload_chunks WHERE trace_id = ? ORDER BY chunk_index',
        traceId,
      ),
    ];
    if (chunks.length === 0) throw new Error(`trace ${traceId} has no payload`);
    return chunks.map((chunk) => chunk.data).join('');
  }

  private async sendTraceBatch(
    target: TinybirdTraceTarget,
    rows: StoredTraceRow[],
  ): Promise<'confirmed' | 'blocked' | 'retryable'> {
    if (rows.length === 0) return 'confirmed';
    const headers = [...new Set(rows.map((row) => row.producer_sentry_trace).filter(Boolean))];
    const links = sentryTraceLinks(headers);
    return Sentry.startSpan(
      {
        name: 'flush trace batch',
        op: 'queue.flush',
        links,
        attributes: {
          'messaging.batch.message_count': rows.length,
          'trace_flow.producer_link_count': links.length,
          'trace_flow.producer_links_omitted': headers.length - links.length,
        },
      },
      () => this.sendTraceBatchInner(target, rows),
    );
  }

  private async sendTraceBatchInner(
    target: TinybirdTraceTarget,
    rows: StoredTraceRow[],
  ): Promise<'confirmed' | 'blocked' | 'retryable'> {
    const rowIds = rows.map((row) => row.id);
    let traces: TinybirdTrace[];
    try {
      traces = await Promise.all(
        rows.map(async (row) => {
          const trace = JSON.parse(row.data) as TinybirdTrace;
          return { ...trace, ApiKey: await normalizeAnalyticsKey(trace.ApiKey) };
        }),
      );
    } catch (error) {
      if (rows.length > 1) {
        const middle = Math.ceil(rows.length / 2);
        const left = await this.sendTraceBatch(target, rows.slice(0, middle));
        const right = await this.sendTraceBatch(target, rows.slice(middle));
        if (left === 'retryable' || right === 'retryable') return 'retryable';
        return left === 'confirmed' && right === 'confirmed' ? 'confirmed' : 'blocked';
      }
      this.recovery.preserveInsert(
        target.datasource,
        target.sentColumn,
        `[${rows[0]?.data ?? ''}]`,
        rowIds,
        'rejected',
        serializeTinybirdFailure(error),
      );
      return 'blocked';
    }

    const payload = JSON.stringify(traces);
    if (new TextEncoder().encode(payload).byteLength > MAX_NDJSON_BYTES) {
      if (rows.length > 1) {
        const middle = Math.ceil(rows.length / 2);
        const left = await this.sendTraceBatch(target, rows.slice(0, middle));
        const right = await this.sendTraceBatch(target, rows.slice(middle));
        if (left === 'retryable' || right === 'retryable') return 'retryable';
        return left === 'confirmed' && right === 'confirmed' ? 'confirmed' : 'blocked';
      }
      this.recovery.preserveInsert(
        target.datasource,
        target.sentColumn,
        payload,
        rowIds,
        'rejected',
        JSON.stringify({ reason: 'row_too_large' }),
      );
      return 'blocked';
    }

    const recoveryId = this.recovery.beginInsert(
      target.datasource,
      target.sentColumn,
      payload,
      rowIds,
    );
    const startedAt = Date.now();
    try {
      await insertIntoTinybirdWithRetry(
        traces,
        this.env.TINYBIRD_TOKEN,
        target.datasource,
        this.env.TINYBIRD_HOST ?? 'https://api.us-west-2.aws.tinybird.co',
      );
      this.markTraceTargetSent(rowIds, target.sentColumn);
      this.recovery.discardIntent(recoveryId);
      return 'confirmed';
    } catch (error) {
      const classification = classifyTinybirdInsertFailure(error);
      const diagnostics = {
        ...describeTinybirdInsertFailure(error),
        batchSize: rows.length,
        classification,
        datasource: target.datasource,
        elapsedMs: Date.now() - startedAt,
      };
      const sanitizedError = new Error('Tinybird insert failed');
      this.logger
        .child({ traceId: firstTraceId(rows) })
        .error('consumer.tinybird_flush_failed', sanitizedError, diagnostics);
      captureSafeException(error, {
        message: 'Tinybird insert failed',
        operation: 'trace_batcher.flush',
        diagnostics: {
          type: diagnostics.errorType,
          context: diagnostics,
          stackFilenames: ['index.js', 'batcher.ts', 'tinybird.ts', 'insertRows.ts'],
        },
      });

      if (classification === 'retryable') {
        this.recovery.discardIntent(recoveryId);
        return 'retryable';
      }
      if (isPayloadTooLarge(error) && rows.length > 1) {
        this.recovery.discardIntent(recoveryId);
        const middle = Math.ceil(rows.length / 2);
        const left = await this.sendTraceBatch(target, rows.slice(0, middle));
        const right = await this.sendTraceBatch(target, rows.slice(middle));
        if (left === 'retryable' || right === 'retryable') return 'retryable';
        return left === 'confirmed' && right === 'confirmed' ? 'confirmed' : 'blocked';
      }
      this.recovery.blockInsert(recoveryId, classification, serializeTinybirdFailure(error));
      return 'blocked';
    }
  }

  private updateFlushTimes(): void {
    this.durableState.storage.sql.exec(
      'UPDATE metadata SET last_flush_time = ?, last_successful_flush_time = ? WHERE id = 1',
      this.lastFlushTime,
      this.lastSuccessfulFlushTime,
    );
  }

  private healthyTraceCondition(): string {
    const targets = tinybirdWriteTargets(this.env);
    const clauses = targets.map(
      (target) => `(${target.sentColumn} IS NULL AND NOT EXISTS (
        SELECT 1 FROM recovery_items AS i JOIN recovery_records AS r ON r.id = i.recovery_id
        WHERE i.row_id = traces.id AND i.target_key = '${target.sentColumn}'
          AND r.state IN ('in_flight', 'blocked')
      ))`,
    );
    return clauses.join(' OR ') || '0';
  }

  private countHealthyTraces(): number {
    return this.durableState.storage.sql
      .exec<{
        count: number;
      }>(`SELECT COUNT(*) AS count FROM traces WHERE ${this.healthyTraceCondition()}`)
      .one().count;
  }

  private markTraceTargetSent(ids: number[], column: TinybirdTraceTarget['sentColumn']): void {
    if (ids.length === 0) {
      return;
    }

    this.durableState.storage.transactionSync(() => this.markTraceTargetSentSync(ids, column));
  }

  private markTraceTargetSentSync(ids: number[], column: TinybirdTraceTarget['sentColumn']): void {
    const sentAt = Date.now();
    for (let i = 0; i < ids.length; i += MAX_SQL_PARAMS - 1) {
      const chunk = ids.slice(i, i + MAX_SQL_PARAMS - 1);
      this.durableState.storage.sql.exec(
        `UPDATE traces SET ${column} = ? WHERE id IN (${chunk.map(() => '?').join(',')})`,
        sentAt,
        ...chunk,
      );
    }
  }

  private deleteFullySentTraces(ids: number[], targets: TinybirdTraceTarget[]): number {
    if (ids.length === 0 || targets.length === 0) {
      return 0;
    }

    const sentCondition = targets.map((target) => `${target.sentColumn} IS NOT NULL`).join(' AND ');
    let deleted = 0;

    this.durableState.storage.transactionSync(() => {
      for (let i = 0; i < ids.length; i += MAX_SQL_PARAMS) {
        const chunk = ids.slice(i, i + MAX_SQL_PARAMS);
        this.durableState.storage.sql.exec(
          `DELETE FROM trace_payload_chunks WHERE trace_id IN (
               SELECT id FROM traces WHERE id IN (${chunk.map(() => '?').join(',')})
                 AND ${sentCondition}
             )`,
          ...chunk,
        );
        this.durableState.storage.sql.exec(
          `DELETE FROM traces
           WHERE id IN (${chunk.map(() => '?').join(',')})
             AND ${sentCondition}`,
          ...chunk,
        );
        const changes = [
          ...this.durableState.storage.sql.exec<{ changes: number }>('SELECT changes() AS changes'),
        ][0];
        deleted += changes?.changes ?? 0;
      }
    });

    return deleted;
  }

  // Manually drain stuck traces. Call via RPC from an admin endpoint when a
  // shard has wedged for unrelated reasons (old code, prior incident, etc).
  async forceFlush(): Promise<{ before: number; after: number }> {
    const before = this.traceCount;
    await this.flush();
    return { before, after: this.traceCount };
  }

  listRecovery(options: RecoveryPageOptions = {}): RecoveryPage {
    return this.recovery.list(options);
  }

  getRecovery(recoveryId: number): RecoveryRecord {
    return this.recovery.get(recoveryId);
  }

  async reconcileRecovery(input: ReconcileRecoveryInput): Promise<RecoveryRecord> {
    requireRecoveryReason(input.reason);
    const record = this.recovery.get(input.recoveryId);
    requireReconcileAction(record, input.action);
    if (record.kind !== 'tinybird_insert') {
      return this.recovery.resolve(record.id, input.action, input.reason);
    }

    const targetKey = requireTargetKey(this.recovery.getTargetKey(record.id));
    const ids = this.recovery.rowIds(record.id);
    if (input.action === 'confirm-not-written') {
      await this.durableState.storage.setAlarm(Date.now() + 1000);
      this.flushAlarmScheduled = true;
    }
    const resolved = this.recovery.resolveWithMutation(
      record.id,
      input.action,
      input.reason,
      () => {
        if (input.action === 'confirm-written') {
          this.markTraceTargetSentSync(ids, targetKey);
        }
      },
    );
    if (input.action === 'confirm-written') {
      this.deleteFullySentTraces(ids, tinybirdWriteTargets(this.env));
    }
    this.traceCount = this.countHealthyTraces();
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

  getStats(): TraceBatcherStats {
    let oldestQueuedTraceTime: number | null = null;
    if (this.traceCount > 0) {
      const oldestTraceRows = [
        ...this.durableState.storage.sql.exec<{ oldest_queued_trace_time: number | null }>(
          `SELECT MIN(timestamp) AS oldest_queued_trace_time FROM traces WHERE ${this.healthyTraceCondition()}`,
        ),
      ];
      oldestQueuedTraceTime = oldestTraceRows[0]?.oldest_queued_trace_time ?? null;
    }

    return {
      queuedTraces: this.traceCount,
      blockedRecoveryRows: this.recovery.countBlockedRows(),
      blockedRecoveryRecords: this.recovery.countBlockedRecords(),
      oldestQueuedTraceTime,
      lastSuccessfulFlushTime: this.lastSuccessfulFlushTime,
      lastFlushTime: this.lastFlushTime,
    };
  }

  private insertMessageTraces(
    item: MessageTraceBatchItem,
    now: number,
    producerSentryTrace: string | null,
  ): TraceInsertSummary {
    const summary: TraceInsertSummary = {
      messageInserted: false,
      queuedTraces: 0,
      duplicateTraces: 0,
      repairTraces: 0,
    };

    this.durableState.storage.transactionSync(() => {
      this.durableState.storage.sql.exec(
        `INSERT OR IGNORE INTO processed_messages (message_id, processed_at_ms)
         VALUES (?, ?)`,
        item.messageId,
        now,
      );

      const changeRow = [
        ...this.durableState.storage.sql.exec<{ changes: number }>('SELECT changes() as changes'),
      ][0];
      summary.messageInserted = (changeRow?.changes ?? 0) > 0;

      if (!summary.messageInserted) {
        return;
      }

      if (item.traces.length > 0) {
        const timestamp = now;
        const tracesToQueue: TinybirdTrace[] = [];

        for (const trace of item.traces) {
          const ledger = traceLedgerEntry(trace, item.importedExecution);
          const traceKey = ledger.key;
          const contentHash = ledger.hash;
          const existing = [
            ...this.durableState.storage.sql.exec<{ content_hash: string }>(
              'SELECT content_hash FROM trace_ledger WHERE trace_key = ?',
              traceKey,
            ),
          ][0];

          if (existing?.content_hash === contentHash) {
            summary.duplicateTraces++;
            continue;
          }

          if (existing) {
            summary.repairTraces++;
            const changedData = JSON.stringify(trace);
            const priorRepair = [
              ...this.durableState.storage.sql.exec<{ id: number }>(
                `SELECT id FROM trace_repairs
               WHERE trace_key = ? AND old_hash = ? AND new_hash = ? LIMIT 1`,
                traceKey,
                existing.content_hash,
                contentHash,
              ),
            ][0];
            if (!priorRepair) {
              this.durableState.storage.sql.exec(
                `INSERT INTO trace_repairs (trace_key, old_hash, new_hash, seen_at_ms, data)
                 VALUES (?, ?, ?, ?, ?)`,
                traceKey,
                existing.content_hash,
                contentHash,
                now,
                inlinePayload(changedData),
              );
            }
            this.recovery.preserveRepair(
              changedData,
              JSON.stringify({
                traceKey,
                oldHash: existing.content_hash,
                newHash: contentHash,
                ...(ledger.contract
                  ? { ledger: 'imported_execution', contract: ledger.contract }
                  : {}),
              }),
              JSON.stringify([traceKey, existing.content_hash, contentHash]),
            );
            continue;
          }

          this.durableState.storage.sql.exec(
            `INSERT INTO trace_ledger (trace_key, content_hash, first_seen_at_ms)
             VALUES (?, ?, ?)`,
            traceKey,
            contentHash,
            now,
          );
          tracesToQueue.push(trace);
        }

        for (let j = 0; j < tracesToQueue.length; j += MAX_INSERT_ROWS) {
          const chunk = tracesToQueue
            .slice(j, j + MAX_INSERT_ROWS)
            .filter(
              (trace) =>
                new TextEncoder().encode(JSON.stringify(trace)).byteLength <= MAX_NDJSON_BYTES,
            );
          if (chunk.length === 0) continue;
          const values = chunk.map(() => '(?, ?, ?)').join(', ');
          const params = chunk.flatMap((trace) => [
            JSON.stringify(trace),
            timestamp,
            producerSentryTrace,
          ]);
          this.durableState.storage.sql.exec(
            `INSERT INTO traces (data, timestamp, producer_sentry_trace) VALUES ${values}`,
            ...params,
          );
        }
        for (const trace of tracesToQueue) {
          const data = JSON.stringify(trace);
          if (new TextEncoder().encode(data).byteLength <= MAX_NDJSON_BYTES) continue;
          this.durableState.storage.sql.exec(
            'INSERT INTO traces (data, timestamp, producer_sentry_trace) VALUES (?, ?, ?)',
            '',
            timestamp,
            producerSentryTrace,
          );
          const traceId = this.durableState.storage.sql
            .exec<{ id: number }>('SELECT last_insert_rowid() AS id')
            .one().id;
          for (const [index, chunk] of splitUtf8Chunks(data, MAX_NDJSON_BYTES).entries()) {
            this.durableState.storage.sql.exec(
              'INSERT INTO trace_payload_chunks (trace_id, chunk_index, data) VALUES (?, ?, ?)',
              traceId,
              index,
              chunk,
            );
          }
        }
        summary.queuedTraces = tracesToQueue.length;
      }
    });

    return summary;
  }
}

function firstTraceId(rows: StoredTraceRow[]): string | undefined {
  const first = rows[0];
  if (!first) {
    return undefined;
  }

  try {
    return (JSON.parse(first.data) as TinybirdTrace).TraceId;
  } catch {
    return undefined;
  }
}

function splitRowsByBytes(rows: StoredTraceRow[]): StoredTraceRow[][] {
  const batches: StoredTraceRow[][] = [];
  let current: StoredTraceRow[] = [];
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

function requireTargetKey(value: string | null): TinybirdTraceTarget['sentColumn'] {
  if (value === 'clean_sent_at_ms' || value === 'legacy_sent_at_ms') return value;
  throw new Error('recovery record has invalid target key');
}

interface TinybirdTraceWriteEnv {
  TINYBIRD_DATASOURCE?: string;
  TINYBIRD_LEGACY_DATASOURCE?: string;
  TINYBIRD_TRACE_WRITE_MODE?: string;
}

export function tinybirdWriteTargets(env: TinybirdTraceWriteEnv): TinybirdTraceTarget[] {
  const clean = env.TINYBIRD_DATASOURCE ?? 'otel_trace_spans';
  const mode = env.TINYBIRD_TRACE_WRITE_MODE ?? 'clean';

  if (mode === 'clean') return [{ datasource: clean, sentColumn: 'clean_sent_at_ms' }];
  if (mode !== 'legacy' && mode !== 'dual') {
    throw new Error(`invalid TINYBIRD_TRACE_WRITE_MODE: ${mode}`);
  }
  const legacy = env.TINYBIRD_LEGACY_DATASOURCE;
  if (!legacy?.trim()) {
    throw new Error(`TINYBIRD_LEGACY_DATASOURCE is required for ${mode} write mode`);
  }
  if (mode === 'legacy') return [{ datasource: legacy, sentColumn: 'legacy_sent_at_ms' }];
  if (legacy === clean) {
    return [{ datasource: clean, sentColumn: 'clean_sent_at_ms' }];
  }
  return [
    { datasource: legacy, sentColumn: 'legacy_sent_at_ms' },
    { datasource: clean, sentColumn: 'clean_sent_at_ms' },
  ];
}

export const TraceBatcher = Sentry.instrumentDurableObjectWithSentry(
  (env: Env) => ({
    dsn: env.SENTRY_DSN,
    release: env.CF_VERSION_METADATA?.id,
    environment: env.SENTRY_ENVIRONMENT ?? 'development',
    tracesSampleRate: 1.0,
    tracePropagationTargets: TRACE_FLOW_PROPAGATION_TARGETS,
    ...sentryRequestPrivacy(),
    // Must match the calling Worker: the stub appends a trailing metadata argument that only an
    // RPC-instrumented Durable Object strips back off before the method sees its args.
    enableRpcTracePropagation: true,
  }),
  TraceBatcherBase,
);

export type TraceBatcherInstance = InstanceType<typeof TraceBatcher>;
