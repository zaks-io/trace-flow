import * as Sentry from '@sentry/cloudflare';
import { TRACE_FLOW_PROPAGATION_TARGETS } from '@trace-flow/utils/sentry-tracing';
import { DurableObject } from 'cloudflare:workers';
import { axiomConfigFromEnv, createLogger } from '@trace-flow/logging';
import { insertRows } from '@trace-flow/tinybird-client';
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
// Agent dashboards do not need sub-minute ingest visibility; fewer larger inserts reduce part churn.
const FLUSH_INTERVAL_MS = 60_000;
const MAX_SQL_PARAMS = 90;
const MAX_INSERT_ROWS = Math.floor(MAX_SQL_PARAMS / 3);

export const AGENT_FACT_BATCHER_FLUSH_INTERVAL_MS = FLUSH_INTERVAL_MS;

type AddStatus = 'accepted' | 'failed';

interface AgentFactBatch {
  rows: Record<Category, unknown[]>;
  writeLegacy?: boolean;
}

interface AgentFactBatchResult {
  status: AddStatus;
  acceptedRows: number;
  duplicateRows: number;
  repairRows: number;
}

class AgentFactBatcherBase extends DurableObject<AgentConsumerEnv> {
  private queuedRows = 0;
  private flushAlarmScheduled = false;
  private flushInProgress = false;
  private logger = createLogger({
    service: 'agent-consumer',
    runtime: 'durable-object',
    axiom: axiomConfigFromEnv(this.env),
    context: { component: 'agent-fact-batcher' },
  });

  constructor(state: DurableObjectState, env: AgentConsumerEnv) {
    super(state, env);
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
    let legacyRows = 0;
    let duplicateRows = 0;
    let repairRows = 0;
    const now = Date.now();

    try {
      this.ctx.storage.transactionSync(() => {
        for (const category of CATEGORIES) {
          for (const row of batch.rows[category]) {
            const factId = rowIdentity(row, ROW_IDENTITY_FIELDS[category]);
            const contentHash = stableHash(row);
            const existing = [
              ...this.ctx.storage.sql.exec<{ content_hash: string }>(
                'SELECT content_hash FROM fact_ledger WHERE category = ? AND fact_id = ?',
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
              this.ctx.storage.sql.exec(
                `INSERT INTO fact_repairs (category, fact_id, old_hash, new_hash, seen_at_ms)
                 VALUES (?, ?, ?, ?, ?)`,
                category,
                factId,
                existing.content_hash,
                contentHash,
                now,
              );
              continue;
            }

            this.ctx.storage.sql.exec(
              `INSERT INTO fact_ledger (category, fact_id, content_hash, first_seen_at_ms)
               VALUES (?, ?, ?, ?)`,
              category,
              factId,
              contentHash,
              now,
            );
            const rowData = JSON.stringify(row);
            this.ctx.storage.sql.exec(
              `INSERT INTO pending_facts (category, data, created_at_ms)
               VALUES (?, ?, ?)`,
              category,
              rowData,
              now,
            );
            // Only mirror categories that have a legacy datasource. review_unit_attributions has
            // no legacy table, so a dual-mode row here would never be drained by flush() and would
            // wedge the pending count (and thus the flush alarm) forever.
            if (batch.writeLegacy && (LEGACY_CATEGORIES as Category[]).includes(category)) {
              this.ctx.storage.sql.exec(
                `INSERT INTO legacy_pending_facts (category, data, created_at_ms)
                 VALUES (?, ?, ?)`,
                category,
                rowData,
                now,
              );
              legacyRows++;
            }
            acceptedRows++;
          }
        }
      });

      this.queuedRows += acceptedRows + legacyRows;
      if (repairRows > 0) {
        this.logger.warn('agent_fact_batcher.repair_rows_detected', { repairRows });
      }

      if (this.queuedRows >= BATCH_SIZE) {
        await this.flush();
      } else if (this.queuedRows > 0) {
        await this.scheduleFlush();
      }

      return { status: 'accepted', acceptedRows, duplicateRows, repairRows };
    } catch (error) {
      this.logger.error('agent_fact_batcher.add_failed', error);
      Sentry.captureException(error, { tags: { operation: 'agent_fact_batcher.add' } });
      return { status: 'failed', acceptedRows, duplicateRows, repairRows };
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
        PRIMARY KEY (category, fact_id)
      )
    `);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS fact_repairs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        category TEXT NOT NULL,
        fact_id TEXT NOT NULL,
        old_hash TEXT NOT NULL,
        new_hash TEXT NOT NULL,
        seen_at_ms INTEGER NOT NULL
      )
    `);
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
    this.ensureColumn('pending_facts', 'sent_at_ms', 'INTEGER');
    this.ensureColumn('legacy_pending_facts', 'sent_at_ms', 'INTEGER');
    this.ctx.storage.sql.exec(
      'CREATE INDEX IF NOT EXISTS idx_pending_facts_category_id ON pending_facts(category, id)',
    );
    this.ctx.storage.sql.exec(
      'CREATE INDEX IF NOT EXISTS idx_legacy_pending_facts_category_id ON legacy_pending_facts(category, id)',
    );
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
          `SELECT COUNT(*) AS count FROM ${table} WHERE sent_at_ms IS NULL`,
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

    const rows = [
      ...this.ctx.storage.sql.exec<{ id: number; data: string }>(
        `SELECT id, data
         FROM ${table}
         WHERE category = ? AND sent_at_ms IS NULL
         ORDER BY id
         LIMIT ?`,
        category,
        BATCH_SIZE,
      ),
    ];
    if (rows.length === 0) {
      return;
    }

    const facts = rows.map((row) => normalizePendingFact(category, JSON.parse(row.data)));
    await insertRows(facts, this.env.TINYBIRD_TOKEN, datasource, this.env.TINYBIRD_HOST);

    const ids = rows.map((row) => row.id);
    this.markFactsSent(table, ids);
    this.deleteSentFacts(table, category);
  }

  private markFactsSent(table: 'pending_facts' | 'legacy_pending_facts', ids: number[]): void {
    const sentAt = Date.now();
    this.ctx.storage.transactionSync(() => {
      for (let i = 0; i < ids.length; i += MAX_INSERT_ROWS) {
        const chunk = ids.slice(i, i + MAX_INSERT_ROWS);
        this.ctx.storage.sql.exec(
          `UPDATE ${table}
           SET sent_at_ms = ?
           WHERE id IN (${chunk.map(() => '?').join(',')})`,
          sentAt,
          ...chunk,
        );
      }
    });
  }

  private deleteSentFacts(
    table: 'pending_facts' | 'legacy_pending_facts',
    category: Category,
  ): void {
    this.ctx.storage.sql.exec(
      `DELETE FROM ${table} WHERE category = ? AND sent_at_ms IS NOT NULL`,
      category,
    );
  }
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
