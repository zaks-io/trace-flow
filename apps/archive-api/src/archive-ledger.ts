import { DurableObject } from 'cloudflare:workers';
import type { ArchiveApiEnv } from './context';
import { MAX_ARCHIVE_COMMIT_BYTES, readBoundedJson } from './archive-request';
import {
  ArchiveContractError,
  assertDigest,
  assertIdentifier,
  assertSafeInteger,
  assertTranscriptPartId,
  type ArchiveScope,
} from './archive-contract';
import {
  commitArchiveRepairChunk,
  commitArchiveSession,
  getCommittedManifestKeyMaterial,
} from './archive-ledger-commit';
import { assertIncomingObservationCount } from './archive-validation';
import { statusFor } from './archive-ledger-support';
import {
  ArchiveSessionIntegrityError,
  ensureSessionIntegrityTable,
} from './archive-session-integrity';
import {
  armLedgerRecovery,
  resumeLedgerRecovery,
  scheduleLedgerRecovery,
} from './archive-ledger-recovery';
import { ensurePendingReleaseSchema } from './archive-ledger-release-outbox';
import { readLedgerScan, readLedgerSnapshot } from './archive-ledger-storage';
import { hasPendingIntent, readPendingIntent } from './archive-ledger-intent';
import {
  assertArchiveWritable,
  clearLedgerSqlState,
  ledgerErasureOrgId,
  markLedgerErased,
} from './archive-erasure-state';
import {
  archivedRepairFingerprintCount,
  ensureArchiveRepairTables,
  finalizeArchiveRepairState,
  parseArchiveRepairRouting,
  readActiveArchiveRepair,
  readArchiveRepair,
  readLatestArchiveRepairForPart,
  type ArchiveRepairChunkInput,
} from './archive-ledger-repair';
import {
  ensureArchiveVerificationTables,
  verifyArchiveLedgerPage,
  assertArchiveVerificationComplete,
  type ArchiveVerificationInput,
} from './archive-ledger-verification';
import { readSessionIntegrity } from './archive-session-integrity';
import { unwrapKey } from './archive-ledger-intent-recovery';
import type { ArchiveRepairStateExpectation } from './archive-ledger-state';

