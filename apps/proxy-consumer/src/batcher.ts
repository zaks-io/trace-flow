import * as Sentry from '@sentry/cloudflare';
import { DurableObject } from 'cloudflare:workers';
import { axiomConfigFromEnv, createLogger } from '@trace-flow/logging';
import type { TinybirdTrace } from '@trace-flow/types';
import type { Env } from './index';
import { insertIntoTinybirdWithRetry } from './tinybird';

const BATCH_SIZE = 10_000;
const FLUSH_INTERVAL_MS = 5000;
const MAX_JITTER_MS = 1000;
// Threshold for emitting a Sentry alert when a shard has been unable to flush.
// One hour gives enough headroom that a transient Tinybird outage doesn't page,
// but catches the silent-bake scenario (shard 7 went 51 days unnoticed).
const STALE_FLUSH_THRESHOLD_MS = 60 * 60 * 1000;
// Cloudflare DO SQLite limits bind params; stay well under the limit
const MAX_SQL_PARAMS = 90;
// INSERT uses 2 params per row (data, timestamp)
const MAX_INSERT_ROWS = Math.floor(MAX_SQL_PARAMS / 2);
const PROCESSED_MESSAGE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

export const TRACE_BATCHER_BATCH_SIZE = BATCH_SIZE;
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
}

interface TinybirdTraceTarget {
  datasource: string;
  sentColumn: 'clean_sent_at_ms' | 'legacy_sent_at_ms';
}

export interface MessageTraceBatchItem {
  messageId: string;
  traces: TinybirdTrace[];
}

export interface MessageTraceResult {
  messageId: string;
  status: MessageTraceStatus;
}

export interface TraceBatcherStats {
  queuedTraces: number;
  oldestQueuedTraceTime: number | null;
  lastSuccessfulFlushTime: number;
  lastFlushTime: number;
}

class TraceBatcherBase extends DurableObject<Env> {
  private lastFlushTime: number = Date.now();
  private lastSuccessfulFlushTime: number = Date.now();
  private flushAlarmScheduled = false;
  private durableState: DurableObjectState;
  private traceCount = 0;
  private flushInProgress = false;
  private lastCleanupTime = 0;
  private lastStaleAlertTime = 0;
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

    const countResult = this.durableState.storage.sql.exec<{ count: number }>(
      'SELECT COUNT(*) as count FROM traces',
    );
    const countRows = [...countResult];
    if (countRows.length > 0 && countRows[0]) {
      this.traceCount = countRows[0].count;
    }

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
    this.ensureColumn('traces', 'clean_sent_at_ms', 'INTEGER');
    this.ensureColumn('traces', 'legacy_sent_at_ms', 'INTEGER');

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

    this.durableState.storage.sql.exec(`
      CREATE INDEX IF NOT EXISTS idx_processed_messages_time
      ON processed_messages(processed_at_ms)
    `);

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

