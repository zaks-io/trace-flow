import { DurableObject } from 'cloudflare:workers';
import type { TinybirdTrace } from '@observe/types';
import type { Env } from './index';
import { insertIntoTinybirdWithRetry } from './tinybird';

const BATCH_SIZE = 10_000;
const FLUSH_INTERVAL_MS = 5000;
const MAX_JITTER_MS = 1000;

export class TraceBatcher extends DurableObject<Env> {
  private lastFlushTime: number = Date.now();
  private flushAlarmScheduled = false;
  private durableState: DurableObjectState;
  private traceCount = 0;

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.durableState = state;

    this.initializeSchema();

    const result = this.durableState.storage.sql.exec<{ last_flush_time: number }>(
      'SELECT last_flush_time FROM metadata WHERE id = 1',
    );
    const rows = [...result];
    if (rows.length > 0 && rows[0]) {
      this.lastFlushTime = rows[0].last_flush_time;
    }

    const countResult = this.durableState.storage.sql.exec<{ count: number }>(
      'SELECT COUNT(*) as count FROM traces',
    );
    const countRows = [...countResult];
    if (countRows.length > 0 && countRows[0]) {
      this.traceCount = countRows[0].count;
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
      CREATE TABLE IF NOT EXISTS metadata (
        id INTEGER PRIMARY KEY,
        last_flush_time INTEGER NOT NULL
      )
    `);

    const metadataExists = [
      ...this.durableState.storage.sql.exec<{ count: number }>(
        'SELECT COUNT(*) as count FROM metadata WHERE id = 1',
      ),
    ];

    if (metadataExists[0]?.count === 0) {
      this.durableState.storage.sql.exec(
        'INSERT INTO metadata (id, last_flush_time) VALUES (1, ?)',
        Date.now(),
      );
    }
  }

  async addTraces(traces: TinybirdTrace[]): Promise<void> {
    if (traces.length === 0) {
      return;
    }

    const timestamp = Date.now();

    const values = traces.map(() => '(?, ?)').join(', ');
    const params = traces.flatMap((trace) => [JSON.stringify(trace), timestamp]);

    this.durableState.storage.sql.exec(
      `INSERT INTO traces (data, timestamp) VALUES ${values}`,
      ...params,
    );

    this.traceCount += traces.length;

    if (this.traceCount >= BATCH_SIZE) {
      await this.flush();
    } else {
      // Check storage for existing alarm (in-memory flag resets on hibernation)
      const currentAlarm = await this.durableState.storage.getAlarm();
      if (!currentAlarm) {
        await this.scheduleFlush();
      }
    }
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

    await this.durableState.storage.setAlarm(Date.now() + delay);
    this.flushAlarmScheduled = true;
  }

  private async flush(): Promise<void> {
    if (this.traceCount === 0) {
      return;
    }

    const batchCount = Math.ceil(this.traceCount / BATCH_SIZE);
    console.log(`Flushing ${this.traceCount} traces in ${batchCount} batch(es)`);

    let totalFlushed = 0;

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
        const host = this.env.TINYBIRD_HOST ?? 'https://api.tinybird.co';
        await insertIntoTinybirdWithRetry(traces, this.env.TINYBIRD_TOKEN, datasource, host);

        this.durableState.storage.sql.exec(
          `DELETE FROM traces WHERE id IN (${ids.map(() => '?').join(',')})`,
          ...ids,
        );

        this.traceCount -= traces.length;
        totalFlushed += traces.length;
      } catch (error) {
        console.error('Failed to insert batch after retries:', {
          batchSize: traces.length,
          error: error instanceof Error ? error.message : String(error),
        });
        break;
      }
    }

    console.log(`Total flushed: ${totalFlushed} traces (remaining: ${this.traceCount})`);

    this.lastFlushTime = Date.now();
    this.updateLastFlushTime();

    if (this.flushAlarmScheduled) {
      void this.durableState.storage.deleteAlarm();
      this.flushAlarmScheduled = false;
    }
  }

  private updateLastFlushTime(): void {
    this.durableState.storage.sql.exec(
      'UPDATE metadata SET last_flush_time = ? WHERE id = 1',
      this.lastFlushTime,
    );
  }

  getStats(): { queuedTraces: number; lastFlushTime: number } {
    return {
      queuedTraces: this.traceCount,
      lastFlushTime: this.lastFlushTime,
    };
  }
}
