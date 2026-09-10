import { requireRecoveryReason, splitUtf8Chunks } from '@trace-flow/tinybird-client';
import type { TinybirdRecoveryStore } from '@trace-flow/tinybird-client';
import type { DurableObjectStorage } from '@cloudflare/workers-types';
import { CATEGORIES, ROW_IDENTITY_FIELDS, rowIdentity, stableHash, type Category } from './facts';
import { backfillPendingFactIdentities } from './fact-pending-migration';
import type {
  BeginFactRebuildInput,
  BeginFactRebuildResult,
  CompleteFactRebuildInput,
  CompleteFactRebuildResult,
  FactRebuildConfirmation,
  FactRecoveryConfirmation,
  FinalizeFactRebuildInput,
  ListRebuildFactsInput,
  ListRebuildFactsResult,
  RebuildFact,
  RebuildFactCursor,
  StageFactRebuildInput,
} from './fact-maintenance-contract';

export type {
  BeginFactRebuildInput,
  BeginFactRebuildResult,
  CompleteFactRebuildInput,
  CompleteFactRebuildResult,
  FactRebuildConfirmation,
  FactRecoveryConfirmation,
  FinalizeFactRebuildInput,
  ListRebuildFactsInput,
  ListRebuildFactsResult,
  RebuildFact,
  RebuildFactCursor,
  RebuildPendingFact,
  StageFactRebuildInput,
} from './fact-maintenance-contract';

const PAYLOAD_CHUNK_BYTES = 900_000;
const MAX_PAGE_ROWS = 100;
const MAX_OPERATION_ID_LENGTH = 128;
const MAX_TOKEN_FINGERPRINTS = 1024;
const PENDING_TABLES = ['pending_facts', 'legacy_pending_facts'] as const;

type PendingTable = (typeof PENDING_TABLES)[number];

interface StoredOperation {
  [key: string]: string | number | null;
  operation_id: string;
  executor_id: string | null;
  tinybird_token_fingerprint: string | null;
  tinybird_workspace_id: string | null;
  tinybird_host: string | null;
  org_id: string;
  reason: string;
  state: 'active' | 'completed';
  started_at_ms: number;
  expected_fact_count: number;
  confirmed_fact_count: number;
  completed_at_ms: number | null;
  completion_reason: string | null;
  backup_sha256: string | null;
  canonical_fingerprint: string | null;
  legacy_fingerprint: string | null;
}

export interface FactRebuildTarget {
  tokenFingerprint: string;
  host: string;
}

type ValidatedFactRebuildTarget = FactRebuildTarget & { workspaceId: string };

interface StoredLedgerFact {
  [key: string]: string;
  category: Category;
  fact_id: string;
  content_hash: string;
  data: string;
}

type StoredLedgerFactMetadata = Pick<StoredLedgerFact, 'category' | 'fact_id' | 'content_hash'>;

interface StoredPendingFact {
  [key: string]: string | number | null;
  id: number;
  content_hash: string | null;
  data: string;
}

interface StoredRepairFallback {
  [key: string]: string | number | null;
  old_hash: string;
  new_hash: string;
  data: string | null;
  recovery_dedupe_key: string | null;
}

type PreparedConfirmation = FactRebuildConfirmation & { rowData: string; rowSha256: string };