  async addMessageTraces(items: MessageTraceBatchItem[]): Promise<MessageTraceResult[]> {
    if (items.length === 0) {
      return [];
    }

    const now = Date.now();
    this.cleanupProcessedMessages(now);

    const results: MessageTraceResult[] = [];
    let insertedTraceCount = 0;

    for (const item of items) {
      try {
        const summary = this.insertMessageTraces(item, now);
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

    const batchCount = Math.ceil(this.traceCount / BATCH_SIZE);
    let lastSuccessfulFlushTime = this.lastSuccessfulFlushTime;

    try {
      for (let i = 0; i < batchCount; i++) {
        const rows = [
          ...this.durableState.storage.sql.exec<StoredTraceRow>(
            `SELECT id, data, clean_sent_at_ms, legacy_sent_at_ms
             FROM traces
             ORDER BY id
             LIMIT ?`,
            BATCH_SIZE,
          ),
        ];

        if (rows.length === 0) {
          break;
        }

        const targets = tinybirdWriteTargets(this.env);
        const ids = rows.map((row) => row.id);

        try {
          const host = this.env.TINYBIRD_HOST ?? 'https://api.us-west-2.aws.tinybird.co';
          for (const target of targets) {
            const targetRows = rows.filter((row) => row[target.sentColumn] === null);
            if (targetRows.length === 0) {
              continue;
            }

            const traces = targetRows.map((row) => JSON.parse(row.data) as TinybirdTrace);
            await insertIntoTinybirdWithRetry(
              traces,
              this.env.TINYBIRD_TOKEN,
              target.datasource,
              host,
            );
            this.markTraceTargetSent(
              targetRows.map((row) => row.id),
              target.sentColumn,
            );
          }

          const deleted = this.deleteFullySentTraces(ids, targets);
          this.traceCount -= deleted;
          lastSuccessfulFlushTime = Date.now();
        } catch (error) {
          this.logger
            .child({ traceId: firstTraceId(rows) })
            .error('consumer.tinybird_flush_failed', error, {
              batchSize: rows.length,
            });
          const ageMs = Date.now() - this.lastSuccessfulFlushTime;
          const isStale = ageMs > STALE_FLUSH_THRESHOLD_MS;
          // Throttle fatal alerts: with 5s retries, an extended Tinybird
          // outage would otherwise emit ~720 fatal events/hour/shard. Cap at
          // one fatal per stale-window per shard; downgrade the rest to error.
          const shouldEmitFatal =
            isStale && Date.now() - this.lastStaleAlertTime >= STALE_FLUSH_THRESHOLD_MS;
          if (shouldEmitFatal) {
            this.lastStaleAlertTime = Date.now();
          }
          Sentry.captureException(error, {
            level: shouldEmitFatal ? 'fatal' : 'error',
            tags: {
              operation: 'flush',
              stale_shard: isStale ? 'true' : 'false',
            },
            extra: {
              batchSize: rows.length,
              queuedTraces: this.traceCount,
              lastSuccessfulFlushAgeMs: ageMs,
            },
          });
          break;
        }
      }
    } finally {
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

  private updateFlushTimes(): void {
    this.durableState.storage.sql.exec(
      'UPDATE metadata SET last_flush_time = ?, last_successful_flush_time = ? WHERE id = 1',
      this.lastFlushTime,
      this.lastSuccessfulFlushTime,
    );
  }

  private markTraceTargetSent(ids: number[], column: TinybirdTraceTarget['sentColumn']): void {
    if (ids.length === 0) {
      return;
    }

    const sentAt = Date.now();
    this.durableState.storage.transactionSync(() => {
      for (let i = 0; i < ids.length; i += MAX_SQL_PARAMS - 1) {
        const chunk = ids.slice(i, i + MAX_SQL_PARAMS - 1);
        this.durableState.storage.sql.exec(
          `UPDATE traces
           SET ${column} = ?
           WHERE id IN (${chunk.map(() => '?').join(',')})`,
          sentAt,
          ...chunk,
        );
      }
    });
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

  getStats(): TraceBatcherStats {
    let oldestQueuedTraceTime: number | null = null;
    if (this.traceCount > 0) {
      const oldestTraceRows = [
        ...this.durableState.storage.sql.exec<{ oldest_queued_trace_time: number | null }>(
          'SELECT MIN(timestamp) as oldest_queued_trace_time FROM traces',
        ),
      ];
      oldestQueuedTraceTime = oldestTraceRows[0]?.oldest_queued_trace_time ?? null;
    }

    return {
      queuedTraces: this.traceCount,
      oldestQueuedTraceTime,
      lastSuccessfulFlushTime: this.lastSuccessfulFlushTime,
      lastFlushTime: this.lastFlushTime,
    };
  }

  private insertMessageTraces(item: MessageTraceBatchItem, now: number): TraceInsertSummary {
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
          const traceKey = traceIdentity(trace);
          const contentHash = stableHash(trace);
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
            this.durableState.storage.sql.exec(
              `INSERT INTO trace_repairs (trace_key, old_hash, new_hash, seen_at_ms)
               VALUES (?, ?, ?, ?)`,
              traceKey,
              existing.content_hash,
              contentHash,
              now,
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
          const chunk = tracesToQueue.slice(j, j + MAX_INSERT_ROWS);
          const values = chunk.map(() => '(?, ?)').join(', ');
          const params = chunk.flatMap((trace) => [JSON.stringify(trace), timestamp]);
          this.durableState.storage.sql.exec(
            `INSERT INTO traces (data, timestamp) VALUES ${values}`,
            ...params,
          );
        }
        summary.queuedTraces = tracesToQueue.length;
      }
    });

    if (summary.messageInserted) {
      this.traceCount += summary.queuedTraces;
    }
    return summary;
  }

  private cleanupProcessedMessages(now: number): void {
    if (now - this.lastCleanupTime < CLEANUP_INTERVAL_MS) {
      return;
    }

    const cutoff = now - PROCESSED_MESSAGE_TTL_MS;
    this.durableState.storage.sql.exec(
      'DELETE FROM processed_messages WHERE processed_at_ms < ?',
      cutoff,
    );
    this.lastCleanupTime = now;
  }
}

function traceIdentity(trace: TinybirdTrace): string {
  return [trace.ApiKey, trace.TraceId, trace.SpanId].map(identityPart).join('\x1f');
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

function stableHash(value: unknown): string {
  const input = stableStringify(value);
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (let i = 0; i < input.length; i++) {
    hash ^= BigInt(input.charCodeAt(i));
    hash = BigInt.asUintN(64, hash * prime);
  }
  return hash.toString(16).padStart(16, '0');
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function identityPart(value: string): string {
  return value;
}

interface TinybirdTraceWriteEnv {
  TINYBIRD_DATASOURCE?: string;
  TINYBIRD_LEGACY_DATASOURCE?: string;
  TINYBIRD_TRACE_WRITE_MODE?: string;
}

function tinybirdWriteTargets(env: TinybirdTraceWriteEnv): TinybirdTraceTarget[] {
  const clean = env.TINYBIRD_DATASOURCE ?? 'otel_trace_spans';
  const legacy = env.TINYBIRD_LEGACY_DATASOURCE ?? 'otel_traces';
  const mode = env.TINYBIRD_TRACE_WRITE_MODE ?? 'clean';

  if (mode === 'clean') return [{ datasource: clean, sentColumn: 'clean_sent_at_ms' }];
  if (mode === 'legacy') return [{ datasource: legacy, sentColumn: 'legacy_sent_at_ms' }];
  if (mode === 'dual') {
    if (legacy === clean) {
      return [{ datasource: clean, sentColumn: 'clean_sent_at_ms' }];
    }
    return [
      { datasource: legacy, sentColumn: 'legacy_sent_at_ms' },
      { datasource: clean, sentColumn: 'clean_sent_at_ms' },
    ];
  }

  throw new Error(`invalid TINYBIRD_TRACE_WRITE_MODE: ${mode}`);
}

export const TraceBatcher = Sentry.instrumentDurableObjectWithSentry(
  (env: Env) => ({
    dsn: env.SENTRY_DSN,
    release: env.CF_VERSION_METADATA?.id,
    environment: env.SENTRY_ENVIRONMENT ?? 'development',
    tracesSampleRate: 0.1,
  }),
  TraceBatcherBase,
);

export type TraceBatcherInstance = InstanceType<typeof TraceBatcher>;
