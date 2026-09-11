import * as Sentry from '@sentry/cloudflare';
import { TRACE_FLOW_PROPAGATION_TARGETS } from '@trace-flow/utils/sentry-tracing';
import { DurableObject } from 'cloudflare:workers';
import { axiomConfigFromEnv, createLogger } from '@trace-flow/logging';
import {
  classifyTinybirdInsertFailure,
  insertRows,
  requireRecoveryReason,
  serializeTinybirdFailure,
  TinybirdRecoveryStore,
  type ReconcileRecoveryInput,
  type RecoveryPage,
  type RecoveryPageOptions,
  type RecoveryRecord,
} from '@trace-flow/tinybird-client';
import type { AgentConsumerEnv } from './context';
import {
  AgentFactMaintenance,
  type BeginFactRebuildInput,
  type BeginFactRebuildResult,
  type CompleteFactRebuildInput,
  type CompleteFactRebuildResult,
  type ListRebuildFactsInput,
  type ListRebuildFactsResult,
} from './fact-maintenance';
import {
  CATEGORIES,
  DATASOURCES,
  LEGACY_CATEGORIES,
  LEGACY_DATASOURCES,
  MAX_FACT_INSERT_PARTITIONS,
  ROW_IDENTITY_FIELDS,
  compareFactIngestedAt,
  factIngestedAtMs,
  factPartitionKey,
  rowIdentity,
  stableHash,
  type Category,
} from './facts';
import { PendingFactStore } from './pending-fact-store';
import {
  FactRepairCapacity,
  type CompactFactRepairDuplicatesInput,
  type CompactFactRepairDuplicatesResult,
  type InspectFactRepairCapacityInput,
  type InspectFactRepairCapacityResult,
} from './fact-repair-capacity';

const BATCH_SIZE = 10_000;
const MAX_NDJSON_BYTES = 900_000;
// Agent dashboards do not need sub-minute ingest visibility; fewer larger inserts reduce part churn.
const FLUSH_INTERVAL_MS = 60_000;
const CAPPED_FLUSH_RETRY_MS = 1_000;
const MAX_SQL_PARAMS = 90;
const MAX_INSERT_ROWS = Math.floor(MAX_SQL_PARAMS / 3);
const MAX_FLUSH_CANDIDATES = 500;

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

interface StoredFactCandidate extends StoredFactRow {
  candidate_count: number;
}

class AgentFactBatcherBase extends DurableObject<AgentConsumerEnv> {
  private queuedRows = 0;
  private flushAlarmScheduled = false;
  private flushInProgress = false;
  private recovery: TinybirdRecoveryStore;
  private maintenance: AgentFactMaintenance;
  private pendingFacts: PendingFactStore;
  private repairCapacity: FactRepairCapacity;
  private startupRecoveryPending = true;
  private startupBlockedReason: string | null = null;
  private tinybirdTokenFingerprint = '';
  private logger = createLogger({
    service: 'agent-consumer',
    runtime: 'durable-object',
    axiom: axiomConfigFromEnv(this.env),
    context: { component: 'agent-fact-batcher' },
  });

  constructor(state: DurableObjectState, env: AgentConsumerEnv) {
    super(state, env);
    this.recovery = new TinybirdRecoveryStore(state.storage);
    this.maintenance = new AgentFactMaintenance(state.storage, this.recovery);
    this.pendingFacts = new PendingFactStore(state.storage, this.maintenance);
    this.repairCapacity = new FactRepairCapacity(state.storage, this.recovery, () =>
      this.maintenance.assertUnlocked(),
    );
    void this.ctx.blockConcurrencyWhile(async () => {
      if (!this.env.TINYBIRD_TOKEN) throw new Error('TINYBIRD_TOKEN is required');
      this.tinybirdTokenFingerprint = await sha256Hex(this.env.TINYBIRD_TOKEN);
      this.initializeSchema();
      this.queuedRows = this.countPendingRows();
      this.startupBlockedReason = await this.retryStartupState();
    });
  }