export class AgentFactMaintenance {
  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly recovery: TinybirdRecoveryStore,
  ) {}

  initialize(): void {
    this.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS fact_ledger_payload_chunks (
        category TEXT NOT NULL,
        fact_id TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        data TEXT NOT NULL,
        PRIMARY KEY (category, fact_id, chunk_index)
      )
    `);
    this.storage.sql.exec(
      `CREATE INDEX IF NOT EXISTS idx_fact_ledger_missing_payload
       ON fact_ledger(category, fact_id) WHERE data IS NULL OR data = ''`,
    );
    this.storage.sql.exec(
      `CREATE INDEX IF NOT EXISTS idx_fact_repairs_rebuild_fallback
       ON fact_repairs(category, fact_id, old_hash, id DESC)`,
    );
    this.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS fact_rebuild_operations (
        operation_id TEXT PRIMARY KEY,
        executor_id TEXT NOT NULL,
        tinybird_token_fingerprint TEXT NOT NULL,
        tinybird_workspace_id TEXT NOT NULL,
        tinybird_host TEXT NOT NULL,
        org_id TEXT NOT NULL,
        reason TEXT NOT NULL,
        state TEXT NOT NULL,
        started_at_ms INTEGER NOT NULL,
        expected_fact_count INTEGER NOT NULL,
        confirmed_fact_count INTEGER NOT NULL DEFAULT 0,
        completed_at_ms INTEGER,
        completion_reason TEXT,
        backup_sha256 TEXT,
        canonical_fingerprint TEXT,
        legacy_fingerprint TEXT
      )
    `);
    this.ensureColumn('fact_rebuild_operations', 'executor_id', 'TEXT');
    this.ensureColumn('fact_rebuild_operations', 'tinybird_token_fingerprint', 'TEXT');
    this.ensureColumn('fact_rebuild_operations', 'tinybird_workspace_id', 'TEXT');
    this.ensureColumn('fact_rebuild_operations', 'tinybird_host', 'TEXT');
    const addedConfirmationCount = this.ensureColumn(
      'fact_rebuild_operations',
      'confirmed_fact_count',
      'INTEGER NOT NULL DEFAULT 0',
    );
    this.storage.sql.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_fact_rebuild_active
       ON fact_rebuild_operations(state) WHERE state = 'active'`,
    );
    this.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS fact_rebuild_confirmations (
        operation_id TEXT NOT NULL,
        category TEXT NOT NULL,
        fact_id TEXT NOT NULL,
        expected_old_hash TEXT NOT NULL,
        new_hash TEXT NOT NULL,
        row_sha256 TEXT NOT NULL,
        confirmed_at_ms INTEGER NOT NULL,
        PRIMARY KEY (operation_id, category, fact_id)
      )
    `);
    if (addedConfirmationCount) {
      this.storage.sql.exec(
        `UPDATE fact_rebuild_operations SET confirmed_fact_count = (
           SELECT COUNT(*) FROM fact_rebuild_confirmations AS confirmations
           WHERE confirmations.operation_id = fact_rebuild_operations.operation_id
         )`,
      );
    }
  }

  isLocked(): boolean {
    return this.activeOperation() !== undefined;
  }

  assertUnlocked(): void {
    if (this.isLocked()) throw new Error('fact rebuild is active; retry this operation later');
  }

  begin(
    orgId: string,
    input: BeginFactRebuildInput,
    target: FactRebuildTarget,
  ): Omit<BeginFactRebuildResult, 'status'> & {
    completed: boolean;
  } {
    const operationId = validateOperationId(input.operationId);
    const executorId = validateExecutorId(input.executorId);
    const reason = requireRecoveryReason(input.reason);
    const validatedTarget = validateTarget(
      input.tinybirdWorkspaceId,
      input.tinybirdTokenFingerprints,
      target,
    );
    const existing = this.operation(operationId);
    if (existing) {
      if (existing.org_id !== orgId) throw new Error('fact rebuild organization does not match');
      if (existing.executor_id !== executorId)
        throw new Error('fact rebuild executor does not match');
      if (
        existing.tinybird_workspace_id !== validatedTarget.workspaceId ||
        existing.tinybird_host !== validatedTarget.host
      ) {
        throw new Error('fact rebuild Tinybird target does not match');
      }
      if (existing.reason !== reason) throw new Error('fact rebuild reason does not match');
      if (existing.tinybird_token_fingerprint !== validatedTarget.tokenFingerprint) {
        this.storage.sql.exec(
          `UPDATE fact_rebuild_operations SET tinybird_token_fingerprint = ?
           WHERE operation_id = ?`,
          validatedTarget.tokenFingerprint,
          operationId,
        );
        existing.tinybird_token_fingerprint = validatedTarget.tokenFingerprint;
      }
      return operationResult(existing);
    }
    const active = this.activeOperation();
    if (active) throw new Error(`fact rebuild ${active.operation_id} is already active`);
    for (const row of this.missingLedgerPayloads()) {
      if (!this.replacementFor(row, orgId)) {
        throw new Error(
          'fact rebuild ledger payload is missing; replay the collector before beginning maintenance',
        );
      }
    }
    backfillPendingFactIdentities(this.storage, orgId);
    const expectedFactCount = this.storage.sql
      .exec<{ count: number }>('SELECT COUNT(*) AS count FROM fact_ledger')
      .one().count;
    const startedAtMs = Date.now();
    this.storage.sql.exec(
      `INSERT INTO fact_rebuild_operations
       (operation_id, executor_id, tinybird_token_fingerprint, tinybird_workspace_id, tinybird_host,
        org_id, reason, state, started_at_ms, expected_fact_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      operationId,
      executorId,
      validatedTarget.tokenFingerprint,
      validatedTarget.workspaceId,
      validatedTarget.host,
      orgId,
      reason,
      startedAtMs,
      expectedFactCount,
    );
    return {
      operationId,
      reason,
      startedAtMs,
      expectedFactCount,
      tinybirdTokenFingerprint: validatedTarget.tokenFingerprint,
      tinybirdWorkspaceId: validatedTarget.workspaceId,
      tinybirdHost: validatedTarget.host,
      completed: false,
    };
  }

  list(input: ListRebuildFactsInput): ListRebuildFactsResult {
    const operation = this.requireActive(input.operationId, input.executorId);
    const limit = validateLimit(input.limit);
    const after = validateCursor(input.after);
    const rows = [
      ...this.storage.sql.exec<StoredLedgerFactMetadata>(
        `SELECT category, fact_id, content_hash
         FROM fact_ledger
         WHERE (category, fact_id) > (?, ?)
         ORDER BY category, fact_id LIMIT ?`,
        after?.category ?? '',
        after?.factId ?? '',
        limit + 1,
      ),
    ];
    const facts: RebuildFact[] = [];
    let pageBytes = 64;
    for (const row of rows.slice(0, limit)) {
      const fact = this.rebuildFact(row, operation.org_id);
      const factBytes = utf8Bytes(JSON.stringify(fact));
      if (facts.length > 0 && pageBytes + factBytes > PAYLOAD_CHUNK_BYTES) break;
      facts.push(fact);
      pageBytes += factBytes + 1;
    }
    const last = facts[facts.length - 1];
    const hasMore = rows.some(
      (row) =>
        !last ||
        row.category > last.category ||
        (row.category === last.category && row.fact_id > last.factId),
    );
    const nextAfter = hasMore && last ? { category: last.category, factId: last.factId } : null;
    const result = { facts, nextAfter, serializedBytes: 0 };
    let measured = -1;
    while (result.serializedBytes !== measured) {
      measured = result.serializedBytes;
      result.serializedBytes = utf8Bytes(JSON.stringify(result));
    }
    return result;
  }

  async complete(input: CompleteFactRebuildInput): Promise<CompleteFactRebuildResult> {
    return input.phase === 'stage' ? await this.stage(input) : this.finalize(input);
  }

  storeLedgerPayload(category: Category, factId: string, payload: string): void {
    this.storage.sql.exec(
      'DELETE FROM fact_ledger_payload_chunks WHERE category = ? AND fact_id = ?',
      category,
      factId,
    );
    const oversized = utf8Bytes(payload) > PAYLOAD_CHUNK_BYTES;
    this.storage.sql.exec(
      'UPDATE fact_ledger SET data = ? WHERE category = ? AND fact_id = ?',
      oversized ? '' : payload,
      category,
      factId,
    );
    if (!oversized) return;
    for (const [index, chunk] of splitUtf8Chunks(payload, PAYLOAD_CHUNK_BYTES).entries()) {
      this.storage.sql.exec(
        `INSERT INTO fact_ledger_payload_chunks (category, fact_id, chunk_index, data)
         VALUES (?, ?, ?, ?)`,
        category,
        factId,
        index,
        chunk,
      );
    }
  }

  loadLedgerPayload(category: Category, factId: string, fallback: string | null): string | null {
    if (fallback) return fallback;
    const chunks = [
      ...this.storage.sql.exec<{ data: string }>(
        `SELECT data FROM fact_ledger_payload_chunks
         WHERE category = ? AND fact_id = ? ORDER BY chunk_index`,
        category,
        factId,
      ),
    ];
    return chunks.length > 0 ? chunks.map((chunk) => chunk.data).join('') : null;
  }

  private async stage(input: StageFactRebuildInput): Promise<CompleteFactRebuildResult> {
    const reason = requireRecoveryReason(input.reason);
    const initialOperation = this.requireActive(input.operationId, input.executorId);
    requireOperationReason(initialOperation, reason);
    validateBoundedConfirmations(input);
    const confirmations = await Promise.all(
      input.confirmations.map((confirmation) => this.prepareConfirmation(confirmation)),
    );
    let newlyConfirmed = 0;
    let operation!: StoredOperation;
    this.storage.transactionSync(() => {
      operation = this.requireActive(input.operationId, input.executorId);
      requireOperationReason(operation, reason);
      for (const confirmation of confirmations) {
        this.validateConfirmation(operation, confirmation);
        if (this.persistConfirmation(operation, confirmation)) newlyConfirmed++;
      }
      if (newlyConfirmed > 0) {
        this.storage.sql.exec(
          `UPDATE fact_rebuild_operations
           SET confirmed_fact_count = confirmed_fact_count + ?
           WHERE operation_id = ? AND state = 'active'`,
          newlyConfirmed,
          operation.operation_id,
        );
      }
    });
    operation.confirmed_fact_count += newlyConfirmed;
    const resolvedRepairRecords = this.resolveRepairs(
      operation,
      input.repairRecoveryConfirmations ?? [],
      reason,
    );
    const resolvedInsertRecords = this.resolveInserts(
      operation,
      input.insertRecoveryConfirmations ?? [],
      reason,
    );
    return {
      status: 'staged',
      operationId: operation.operation_id,
      confirmedFactCount: operation.confirmed_fact_count,
      expectedFactCount: operation.expected_fact_count,
      resolvedRepairRecords,
      resolvedInsertRecords,
    };
  }

  private finalize(input: FinalizeFactRebuildInput): CompleteFactRebuildResult {
    const operationId = validateOperationId(input.operationId);
    const executorId = validateExecutorId(input.executorId);
    const reason = requireRecoveryReason(input.reason);
    validateProof(input.proof);
    const stored = this.operation(operationId);
    if (!stored) throw new Error('fact rebuild operation not found');
    if (stored.executor_id !== executorId) throw new Error('fact rebuild executor does not match');
    requireOperationReason(stored, reason);
    if (stored.state === 'completed') {
      if (
        stored.completion_reason !== reason ||
        stored.backup_sha256 !== input.proof.backupSha256 ||
        stored.canonical_fingerprint !== input.proof.canonicalFingerprint ||
        stored.legacy_fingerprint !== input.proof.legacyFingerprint
      ) {
        throw new Error('fact rebuild completion proof does not match');
      }
      return completedResult(stored);
    }
    const active = this.requireActive(operationId, executorId);
    const confirmedFactCount = this.confirmedCount(operationId);
    if (confirmedFactCount !== active.expected_fact_count) {
      throw new Error(
        `fact rebuild has ${confirmedFactCount} confirmations; expected ${active.expected_fact_count}`,
      );
    }
    const currentFactCount = this.storage.sql
      .exec<{ count: number }>('SELECT COUNT(*) AS count FROM fact_ledger')
      .one().count;
    if (currentFactCount !== active.expected_fact_count)
      throw new Error('fact ledger changed during rebuild');
    const pending = PENDING_TABLES.reduce(
      (count, table) =>
        count +
        this.storage.sql
          .exec<{
            count: number;
          }>(`SELECT COUNT(*) AS count FROM ${table} WHERE sent_at_ms IS NULL`)
          .one().count,
      0,
    );
    if (pending > 0) throw new Error(`fact rebuild has ${pending} unconfirmed pending rows`);
    const blocked = this.storage.sql
      .exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM recovery_records
         WHERE state = 'blocked' AND kind IN ('repair', 'tinybird_insert')`,
      )
      .one().count;
    if (blocked > 0)
      throw new Error(`fact rebuild has ${blocked} unresolved fact recovery records`);
    this.storage.sql.exec(
      `UPDATE fact_rebuild_operations SET state = 'completed', completed_at_ms = ?,
       completion_reason = ?, backup_sha256 = ?, canonical_fingerprint = ?, legacy_fingerprint = ?
       WHERE operation_id = ? AND state = 'active'`,
      Date.now(),
      reason,
      input.proof.backupSha256,
      input.proof.canonicalFingerprint,
      input.proof.legacyFingerprint,
      operationId,
    );
    return completedResult(this.operation(operationId)!);
  }

  private async prepareConfirmation(
    confirmation: FactRebuildConfirmation,
  ): Promise<PreparedConfirmation> {
    if (!(CATEGORIES as readonly string[]).includes(confirmation.category))
      throw new Error('invalid fact rebuild category');
    const rowData = JSON.stringify(confirmation.row);
    if (!rowData) throw new Error('fact rebuild confirmation row must be serializable');
    return { ...confirmation, rowData, rowSha256: await sha256Hex(rowData) };
  }

  private validateConfirmation(
    operation: StoredOperation,
    confirmation: PreparedConfirmation,
  ): void {
    if ((confirmation.row as Record<string, unknown> | null)?.OrgId !== operation.org_id)
      throw new Error('fact rebuild confirmation organization does not match');
    if (
      rowIdentity(confirmation.row, ROW_IDENTITY_FIELDS[confirmation.category]) !==
      confirmation.factId
    )
      throw new Error('fact rebuild confirmation identity does not match');
    if (stableHash(confirmation.row) !== confirmation.newHash)
      throw new Error('fact rebuild confirmation hash does not match');
    const existing = [
      ...this.storage.sql.exec<{ content_hash: string }>(
        'SELECT content_hash FROM fact_ledger WHERE category = ? AND fact_id = ?',
        confirmation.category,
        confirmation.factId,
      ),
    ][0];
    if (!existing) throw new Error('fact rebuild confirmation is not in the ledger');
    const staged = this.stagedConfirmation(
      operation.operation_id,
      confirmation.category,
      confirmation.factId,
    );
    if (staged) {
      if (
        staged.expected_old_hash !== confirmation.expectedOldHash ||
        staged.new_hash !== confirmation.newHash ||
        staged.row_sha256 !== confirmation.rowSha256
      ) {
        throw new Error('fact rebuild confirmation does not match the staged value');
      }
      if (existing.content_hash !== confirmation.newHash)
        throw new Error('fact ledger changed after confirmation');
    } else if (existing.content_hash !== confirmation.expectedOldHash) {
      throw new Error('fact rebuild expected old hash does not match');
    }
  }

  private persistConfirmation(
    operation: StoredOperation,
    confirmation: PreparedConfirmation,
  ): boolean {
    const staged = this.stagedConfirmation(
      operation.operation_id,
      confirmation.category,
      confirmation.factId,
    );
    if (!staged) {
      this.storage.sql.exec(
        `UPDATE fact_ledger SET content_hash = ? WHERE category = ? AND fact_id = ?`,
        confirmation.newHash,
        confirmation.category,
        confirmation.factId,
      );
      this.storeLedgerPayload(confirmation.category, confirmation.factId, confirmation.rowData);
      this.storage.sql.exec(
        `INSERT INTO fact_rebuild_confirmations
         (operation_id, category, fact_id, expected_old_hash, new_hash, row_sha256, confirmed_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        operation.operation_id,
        confirmation.category,
        confirmation.factId,
        confirmation.expectedOldHash,
        confirmation.newHash,
        confirmation.rowSha256,
        Date.now(),
      );
    }
    for (const table of PENDING_TABLES) {
      this.storage.sql.exec(
        `UPDATE ${table} SET sent_at_ms = ?
         WHERE category = ? AND fact_id = ? AND sent_at_ms IS NULL`,
        Date.now(),
        confirmation.category,
        confirmation.factId,
      );
    }
    return staged === undefined;
  }

  private resolveRepairs(
    operation: StoredOperation,
    confirmations: FactRecoveryConfirmation[],
    reason: string,
  ): number {
    let resolved = 0;
    for (const confirmation of confirmations) {
      const record = this.recovery.get(confirmation.recoveryId);
      if (record.kind !== 'repair') throw new Error('repair recovery confirmation is not a repair');
      const row = parsePayload(record.payload);
      if (stableHash(row) !== confirmation.expectedPayloadHash)
        throw new Error('repair recovery payload hash does not match');
      const outcome = parsePayload(record.outcome) as Record<string, unknown>;
      const category = outcome.category;
      const factId = outcome.factId;
      if (!(CATEGORIES as readonly unknown[]).includes(category) || typeof factId !== 'string')
        throw new Error('repair recovery identity is invalid');
      if (rowIdentity(row, ROW_IDENTITY_FIELDS[category as Category]) !== factId)
        throw new Error('repair recovery payload identity does not match');
      if ((row as Record<string, unknown>).OrgId !== operation.org_id)
        throw new Error('repair recovery organization does not match');
      if (outcome.newHash !== confirmation.expectedPayloadHash)
        throw new Error('repair recovery outcome hash does not match');
      const staged = this.stagedConfirmation(operation.operation_id, category as Category, factId);
      if (!staged) throw new Error('repair recovery replacement has not been confirmed');
      if (record.state === 'resolved') {
        if (!['rebuilt', 'superseded-by-rebuild'].includes(record.resolution ?? ''))
          throw new Error('repair recovery has a different resolution');
        continue;
      }
      const resolution =
        staged.new_hash === confirmation.expectedPayloadHash ? 'rebuilt' : 'superseded-by-rebuild';
      this.recovery.resolve(record.id, resolution, reason);
      resolved++;
    }
    return resolved;
  }

  private resolveInserts(
    operation: StoredOperation,
    confirmations: FactRecoveryConfirmation[],
    reason: string,
  ): number {
    let resolved = 0;
    for (const confirmation of confirmations) {
      const record = this.recovery.get(confirmation.recoveryId);
      if (record.kind !== 'tinybird_insert')
        throw new Error('insert recovery confirmation is not a Tinybird insert');
      const payload = parsePayload(record.payload);
      if (stableHash(payload) !== confirmation.expectedPayloadHash)
        throw new Error('insert recovery payload hash does not match');
      if (!Array.isArray(payload) || payload.length === 0)
        throw new Error('insert recovery payload is not a fact array');
      const target = parsePendingTarget(this.recovery.getTargetKey(record.id));
      const payloadFactIds = new Set<string>();
      for (const row of payload) {
        if ((row as Record<string, unknown> | null)?.OrgId !== operation.org_id)
          throw new Error('insert recovery organization does not match');
        const factId = rowIdentity(row, ROW_IDENTITY_FIELDS[target.category]);
        if (!this.stagedConfirmation(operation.operation_id, target.category, factId))
          throw new Error('insert recovery payload row has not been confirmed');
        payloadFactIds.add(factId);
      }
      if (record.state === 'resolved') {
        if (record.resolution !== 'rebuilt-confirm-written')
          throw new Error('insert recovery has a different resolution');
        continue;
      }
      const rowIds = this.recovery.rowIds(record.id);
      if (rowIds.length === 0) throw new Error('insert recovery has no pending rows');
      for (const rowId of rowIds) {
        const pending = [
          ...this.storage.sql.exec<{ category: Category; fact_id: string | null }>(
            `SELECT category, fact_id FROM ${target.table} WHERE id = ?`,
            rowId,
          ),
        ][0];
        if (!pending?.fact_id)
          throw new Error('insert recovery pending row has no rebuild identity');
        if (pending.category !== target.category || !payloadFactIds.has(pending.fact_id))
          throw new Error('insert recovery pending row does not match its payload');
      }
      this.recovery.resolveWithMutation(record.id, 'rebuilt-confirm-written', reason, () => {
        markPendingSent(this.storage, target.table, rowIds);
      });
      resolved++;
    }
    return resolved;
  }

  private rebuildFact(row: StoredLedgerFactMetadata, orgId: string): RebuildFact {
    const stored = [
      ...this.storage.sql.exec<{ data: string }>(
        `SELECT COALESCE(data, '') AS data FROM fact_ledger
         WHERE category = ? AND fact_id = ?`,
        row.category,
        row.fact_id,
      ),
    ][0];
    if (!stored) throw new Error('fact rebuild ledger changed while listing');
    const ledger = { ...row, data: stored.data };
    const payload = this.loadLedgerPayload(row.category, row.fact_id, stored.data);
    const replacement = payload === null ? this.replacementFor(ledger, orgId) : undefined;
    if (payload === null && !replacement)
      throw new Error('fact rebuild ledger payload and validated replacement are missing');
    const pending = PENDING_TABLES.flatMap((table) =>
      [
        ...this.storage.sql.exec<StoredPendingFact>(
          `SELECT id, content_hash, data FROM ${table}
           WHERE category = ? AND fact_id = ? AND sent_at_ms IS NULL ORDER BY id`,
          row.category,
          row.fact_id,
        ),
      ].map((item) => {
        const pendingPayload = this.loadPendingPayload(table, item.id, item.data);
        return {
          table: table === 'pending_facts' ? ('clean' as const) : ('legacy' as const),
          rowId: item.id,
          contentHash: item.content_hash,
          payload: pendingPayload,
          missingPayload: pendingPayload === null,
        };
      }),
    );
    return {
      category: row.category,
      factId: row.fact_id,
      contentHash: row.content_hash,
      payload,
      missingPayload: payload === null,
      ...(replacement ? { replacement } : {}),
      pending,
    };
  }

  private missingLedgerPayloads(): Iterable<StoredLedgerFact> {
    return this.storage.sql.exec<StoredLedgerFact>(
      `SELECT category, fact_id, content_hash, COALESCE(data, '') AS data
       FROM fact_ledger AS ledger
       WHERE (ledger.data IS NULL OR ledger.data = '')
         AND NOT EXISTS (
           SELECT 1 FROM fact_ledger_payload_chunks AS chunks
           WHERE chunks.category = ledger.category AND chunks.fact_id = ledger.fact_id
         )
       ORDER BY category, fact_id`,
    );
  }

  private replacementFor(
    ledger: StoredLedgerFact,
    orgId: string,
  ): { contentHash: string; payload: string; recoveryId: number } | undefined {
    const repair = [
      ...this.storage.sql.exec<StoredRepairFallback>(
        `SELECT old_hash, new_hash, data, recovery_dedupe_key FROM fact_repairs
         WHERE category = ? AND fact_id = ? AND old_hash = ?
         ORDER BY id DESC LIMIT 1`,
        ledger.category,
        ledger.fact_id,
        ledger.content_hash,
      ),
    ][0];
    if (repair?.old_hash !== ledger.content_hash) return undefined;
    const dedupeKey =
      repair.recovery_dedupe_key ??
      JSON.stringify([ledger.category, ledger.fact_id, ledger.content_hash, repair.new_hash]);
    const recoveryMatch = [
      ...this.storage.sql.exec<{ id: number; state: string }>(
        `SELECT id, state FROM recovery_records
         WHERE kind = 'repair' AND dedupe_key = ? ORDER BY id DESC LIMIT 1`,
        dedupeKey,
      ),
    ][0];
    if (recoveryMatch?.state !== 'blocked') return undefined;
    const record = this.recovery.get(recoveryMatch.id);
    if (record.kind !== 'repair' || record.state !== 'blocked') return undefined;
    const row = parsePayload(record.payload);
    const outcome = parsePayload(record.outcome) as Record<string, unknown>;
    if (
      outcome.category !== ledger.category ||
      outcome.factId !== ledger.fact_id ||
      outcome.oldHash !== ledger.content_hash ||
      outcome.newHash !== repair.new_hash ||
      stableHash(row) !== repair.new_hash ||
      rowIdentity(row, ROW_IDENTITY_FIELDS[ledger.category]) !== ledger.fact_id ||
      (row as Record<string, unknown> | null)?.OrgId !== orgId
    ) {
      return undefined;
    }
    if (repair.data && repair.data !== record.payload) return undefined;
    return { contentHash: repair.new_hash, payload: record.payload, recoveryId: record.id };
  }

  private loadPendingPayload(table: PendingTable, rowId: number, fallback: string): string | null {
    if (fallback) return fallback;
    const chunks = [
      ...this.storage.sql.exec<{ data: string }>(
        `SELECT data FROM fact_payload_chunks
         WHERE table_name = ? AND row_id = ? ORDER BY chunk_index`,
        table,
        rowId,
      ),
    ];
    return chunks.length > 0 ? chunks.map((chunk) => chunk.data).join('') : null;
  }

  private activeOperation(): StoredOperation | undefined {
    return [
      ...this.storage.sql.exec<StoredOperation>(
        `SELECT * FROM fact_rebuild_operations WHERE state = 'active' LIMIT 1`,
      ),
    ][0];
  }

  private operation(operationId: string): StoredOperation | undefined {
    return [
      ...this.storage.sql.exec<StoredOperation>(
        'SELECT * FROM fact_rebuild_operations WHERE operation_id = ?',
        operationId,
      ),
    ][0];
  }

  private requireActive(operationId: string, executorId: string): StoredOperation {
    const normalized = validateOperationId(operationId);
    const executor = validateExecutorId(executorId);
    const operation = this.operation(normalized);
    if (!operation) throw new Error('fact rebuild operation not found');
    if (operation.executor_id !== executor) throw new Error('fact rebuild executor does not match');
    if (operation.state !== 'active') throw new Error('fact rebuild operation is completed');
    return operation;
  }

  private confirmedCount(operationId: string): number {
    return this.storage.sql
      .exec<{
        count: number;
      }>(
        'SELECT COUNT(*) AS count FROM fact_rebuild_confirmations WHERE operation_id = ?',
        operationId,
      )
      .one().count;
  }

  private stagedConfirmation(
    operationId: string,
    category: Category,
    factId: string,
  ): { expected_old_hash: string; new_hash: string; row_sha256: string } | undefined {
    return [
      ...this.storage.sql.exec<{
        expected_old_hash: string;
        new_hash: string;
        row_sha256: string;
      }>(
        `SELECT expected_old_hash, new_hash, row_sha256 FROM fact_rebuild_confirmations
         WHERE operation_id = ? AND category = ? AND fact_id = ?`,
        operationId,
        category,
        factId,
      ),
    ][0];
  }

  private ensureColumn(table: string, column: string, definition: string): boolean {
    const existing = [
      ...this.storage.sql.exec<{ name: string }>(
        `SELECT name FROM pragma_table_info('${table}') WHERE name = ?`,
        column,
      ),
    ];
    if (existing.length === 0) {
      this.storage.sql.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
      return true;
    }
    return false;
  }
}

async function sha256Hex(value: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)),
  );
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function validateBoundedConfirmations(input: StageFactRebuildInput): void {
  const lists = [
    input.confirmations,
    input.repairRecoveryConfirmations ?? [],
    input.insertRecoveryConfirmations ?? [],
  ];
  if (lists.some((list) => list.length > MAX_PAGE_ROWS))
    throw new Error(`fact rebuild pages are limited to ${MAX_PAGE_ROWS} entries per list`);
  const total = lists.reduce((count, list) => count + list.length, 0);
  if (total === 0) throw new Error('fact rebuild stage requires confirmation evidence');
  if (total > 1 && utf8Bytes(JSON.stringify(input)) > PAYLOAD_CHUNK_BYTES)
    throw new Error('fact rebuild confirmation page exceeds the byte limit');
}

function validateOperationId(value: string): string {
  const normalized = value?.trim();
  if (!normalized || normalized.length > MAX_OPERATION_ID_LENGTH || normalized.includes(':'))
    throw new Error('invalid fact rebuild operation ID');
  return normalized;
}

function validateExecutorId(value: string): string {
  const normalized = value?.trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(normalized))
    throw new Error('invalid fact rebuild executor ID');
  return normalized.toLowerCase();
}

function validateTarget(
  workspaceId: string,
  allowedFingerprints: string[],
  target: FactRebuildTarget,
): ValidatedFactRebuildTarget {
  const normalizedWorkspaceId = workspaceId?.trim().toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(normalizedWorkspaceId))
    throw new Error('invalid Tinybird workspace ID');
  if (
    !Array.isArray(allowedFingerprints) ||
    allowedFingerprints.length === 0 ||
    allowedFingerprints.length > MAX_TOKEN_FINGERPRINTS
  ) {
    throw new Error(`fact rebuild requires 1 to ${MAX_TOKEN_FINGERPRINTS} token fingerprints`);
  }
  const normalized = allowedFingerprints.map((fingerprint) => {
    if (typeof fingerprint !== 'string' || !/^[a-f0-9]{64}$/i.test(fingerprint))
      throw new Error('invalid Tinybird token fingerprint');
    return fingerprint.toLowerCase();
  });
  const tokenFingerprint = target.tokenFingerprint.toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(tokenFingerprint) || !normalized.includes(tokenFingerprint))
    throw new Error('fact rebuild Tinybird target does not match');
  const host = target.host.trim();
  if (!host) throw new Error('fact rebuild Tinybird host is invalid');
  return { tokenFingerprint, workspaceId: normalizedWorkspaceId, host };
}

function validateLimit(value: number | undefined): number {
  if (value === undefined) return MAX_PAGE_ROWS;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_PAGE_ROWS)
    throw new Error(`fact rebuild limit must be between 1 and ${MAX_PAGE_ROWS}`);
  return value;
}

function validateCursor(value: RebuildFactCursor | undefined): RebuildFactCursor | undefined {
  if (!value) return undefined;
  if (!(CATEGORIES as readonly string[]).includes(value.category) || !value.factId)
    throw new Error('invalid fact rebuild cursor');
  return value;
}

function validateProof(proof: FinalizeFactRebuildInput['proof']): void {
  if (!/^[a-f0-9]{64}$/.test(proof.backupSha256))
    throw new Error('fact rebuild backup SHA-256 proof is invalid');
  for (const [name, value] of [
    ['canonical', proof.canonicalFingerprint],
    ['legacy', proof.legacyFingerprint],
  ] as const) {
    if (!value?.trim() || value.length > 256)
      throw new Error(`fact rebuild ${name} fingerprint is invalid`);
  }
}

function parsePayload(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error('fact recovery payload is invalid JSON');
  }
}

function parsePendingTarget(value: string): { table: PendingTable; category: Category } {
  const [table, category, extra] = value.split(':');
  if (extra || !PENDING_TABLES.includes(table as PendingTable))
    throw new Error('invalid fact recovery target');
  if (!(CATEGORIES as readonly string[]).includes(category ?? ''))
    throw new Error('invalid fact recovery category');
  return { table: table as PendingTable, category: category as Category };
}

function markPendingSent(storage: DurableObjectStorage, table: PendingTable, ids: number[]): void {
  const sentAtMs = Date.now();
  for (const id of ids) {
    storage.sql.exec(`UPDATE ${table} SET sent_at_ms = ? WHERE id = ?`, sentAtMs, id);
  }
}

function operationResult(operation: StoredOperation): Omit<BeginFactRebuildResult, 'status'> & {
  completed: boolean;
} {
  return {
    operationId: operation.operation_id,
    reason: operation.reason,
    startedAtMs: operation.started_at_ms,
    expectedFactCount: operation.expected_fact_count,
    tinybirdTokenFingerprint: operation.tinybird_token_fingerprint!,
    tinybirdWorkspaceId: operation.tinybird_workspace_id!,
    tinybirdHost: operation.tinybird_host!,
    completed: operation.state === 'completed',
  };
}

function requireOperationReason(operation: StoredOperation, reason: string): void {
  if (operation.reason !== reason) throw new Error('fact rebuild reason does not match');
}

function completedResult(operation: StoredOperation): CompleteFactRebuildResult {
  return {
    status: 'completed',
    operationId: operation.operation_id,
    confirmedFactCount: operation.expected_fact_count,
    expectedFactCount: operation.expected_fact_count,
  };
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
