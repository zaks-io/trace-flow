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
        timestamp INTEGER NOT NULL
      )
    `);

    this.durableState.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS processed_messages (
        message_id TEXT PRIMARY KEY,
        processed_at_ms INTEGER NOT NULL
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
        const inserted = this.insertMessageTraces(item, now);
        if (inserted) {
          insertedTraceCount += item.traces.length;
        }
        results.push({
          messageId: item.messageId,
          status: inserted ? 'inserted' : 'duplicate',
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
          ...this.durableState.storage.sql.exec<{ id: number; data: string }>(
            'SELECT id, data FROM traces ORDER BY id LIMIT ?',
            BATCH_SIZE,
          ),
        ];

        if (rows.length === 0) {
          break;
        }

        const traces: TinybirdTrace[] = rows.map((row) => JSON.parse(row.data) as TinybirdTrace);
        const ids = rows.map((row) => row.id);

        try {
          const datasource = this.env.TINYBIRD_DATASOURCE ?? 'otel_traces';
          const host = this.env.TINYBIRD_HOST ?? 'https://api.us-west-2.aws.tinybird.co';
          await insertIntoTinybirdWithRetry(traces, this.env.TINYBIRD_TOKEN, datasource, host);

          this.durableState.storage.transactionSync(() => {
            for (let j = 0; j < ids.length; j += MAX_SQL_PARAMS) {
              const chunk = ids.slice(j, j + MAX_SQL_PARAMS);
              this.durableState.storage.sql.exec(
                `DELETE FROM traces WHERE id IN (${chunk.map(() => '?').join(',')})`,
                ...chunk,
              );
            }
          });

          this.traceCount -= traces.length;
          lastSuccessfulFlushTime = Date.now();
        } catch (error) {
          this.logger
            .child({ traceId: traces[0]?.TraceId })
            .error('consumer.tinybird_flush_failed', error, {
              batchSize: traces.length,
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
              batchSize: traces.length,
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

  private insertMessageTraces(item: MessageTraceBatchItem, now: number): boolean {
    let inserted = false;
    let tracesInserted = 0;

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
      inserted = (changeRow?.changes ?? 0) > 0;

      if (!inserted) {
        return;
      }

      if (item.traces.length > 0) {
        const timestamp = now;
        for (let j = 0; j < item.traces.length; j += MAX_INSERT_ROWS) {
          const chunk = item.traces.slice(j, j + MAX_INSERT_ROWS);
          const values = chunk.map(() => '(?, ?)').join(', ');
          const params = chunk.flatMap((trace) => [JSON.stringify(trace), timestamp]);
          this.durableState.storage.sql.exec(
            `INSERT INTO traces (data, timestamp) VALUES ${values}`,
            ...params,
          );
        }
        tracesInserted = item.traces.length;
      }
    });

    if (inserted) {
      this.traceCount += tracesInserted;
    }
    return inserted;
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