  async addFacts(batch: AgentFactBatch): Promise<AgentFactBatchResult> {
    let acceptedRows = 0;
    let duplicateRows = 0;
    let repairRows = 0;
    const repairs: {
      payload: string;
      outcome: string;
      dedupeKey: string;
      compactRepairId?: number;
      orgId: string;
    }[] = [];
    const now = Date.now();

    try {
      this.ensureStartupRecovery();
      this.maintenance.assertUnlocked();
      validateWriteTargets(batch);
      this.ctx.storage.transactionSync(() => {
        for (const category of CATEGORIES) {
          for (const row of batch.rows[category]) {
            const factId = rowIdentity(row, ROW_IDENTITY_FIELDS[category]);
            const contentHash = stableHash(row);
            const existing = [
              ...this.ctx.storage.sql.exec<{
                content_hash: string;
                data: string | null;
                clean_target: number | null;
                legacy_target: number | null;
              }>(
                `SELECT content_hash, data, clean_target, legacy_target
                 FROM fact_ledger WHERE category = ? AND fact_id = ?`,
                category,
                factId,
              ),
            ][0];
            const rowData = JSON.stringify(row);
            const existingPayload = existing
              ? this.maintenance.loadLedgerPayload(category, factId, existing.data)
              : null;

            if (existing?.content_hash === contentHash) {
              if (existingPayload === null) {
                this.maintenance.storeLedgerPayload(category, factId, rowData);
              } else if (!this.flushInProgress) {
                const coalesced = this.pendingFacts.coalesce(
                  category,
                  factId,
                  contentHash,
                  rowData,
                  existingPayload,
                  existing.clean_target,
                  existing.legacy_target,
                );
                if (
                  coalesced === 'unavailable' &&
                  compareFactIngestedAt(row, JSON.parse(existingPayload)) >= 0
                ) {
                  this.maintenance.storeLedgerPayload(category, factId, rowData);
                }
              } else if (compareFactIngestedAt(row, JSON.parse(existingPayload)) >= 0) {
                this.maintenance.storeLedgerPayload(category, factId, rowData);
              }
              duplicateRows++;
              continue;
            }

            if (existing) {
              if (!this.flushInProgress && existingPayload !== null) {
                const coalesced = this.pendingFacts.coalesce(
                  category,
                  factId,
                  contentHash,
                  rowData,
                  existingPayload,
                  existing.clean_target,
                  existing.legacy_target,
                );
                if (coalesced !== 'unavailable') {
                  if (coalesced === 'updated') acceptedRows++;
                  else duplicateRows++;
                  continue;
                }
              }
              repairRows++;
              const legacyRepairDedupeKey = JSON.stringify([
                category,
                factId,
                existing.content_hash,
                contentHash,
              ]);
              const repairDedupeKey = JSON.stringify([
                category,
                factId,
                existing.content_hash,
                contentHash,
                factIngestedAtMs(row),
              ]);
              const legacyRepair = [
                ...this.ctx.storage.sql.exec<{ data: string | null }>(
                  `SELECT data FROM fact_repairs
                   WHERE category = ? AND fact_id = ? AND old_hash = ? AND new_hash = ?
                     AND recovery_dedupe_key IS NULL LIMIT 1`,
                  category,
                  factId,
                  existing.content_hash,
                  contentHash,
                ),
              ][0];
              const dedupeKey =
                legacyRepair?.data &&
                compareFactIngestedAt(row, JSON.parse(legacyRepair.data)) === 0
                  ? legacyRepairDedupeKey
                  : repairDedupeKey;
              const priorRepair = [
                ...this.ctx.storage.sql.exec<{ id: number; data: string | null }>(
                  `SELECT id, data FROM fact_repairs
                   WHERE category = ? AND fact_id = ? AND old_hash = ? AND new_hash = ?
                     AND recovery_dedupe_key = ? LIMIT 1`,
                  category,
                  factId,
                  existing.content_hash,
                  contentHash,
                  dedupeKey,
                ),
              ][0];
              let compactRepairId = priorRepair?.data ? priorRepair.id : undefined;
              if (!priorRepair && dedupeKey !== legacyRepairDedupeKey) {
                const storedRepairPayload = inlinePayload(rowData);
                this.ctx.storage.sql.exec(
                  `INSERT INTO fact_repairs
                   (category, fact_id, old_hash, new_hash, seen_at_ms, data, recovery_dedupe_key)
                   VALUES (?, ?, ?, ?, ?, ?, ?)`,
                  category,
                  factId,
                  existing.content_hash,
                  contentHash,
                  now,
                  storedRepairPayload,
                  dedupeKey,
                );
                if (storedRepairPayload) {
                  compactRepairId = this.ctx.storage.sql
                    .exec<{ id: number }>('SELECT last_insert_rowid() AS id')
                    .one().id;
                }
              }
              if (!isRecord(row) || typeof row.OrgId !== 'string') {
                throw new Error('repair fact has no organization');
              }
              repairs.push({
                payload: rowData,
                outcome: JSON.stringify({
                  category,
                  factId,
                  oldHash: existing.content_hash,
                  newHash: contentHash,
                  originalPayload: existingPayload,
                }),
                dedupeKey,
                compactRepairId,
                orgId: row.OrgId,
              });
              continue;
            }

            this.ctx.storage.sql.exec(
              `INSERT INTO fact_ledger
               (category, fact_id, content_hash, first_seen_at_ms, data, clean_target, legacy_target)
               VALUES (?, ?, ?, ?, ?, ?, ?)`,
              category,
              factId,
              contentHash,
              now,
              '',
              batch.writeClean === false ? 0 : 1,
              batch.writeLegacy && (LEGACY_CATEGORIES as Category[]).includes(category) ? 1 : 0,
            );
            this.maintenance.storeLedgerPayload(category, factId, rowData);
            if (batch.writeClean !== false) {
              this.pendingFacts.insert(
                'pending_facts',
                category,
                factId,
                contentHash,
                rowData,
                now,
              );
            }
            // Only mirror categories that have a legacy datasource. review_unit_attributions has
            // no legacy table, so a dual-mode row here would never be drained by flush() and would
            // wedge the pending count (and thus the flush alarm) forever.
            if (batch.writeLegacy && (LEGACY_CATEGORIES as Category[]).includes(category)) {
              this.pendingFacts.insert(
                'legacy_pending_facts',
                category,
                factId,
                contentHash,
                rowData,
                now,
              );
            }
            acceptedRows++;
          }
        }
      });

      for (const repair of repairs) {
        const preserved = this.recovery.preserveRepair(
          repair.payload,
          repair.outcome,
          repair.dedupeKey,
        );
        if (repair.compactRepairId !== undefined) {
          try {
            this.repairCapacity.compactPreservedRepair(
              repair.compactRepairId,
              repair.orgId,
              preserved,
            );
          } catch (error) {
            this.logger.error('agent_fact_batcher.repair_compaction_failed', error, {
              repairId: repair.compactRepairId,
            });
            Sentry.captureException(error, {
              tags: { operation: 'agent_fact_batcher.repair_compaction' },
              extra: { repairId: repair.compactRepairId },
            });
          }
        }
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
    this.ensureStartupRecovery();
    this.flushAlarmScheduled = false;
    if (this.maintenance.isLocked()) return;
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
    this.ensureColumn('fact_ledger', 'clean_target', 'INTEGER');
    this.ensureColumn('fact_ledger', 'legacy_target', 'INTEGER');
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
    this.ensureColumn('fact_repairs', 'recovery_dedupe_key', 'TEXT');
    this.ctx.storage.sql.exec(
      `CREATE INDEX IF NOT EXISTS idx_fact_repairs_lookup
       ON fact_repairs(category, fact_id, old_hash, new_hash)`,
    );
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
    this.ensureColumn('pending_facts', 'fact_id', 'TEXT');
    this.ensureColumn('pending_facts', 'content_hash', 'TEXT');
    this.ensureColumn('legacy_pending_facts', 'fact_id', 'TEXT');
    this.ensureColumn('legacy_pending_facts', 'content_hash', 'TEXT');
    this.ctx.storage.sql.exec(
      'CREATE INDEX IF NOT EXISTS idx_pending_facts_category_id ON pending_facts(category, id)',
    );
    this.ctx.storage.sql.exec(
      'CREATE INDEX IF NOT EXISTS idx_legacy_pending_facts_category_id ON legacy_pending_facts(category, id)',
    );
    this.ctx.storage.sql.exec(
      `CREATE INDEX IF NOT EXISTS idx_pending_facts_identity
       ON pending_facts(category, fact_id, id)`,
    );
    this.ctx.storage.sql.exec(
      `CREATE INDEX IF NOT EXISTS idx_legacy_pending_facts_identity
       ON legacy_pending_facts(category, fact_id, id)`,
    );
    this.recovery.initializeSchema();
    this.maintenance.initialize();
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

  private async scheduleFlush(delayMs = FLUSH_INTERVAL_MS): Promise<void> {
    if (this.maintenance.isLocked()) return;
    const alarmAt = Date.now() + delayMs;
    if (this.flushAlarmScheduled) {
      const currentAlarm = await this.ctx.storage.getAlarm();
      if (currentAlarm !== null && currentAlarm <= alarmAt) return;
    }
    await this.ctx.storage.setAlarm(alarmAt);
    this.flushAlarmScheduled = true;
  }

  private async flush(): Promise<void> {
    if (this.flushInProgress || this.queuedRows === 0 || this.maintenance.isLocked()) {
      return;
    }

    this.flushInProgress = true;
    let eligibleRowsRemain = false;
    let flushCompleted = false;
    try {
      for (const category of CATEGORIES) {
        if (this.maintenance.isLocked()) break;
        eligibleRowsRemain =
          (await this.flushCategory('pending_facts', DATASOURCES[category], category)) ||
          eligibleRowsRemain;
      }
      for (const category of LEGACY_CATEGORIES) {
        if (this.maintenance.isLocked()) break;
        eligibleRowsRemain =
          (await this.flushCategory(
            'legacy_pending_facts',
            LEGACY_DATASOURCES[category],
            category,
          )) || eligibleRowsRemain;
      }
      flushCompleted = true;
    } finally {
      this.queuedRows = this.countPendingRows();
      this.flushInProgress = false;
      if (this.queuedRows > 0 && !this.maintenance.isLocked()) {
        await this.scheduleFlush(
          flushCompleted && eligibleRowsRemain ? CAPPED_FLUSH_RETRY_MS : FLUSH_INTERVAL_MS,
        );
      }
      await this.logger.flush();
    }
  }

  private async flushCategory(
    table: 'pending_facts' | 'legacy_pending_facts',
    datasource: string,
    category: Category,
  ): Promise<boolean> {
    this.deleteSentFacts(table, category);

    const targetKey = `${table}:${category}`;
    const rows = [
      ...this.ctx.storage.sql.exec<StoredFactCandidate>(
        `WITH candidates AS (
           SELECT id, data, ROW_NUMBER() OVER (ORDER BY id) AS row_number,
             COUNT(*) OVER () AS candidate_count,
             SUM(CASE WHEN data = '' THEN ? ELSE length(CAST(data AS BLOB)) + 1 END)
               OVER (ORDER BY id) AS cumulative_bytes
           FROM (
             SELECT id, data FROM ${table} AS p
             WHERE category = ? AND sent_at_ms IS NULL
               AND NOT EXISTS (
                 SELECT 1 FROM recovery_items AS i JOIN recovery_records AS r ON r.id = i.recovery_id
                 WHERE i.row_id = p.id AND i.target_key = ?
                   AND r.state IN ('in_flight', 'blocked')
               )
             ORDER BY id LIMIT ?
           )
         )
         SELECT id, data, candidate_count FROM candidates
         WHERE row_number = 1 OR cumulative_bytes <= ? ORDER BY id`,
        MAX_NDJSON_BYTES + 1,
        category,
        targetKey,
        MAX_FLUSH_CANDIDATES,
        MAX_NDJSON_BYTES,
      ),
    ].map((row) => ({ ...row, data: this.loadFactData(table, row.id, row.data) }));
    const candidateCount = rows[0]?.candidate_count ?? 0;
    const eligibleRowsRemain =
      candidateCount === MAX_FLUSH_CANDIDATES || candidateCount > rows.length;
    for (const batch of splitRowsByBytes(rows)) {
      if (this.maintenance.isLocked()) return eligibleRowsRemain;
      await this.sendFactBatch(table, datasource, category, targetKey, batch);
    }
    this.deleteSentFacts(table, category);
    return eligibleRowsRemain;
  }

  private async sendFactBatch(
    table: 'pending_facts' | 'legacy_pending_facts',
    datasource: string,
    category: Category,
    targetKey: string,
    rows: StoredFactRow[],
  ): Promise<void> {
    if (rows.length === 0 || this.maintenance.isLocked()) return;
    const rowIds = rows.map((row) => row.id);
    let facts: unknown[];
    let partitionBatches: StoredFactRow[][];
    try {
      facts = rows.map((row) => normalizePendingFact(category, JSON.parse(row.data)));
      partitionBatches = splitRowsByPartitions(rows, facts, category);
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

    if (partitionBatches.length > 1) {
      for (const batch of partitionBatches) {
        await this.sendFactBatch(table, datasource, category, targetKey, batch);
      }
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
    this.ensureStartupRecovery();
    return {
      queuedRows: this.queuedRows,
      blockedRecoveryRows: this.recovery.countBlockedRows(),
      blockedRecoveryRecords: this.recovery.countBlockedRecords(),
    };
  }

  inspectFactRepairCapacity(
    orgId: string,
    input: InspectFactRepairCapacityInput,
  ): Promise<InspectFactRepairCapacityResult> {
    return this.repairCapacity.inspect(orgId, input, this.startupBlockedReason);
  }

  async compactFactRepairDuplicates(
    orgId: string,
    input: CompactFactRepairDuplicatesInput,
  ): Promise<CompactFactRepairDuplicatesResult> {
    this.maintenance.assertUnlocked();
    const result = await this.repairCapacity.compact(orgId, input);
    this.startupBlockedReason = await this.retryStartupState();
    result.startupBlockedReason = this.startupBlockedReason;
    return result;
  }

  listRecovery(options: RecoveryPageOptions = {}): RecoveryPage {
    this.ensureStartupRecovery();
    return this.recovery.list(options);
  }

  getRecovery(recoveryId: number): RecoveryRecord {
    this.ensureStartupRecovery();
    return this.recovery.get(recoveryId);
  }

  async reconcileRecovery(input: ReconcileRecoveryInput): Promise<RecoveryRecord> {
    this.ensureStartupRecovery();
    this.maintenance.assertUnlocked();
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
    this.ensureStartupRecovery();
    return this.recovery.preserveDlq(payload, outcome, dedupeKey);
  }

  resolveDlq(recoveryId: number, reason: string): RecoveryRecord {
    this.ensureStartupRecovery();
    this.maintenance.assertUnlocked();
    const record = this.recovery.get(recoveryId);
    if (record.kind !== 'dlq') throw new Error('recovery record is not a DLQ message');
    return this.recovery.resolve(recoveryId, 'replayed', reason);
  }

  assertFactMaintenanceUnlocked(): void {
    this.ensureStartupRecovery();
    this.maintenance.assertUnlocked();
  }

  async beginFactRebuild(
    orgId: string,
    input: BeginFactRebuildInput,
  ): Promise<BeginFactRebuildResult> {
    this.ensureStartupRecovery();
    const operation = this.maintenance.begin(orgId, input, {
      tokenFingerprint: this.tinybirdTokenFingerprint,
      host: this.env.TINYBIRD_HOST,
    });
    if (operation.completed) {
      return {
        operationId: operation.operationId,
        reason: operation.reason,
        startedAtMs: operation.startedAtMs,
        expectedFactCount: operation.expectedFactCount,
        tinybirdTokenFingerprint: operation.tinybirdTokenFingerprint,
        tinybirdWorkspaceId: operation.tinybirdWorkspaceId,
        tinybirdHost: operation.tinybirdHost,
        status: 'completed',
      };
    }
    await this.ctx.storage.deleteAlarm();
    this.flushAlarmScheduled = false;
    return {
      operationId: operation.operationId,
      reason: operation.reason,
      startedAtMs: operation.startedAtMs,
      expectedFactCount: operation.expectedFactCount,
      tinybirdTokenFingerprint: operation.tinybirdTokenFingerprint,
      tinybirdWorkspaceId: operation.tinybirdWorkspaceId,
      tinybirdHost: operation.tinybirdHost,
      status: this.flushInProgress ? 'retry-needed' : 'quiescent',
    };
  }

  listRebuildFacts(input: ListRebuildFactsInput): ListRebuildFactsResult {
    this.ensureStartupRecovery();
    return this.maintenance.list(input);
  }

  async completeFactRebuild(input: CompleteFactRebuildInput): Promise<CompleteFactRebuildResult> {
    this.ensureStartupRecovery();
    const result = await this.maintenance.complete(input);
    this.queuedRows = this.countPendingRows();
    return result;
  }

  private async retryStartupState(): Promise<string | null> {
    try {
      this.ensureStartupRecovery();
      if (this.queuedRows > 0 && !this.maintenance.isLocked()) {
        const alarm = await this.ctx.storage.getAlarm();
        if (!this.maintenance.isLocked() && alarm === null) {
          await this.ctx.storage.setAlarm(Date.now() + 1000);
        }
        this.flushAlarmScheduled = !this.maintenance.isLocked();
      }
      return null;
    } catch (error) {
      const reason = errorMessage(error);
      if (!isDatabaseCapacityError(reason)) throw error;
      return reason;
    }
  }

  private ensureStartupRecovery(): void {
    if (!this.startupRecoveryPending) return;
    this.recovery.recoverInterrupted();
    this.startupRecoveryPending = false;
  }
}

function isDatabaseCapacityError(reason: string): boolean {
  return reason.includes('SQLITE_FULL') || reason.includes('Exceeded the maximum database size.');
}

async function sha256Hex(value: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)),
  );
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
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

function splitRowsByPartitions(
  rows: StoredFactRow[],
  facts: unknown[],
  category: Category,
): StoredFactRow[][] {
  const batches: StoredFactRow[][] = [];
  let current: StoredFactRow[] = [];
  let partitions = new Set<string>();
  for (let index = 0; index < rows.length; index++) {
    const partition = factPartitionKey(category, facts[index]);
    if (
      current.length > 0 &&
      !partitions.has(partition) &&
      partitions.size >= MAX_FACT_INSERT_PARTITIONS
    ) {
      batches.push(current);
      current = [];
      partitions = new Set();
    }
    current.push(rows[index]!);
    partitions.add(partition);
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : `non-Error value: ${String(error)}`;
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