export class ArchiveSessionLedger extends DurableObject<ArchiveApiEnv> {
  private commitQueue: Promise<void> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: ArchiveApiEnv) {
    super(ctx, env);
    this.ctx.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS ledger_state (id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL)',
    );
    this.ctx.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS ledger_elements (sequence INTEGER PRIMARY KEY, data TEXT NOT NULL)',
    );
    this.ctx.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS ledger_ranges (sequence INTEGER PRIMARY KEY, data TEXT NOT NULL)',
    );
    this.ctx.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS ledger_scans (part_id TEXT PRIMARY KEY, data TEXT NOT NULL)',
    );
    this.ctx.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS ledger_scan_fingerprints (part_id TEXT NOT NULL, fingerprint_index INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (part_id, fingerprint_index))',
    );
    this.ctx.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS ledger_record_versions (version_key TEXT PRIMARY KEY, part_id TEXT NOT NULL, record_identity TEXT NOT NULL, content_hash TEXT NOT NULL, sequence INTEGER NOT NULL)',
    );
    this.ctx.storage.sql.exec(
      'CREATE INDEX IF NOT EXISTS ledger_record_versions_identity ON ledger_record_versions (part_id, record_identity)',
    );
    this.ctx.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS pending_intents (intent_hash TEXT PRIMARY KEY, status TEXT NOT NULL, base_element_count INTEGER NOT NULL, base_chain_head TEXT NOT NULL)',
    );
    this.ctx.storage.sql.exec(
      "CREATE INDEX IF NOT EXISTS pending_intents_active_status_v2 ON pending_intents (status) WHERE status IN ('building', 'ready', 'write_authorized')",
    );
    this.ctx.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS pending_intent_metadata (intent_hash TEXT NOT NULL, part_index INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (intent_hash, part_index))',
    );
    this.ctx.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS pending_intent_parts (intent_hash TEXT NOT NULL, object_index INTEGER NOT NULL, part_index INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (intent_hash, object_index, part_index))',
    );
    ensurePendingReleaseSchema(this.ctx.storage);
    ensureSessionIntegrityTable(this.ctx.storage);
    ensureArchiveRepairTables(this.ctx.storage);
    ensureArchiveVerificationTables(this.ctx.storage);
  }

  private runExclusive<T>(work: () => T | Promise<T>): Promise<T> {
    const turn = this.commitQueue.then(work);
    this.commitQueue = turn.then(
      () => undefined,
      () => undefined,
    );
    return turn;
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method !== 'POST' || new URL(request.url).pathname !== '/commit') {
      return Response.json({ error: 'not_found' }, { status: 404 });
    }
    try {
      const body = await readBoundedJson(
        request,
        MAX_ARCHIVE_COMMIT_BYTES,
        'archive_commit_too_large',
      );
      const upload =
        typeof body === 'object' && body !== null && !Array.isArray(body)
          ? (body as Record<string, unknown>).upload
          : undefined;
      assertIncomingObservationCount(upload);
      const turn = this.commitQueue.then(async () => {
        await assertArchiveWritable(this.ctx.storage);
        await armLedgerRecovery(this.ctx.storage);
        const result = await commitArchiveSession(this.ctx.storage, this.env, body).then(
          (acknowledgement) => ({ acknowledgement }),
          (error: unknown) => ({ error }),
        );
        try {
          await scheduleLedgerRecovery(this.ctx.storage);
        } catch (recoveryError) {
          if ('error' in result) throw result.error;
          throw recoveryError;
        }
        return result;
      });
      this.commitQueue = turn.then(
        () => undefined,
        () => undefined,
      );
      const result = await turn;
      if ('error' in result) throw result.error;
      return Response.json(result.acknowledgement);
    } catch (error) {
      if (error instanceof ArchiveSessionIntegrityError) {
        return Response.json(
          {
            error: error.errorClass,
            source: error.failure.source,
            source_session_id: error.failure.sourceSessionId,
            error_class: error.failure.errorClass,
            operation_id: error.failure.operationId,
            newly_recorded: error.newlyRecorded,
          },
          { status: 409 },
        );
      }
      if (error instanceof ArchiveContractError) {
        return Response.json({ error: error.errorClass }, { status: statusFor(error.errorClass) });
      }
      const diagnosticClass = error instanceof Error ? error.name : 'unknown_error';
      console.error(
        JSON.stringify({ event: 'archive_ledger.commit_failed', errorClass: diagnosticClass }),
      );
      throw error;
    }
  }

  async alarm(): Promise<void> {
    const turn = this.commitQueue.then(async () => {
      try {
        await assertArchiveWritable(this.ctx.storage);
      } catch (error) {
        if (error instanceof ArchiveContractError && error.errorClass === 'archive_deleting') {
          await this.ctx.storage.deleteAlarm();
          return;
        }
        throw error;
      }
      let retry = true;
      try {
        await resumeLedgerRecovery(this.ctx.storage, this.env);
      } catch (error) {
        if (
          error instanceof ArchiveContractError &&
          error.errorClass === 'storage_object_metadata_mismatch'
        ) {
          retry = false;
        }
        console.error(
          JSON.stringify({
            event: 'archive_ledger.recovery_failed',
            errorClass: error instanceof Error ? error.name : 'unknown_error',
          }),
        );
      } finally {
        if (retry) await scheduleLedgerRecovery(this.ctx.storage);
        else await this.ctx.storage.deleteAlarm();
      }
    });
    this.commitQueue = turn.then(
      () => undefined,
      () => undefined,
    );
    await turn;
  }

  inspectArchivePart(input: { scope: ArchiveScope; partId: string }): Promise<unknown> {
    return this.runExclusive(() => {
      assertIdentifier(input.partId, 'archive_repair_invalid');
      assertTranscriptPartId(input.scope.source, input.partId);
      const state = readLedgerSnapshot(this.ctx.storage);
      if (state.scope && JSON.stringify(state.scope) !== JSON.stringify(input.scope)) {
        throw new ArchiveContractError('ledger_scope_mismatch');
      }
      const pending = readPendingIntent(this.ctx.storage);
      const activeRepair = readActiveArchiveRepair(this.ctx.storage);
      return {
        state: {
          generation: state.generation,
          elementCount: state.elementCount,
          recordCount: state.recordCount,
          chainHead: state.chainHead,
        },
        scan: readLedgerScan(this.ctx.storage, input.partId)?.checkpoint ?? null,
        integrity: readSessionIntegrity(this.ctx.storage, input.scope),
        pendingIntent: pending
          ? {
              intentHash: pending.intentHash,
              status: pending.status,
              baseElementCount: pending.baseElementCount,
              baseChainHead: pending.baseChainHead,
              repairOperationId: pending.commit?.repair?.plan.operationId ?? null,
            }
          : null,
        activeRepair,
        latestRepair: readLatestArchiveRepairForPart(this.ctx.storage, input.partId),
        preservedFingerprintCount: activeRepair
          ? archivedRepairFingerprintCount(this.ctx.storage, activeRepair.plan.operationId)
          : 0,
      };
    });
  }

  applyArchiveRepairChunk(input: ArchiveRepairChunkInput): Promise<unknown> {
    return this.runExclusive(async () => {
      await assertArchiveWritable(this.ctx.storage);
      const routing = parseArchiveRepairRouting(input);
      const state = readLedgerSnapshot(this.ctx.storage);
      if (!state.scope || JSON.stringify(state.scope) !== JSON.stringify(routing.scope)) {
        throw new ArchiveContractError('ledger_scope_mismatch');
      }
      if (!state.keyVersion) throw new ArchiveContractError('ledger_state_corrupt');
      const keyMaterial = await getCommittedManifestKeyMaterial(
        this.env,
        routing.scope.orgId,
        state.keyVersion,
      );
      await armLedgerRecovery(this.ctx.storage);
      const result = await commitArchiveRepairChunk(this.ctx.storage, this.env, input, keyMaterial);
      await scheduleLedgerRecovery(this.ctx.storage);
      return result;
    });
  }

  verifyArchiveRepairPage(
    input: ArchiveVerificationInput & { scope: ArchiveScope },
  ): Promise<unknown> {
    return this.runExclusive(async () => {
      assertIdentifier(input.operationId, 'archive_repair_invalid');
      assertDigest(input.snapshotSha256, 'archive_repair_invalid');
      for (const value of [
        input.expected?.generation,
        input.expected?.elementCount,
        input.expected?.recordCount,
      ]) {
        assertSafeInteger(value, 'archive_repair_invalid');
      }
      assertDigest(input.expected?.chainHead, 'archive_repair_invalid');
      const expected: ArchiveRepairStateExpectation = {
        generation: input.expected.generation,
        elementCount: input.expected.elementCount,
        recordCount: input.expected.recordCount,
        chainHead: input.expected.chainHead,
      };
      const state = readLedgerSnapshot(this.ctx.storage);
      if (!state.scope || JSON.stringify(state.scope) !== JSON.stringify(input.scope)) {
        throw new ArchiveContractError('ledger_scope_mismatch');
      }
      const keyCache = new Map<number, CryptoKey>();
      return verifyArchiveLedgerPage(
        this.ctx.storage,
        this.env.ARCHIVE_STORAGE,
        input.scope,
        { ...input, expected },
        async (keyVersion) => {
          const cached = keyCache.get(keyVersion);
          if (cached) return cached;
          const material = await getCommittedManifestKeyMaterial(
            this.env,
            input.scope.orgId,
            keyVersion,
          );
          const key = await unwrapKey(this.env, { scope: input.scope, ...material });
          keyCache.set(keyVersion, key);
          return key;
        },
      );
    });
  }

  finalizeArchiveRepair(input: {
    scope: ArchiveScope;
    partId: string;
    operationId: string;
    snapshotSha256: string;
    expected: ArchiveRepairStateExpectation;
  }): Promise<unknown> {
    return this.runExclusive(() => {
      assertIdentifier(input.operationId, 'archive_repair_invalid');
      assertDigest(input.snapshotSha256, 'archive_repair_invalid');
      for (const value of [
        input.expected?.generation,
        input.expected?.elementCount,
        input.expected?.recordCount,
      ]) {
        assertSafeInteger(value, 'archive_repair_invalid');
      }
      assertDigest(input.expected?.chainHead, 'archive_repair_invalid');
      const expected: ArchiveRepairStateExpectation = {
        generation: input.expected.generation,
        elementCount: input.expected.elementCount,
        recordCount: input.expected.recordCount,
        chainHead: input.expected.chainHead,
      };
      const state = readLedgerSnapshot(this.ctx.storage);
      if (!state.scope || JSON.stringify(state.scope) !== JSON.stringify(input.scope)) {
        throw new ArchiveContractError('ledger_scope_mismatch');
      }
      const repair = readArchiveRepair(this.ctx.storage, input.operationId);
      if (!repair) throw new ArchiveContractError('archive_repair_precondition_failed');
      if (repair.plan.partId !== input.partId) {
        throw new ArchiveContractError('archive_repair_precondition_failed');
      }
      if (repair.status === 'finalized') {
        if (JSON.stringify(repair.finalState) !== JSON.stringify(expected)) {
          throw new ArchiveContractError('archive_repair_precondition_failed');
        }
        return { status: 'finalized', replay: true, state: expected };
      }
      if (
        hasPendingIntent(this.ctx.storage) ||
        repair.appliedChunks !== repair.plan.chunkDigests.length ||
        JSON.stringify(expected) !==
          JSON.stringify({
            generation: state.generation,
            elementCount: state.elementCount,
            recordCount: state.recordCount,
            chainHead: state.chainHead,
          }) ||
        JSON.stringify(readLedgerScan(this.ctx.storage, repair.plan.partId)?.checkpoint) !==
          JSON.stringify(repair.plan.finalCheckpoint)
      ) {
        throw new ArchiveContractError('archive_repair_precondition_failed');
      }
      assertArchiveVerificationComplete(
        this.ctx.storage,
        input.operationId,
        'after',
        input.snapshotSha256,
        expected,
      );
      finalizeArchiveRepairState(this.ctx.storage, input.operationId, expected);
      return { status: 'finalized', replay: false, state: expected };
    });
  }

  eraseArchive(input: {
    orgId: string;
    trustedRegistered?: boolean;
  }): Promise<{ erased: boolean; reason?: 'foreign_or_uninitialized' }> {
    const turn = this.commitQueue.then(async () => {
      const erasedOrgId = await ledgerErasureOrgId(this.ctx.storage);
      if (erasedOrgId !== undefined && erasedOrgId !== input.orgId) {
        throw new ArchiveContractError('ledger_scope_mismatch');
      }
      const snapshot = readLedgerSnapshot(this.ctx.storage);
      const pending = readPendingIntent(this.ctx.storage);
      const storedOrgId = erasedOrgId ?? snapshot.scope?.orgId ?? pending?.commit?.scope.orgId;
      if (storedOrgId !== undefined && storedOrgId !== input.orgId) {
        if (input.trustedRegistered) throw new ArchiveContractError('ledger_scope_mismatch');
        return { erased: false as const, reason: 'foreign_or_uninitialized' as const };
      }
      if (storedOrgId === undefined && !input.trustedRegistered) {
        return { erased: false as const, reason: 'foreign_or_uninitialized' as const };
      }
      await markLedgerErased(this.ctx.storage, input.orgId);
      await this.ctx.storage.deleteAlarm();
      clearLedgerSqlState(this.ctx.storage);
      return { erased: true as const };
    });
    this.commitQueue = turn.then(
      () => undefined,
      () => undefined,
    );
    return turn;
  }
}
