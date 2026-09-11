import {
  ArchiveContractError,
  assertDigest,
  assertIdentifier,
  assertSafeInteger,
  assertTranscriptPartId,
  type ArchiveScope,
  type ArchiveUploadRequest,
  type CompletedScanCheckpoint,
} from './archive-contract';
import { sameCheckpointLogicalPosition } from './archive-chain';
import type {
  ArchiveRepairCommit,
  ArchiveRepairPlan,
  ArchiveRepairStateExpectation,
  CommitEnvelope,
  LedgerSnapshot,
  ScanState,
} from './archive-ledger-state';
import { intentDigest, parseCommitEnvelope } from './archive-ledger-support';
import { readSessionIntegrity } from './archive-session-integrity';
import { MAX_ARCHIVE_UPLOAD_BYTES } from './archive-request';
import { validateCheckpoint } from './archive-contract-validation';

export interface ArchiveRepairChunkInput {
  scope: ArchiveScope;
  upload: ArchiveUploadRequest;
  operationId: string;
  plan: Omit<ArchiveRepairPlan, 'operationId' | 'partId'>;
  expected: ArchiveRepairStateExpectation;
  chunkIndex: number;
  chunkKind: 'rebase' | 'delta';
}

export interface ParsedArchiveRepairChunk {
  envelope: CommitEnvelope;
  plan: ArchiveRepairPlan;
  planDigest: string;
  expected: ArchiveRepairStateExpectation;
  chunkIndex: number;
  chunkKind: 'rebase' | 'delta';
}

export interface StoredArchiveRepair {
  plan: ArchiveRepairPlan;
  planDigest: string;
  status: 'active' | 'finalized';
  appliedChunks: number;
  finalState?: ArchiveRepairStateExpectation;
}

export function parseArchiveRepairRouting(value: unknown): {
  scope: ArchiveScope;
  partId: string;
} {
  if (!isRecord(value) || !isRecord(value.scope) || !isRecord(value.upload)) {
    throw new ArchiveContractError('archive_repair_invalid');
  }
  const scope = value.scope;
  for (const field of ['orgId', 'userId', 'contributionId', 'sourceSessionId']) {
    assertIdentifier(scope[field], 'archive_repair_invalid');
  }
  if (scope.source !== 'claude' && scope.source !== 'codex') {
    throw new ArchiveContractError('archive_repair_invalid');
  }
  const checkpoint = value.upload.checkpoint;
  if (!isRecord(checkpoint) || typeof checkpoint.source_transcript_part_id !== 'string') {
    throw new ArchiveContractError('archive_repair_invalid');
  }
  assertTranscriptPartId(scope.source, checkpoint.source_transcript_part_id);
  return {
    scope: {
      orgId: scope.orgId as string,
      userId: scope.userId as string,
      contributionId: scope.contributionId as string,
      source: scope.source,
      sourceSessionId: scope.sourceSessionId as string,
    },
    partId: checkpoint.source_transcript_part_id,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertRepairUploadSize(upload: unknown): void {
  let encoded: Uint8Array;
  try {
    encoded = new TextEncoder().encode(JSON.stringify(upload));
  } catch {
    throw new ArchiveContractError('archive_repair_invalid');
  }
  if (encoded.byteLength > MAX_ARCHIVE_UPLOAD_BYTES) {
    throw new ArchiveContractError('upload_too_large');
  }
}

function parseExpectation(value: unknown): ArchiveRepairStateExpectation {
  if (!isRecord(value)) throw new ArchiveContractError('archive_repair_invalid');
  for (const field of ['generation', 'elementCount', 'recordCount']) {
    assertSafeInteger(value[field], 'archive_repair_invalid');
  }
  assertDigest(value.chainHead, 'archive_repair_invalid');
  return {
    generation: value.generation as number,
    elementCount: value.elementCount as number,
    recordCount: value.recordCount as number,
    chainHead: value.chainHead,
  };
}

function parseCheckpoint(value: unknown): CompletedScanCheckpoint {
  if (
    !isRecord(value) ||
    (value.source !== 'claude' && value.source !== 'codex') ||
    typeof value.source_session_id !== 'string'
  ) {
    throw new ArchiveContractError('archive_repair_invalid');
  }
  try {
    return validateCheckpoint(value, {
      source: value.source,
      sourceSessionId: value.source_session_id,
    });
  } catch {
    throw new ArchiveContractError('archive_repair_invalid');
  }
}

function sameState(actual: LedgerSnapshot, expected: ArchiveRepairStateExpectation): boolean {
  return (
    actual.generation === expected.generation &&
    actual.elementCount === expected.elementCount &&
    actual.recordCount === expected.recordCount &&
    actual.chainHead === expected.chainHead
  );
}

export async function parseArchiveRepairChunk(
  value: unknown,
  keyMaterial: { keyVersion: number; wrappedKey: string },
): Promise<ParsedArchiveRepairChunk> {
  if (!isRecord(value) || !isRecord(value.scope) || !isRecord(value.plan)) {
    throw new ArchiveContractError('archive_repair_invalid');
  }
  assertRepairUploadSize(value.upload);
  assertIdentifier(value.operationId, 'archive_repair_invalid');
  assertSafeInteger(value.chunkIndex, 'archive_repair_invalid');
  if (value.chunkKind !== 'rebase' && value.chunkKind !== 'delta') {
    throw new ArchiveContractError('archive_repair_invalid');
  }
  const envelope = parseCommitEnvelope({
    scope: value.scope,
    upload: value.upload,
    ...keyMaterial,
  });
  const partId = envelope.upload.checkpoint.source_transcript_part_id;
  const expectedBase = parseExpectation(value.plan.expectedBase);
  const expectedScan = parseCheckpoint(value.plan.expectedScan);
  const finalCheckpoint = parseCheckpoint(value.plan.finalCheckpoint);
  const expectedIntegrityOperationId = value.plan.expectedIntegrityOperationId;
  if (expectedIntegrityOperationId !== null && typeof expectedIntegrityOperationId !== 'string') {
    throw new ArchiveContractError('archive_repair_invalid');
  }
  assertDigest(value.plan.snapshotSha256, 'archive_repair_invalid');
  if (
    typeof value.plan.reason !== 'string' ||
    value.plan.reason.length < 1 ||
    value.plan.reason.length > 512 ||
    !Array.isArray(value.plan.chunkDigests) ||
    value.plan.chunkDigests.length < 1 ||
    value.plan.chunkDigests.length > 16_384
  ) {
    throw new ArchiveContractError('archive_repair_invalid');
  }
  const chunkDigests: unknown[] = value.plan.chunkDigests;
  const parsedChunkDigests = chunkDigests.map((digest) => {
    assertDigest(digest, 'archive_repair_invalid');
    return digest;
  });
  if (
    value.chunkIndex >= value.plan.chunkDigests.length ||
    expectedScan.source !== envelope.scope.source ||
    finalCheckpoint.source !== envelope.scope.source ||
    expectedScan.source_session_id !== envelope.scope.sourceSessionId ||
    finalCheckpoint.source_session_id !== envelope.scope.sourceSessionId ||
    expectedScan.source_transcript_part_id !== partId ||
    finalCheckpoint.source_transcript_part_id !== partId
  ) {
    throw new ArchiveContractError('archive_repair_invalid');
  }
  const plan: ArchiveRepairPlan = {
    operationId: value.operationId,
    partId,
    expectedBase,
    expectedScan,
    expectedIntegrityOperationId,
    finalCheckpoint,
    snapshotSha256: value.plan.snapshotSha256,
    reason: value.plan.reason,
    chunkDigests: parsedChunkDigests,
  };
  return {
    envelope,
    plan,
    planDigest: await intentDigest({
      purpose: 'archive_part_repair_plan/v1',
      scope: envelope.scope,
      plan,
    }),
    expected: parseExpectation(value.expected),
    chunkIndex: value.chunkIndex,
    chunkKind: value.chunkKind,
  };
}

export function ensureArchiveRepairTables(storage: DurableObjectStorage): void {
  storage.sql.exec(
    'CREATE TABLE IF NOT EXISTS ledger_repairs (operation_id TEXT PRIMARY KEY, part_id TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL)',
  );
  storage.sql.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS ledger_repairs_active_part ON ledger_repairs (part_id) WHERE status = 'active'",
  );
  storage.sql.exec(
    'CREATE TABLE IF NOT EXISTS ledger_repair_fingerprints (operation_id TEXT NOT NULL, fingerprint_index INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (operation_id, fingerprint_index))',
  );
}

export function readArchiveRepair(
  storage: DurableObjectStorage,
  operationId: string,
): StoredArchiveRepair | null {
  ensureArchiveRepairTables(storage);
  const row = [
    ...storage.sql.exec<{ data: string }>(
      'SELECT data FROM ledger_repairs WHERE operation_id = ?',
      operationId,
    ),
  ][0];
  if (!row) return null;
  try {
    return JSON.parse(row.data) as StoredArchiveRepair;
  } catch {
    throw new ArchiveContractError('ledger_state_corrupt');
  }
}

export function readActiveArchiveRepair(storage: DurableObjectStorage): StoredArchiveRepair | null {
  ensureArchiveRepairTables(storage);
  const row = [
    ...storage.sql.exec<{ data: string }>(
      "SELECT data FROM ledger_repairs WHERE status = 'active' LIMIT 1",
    ),
  ][0];
  if (!row) return null;
  try {
    return JSON.parse(row.data) as StoredArchiveRepair;
  } catch {
    throw new ArchiveContractError('ledger_state_corrupt');
  }
}

export function readLatestArchiveRepairForPart(
  storage: DurableObjectStorage,
  partId: string,
): StoredArchiveRepair | null {
  ensureArchiveRepairTables(storage);
  const row = [
    ...storage.sql.exec<{ data: string }>(
      'SELECT data FROM ledger_repairs WHERE part_id = ? ORDER BY rowid DESC LIMIT 1',
      partId,
    ),
  ][0];
  if (!row) return null;
  try {
    return JSON.parse(row.data) as StoredArchiveRepair;
  } catch {
    throw new ArchiveContractError('ledger_state_corrupt');
  }
}

export function assertNoActiveArchiveRepair(storage: DurableObjectStorage): void {
  if (readActiveArchiveRepair(storage)) {
    throw new ArchiveContractError('archive_repair_in_progress');
  }
}

export function assertRepairPlanStable(
  storage: DurableObjectStorage,
  input: Pick<ParsedArchiveRepairChunk, 'plan' | 'planDigest'>,
): StoredArchiveRepair | null {
  const existing = readArchiveRepair(storage, input.plan.operationId);
  if (existing && existing.planDigest !== input.planDigest) {
    throw new ArchiveContractError('archive_repair_plan_mismatch');
  }
  const active = readActiveArchiveRepair(storage);
  if (active && active.plan.operationId !== input.plan.operationId) {
    throw new ArchiveContractError('archive_repair_in_progress');
  }
  return existing;
}

export function assertRepairChunkPreconditions(
  storage: DurableObjectStorage,
  scope: ArchiveScope,
  state: LedgerSnapshot,
  scan: ScanState | undefined,
  input: ParsedArchiveRepairChunk,
  chunkDigest: string,
): void {
  const existing = assertRepairPlanStable(storage, input);
  if (!sameState(state, input.expected)) {
    throw new ArchiveContractError('archive_repair_precondition_failed');
  }
  if (input.plan.chunkDigests[input.chunkIndex] !== chunkDigest) {
    throw new ArchiveContractError('archive_repair_chunk_mismatch');
  }
  if (!scan || input.envelope.upload.checkpoint.source_transcript_part_id !== input.plan.partId) {
    throw new ArchiveContractError('archive_repair_precondition_failed');
  }
  if (!existing) {
    const integrity = readSessionIntegrity(storage, scope);
    if (
      input.chunkIndex !== 0 ||
      input.chunkKind !== 'rebase' ||
      input.envelope.upload.prior_checkpoint !== undefined ||
      !sameState(state, input.plan.expectedBase) ||
      JSON.stringify(scan.checkpoint) !== JSON.stringify(input.plan.expectedScan) ||
      (integrity?.operationId ?? null) !== input.plan.expectedIntegrityOperationId ||
      sameCheckpointLogicalPosition(scan.checkpoint, input.envelope.upload.checkpoint)
    ) {
      throw new ArchiveContractError('archive_repair_precondition_failed');
    }
    return;
  }
  if (
    existing.status !== 'active' ||
    input.chunkKind !== 'delta' ||
    input.chunkIndex !== existing.appliedChunks ||
    !input.envelope.upload.prior_checkpoint ||
    !sameCheckpointLogicalPosition(scan.checkpoint, input.envelope.upload.prior_checkpoint)
  ) {
    throw new ArchiveContractError('archive_repair_precondition_failed');
  }
}

export function persistArchiveRepairCommit(
  storage: DurableObjectStorage,
  commit: ArchiveRepairCommit,
): void {
  ensureArchiveRepairTables(storage);
  const existing = readArchiveRepair(storage, commit.plan.operationId);
  if (existing && existing.planDigest !== commit.planDigest) {
    throw new ArchiveContractError('pending_intent_corrupt');
  }
  if (!existing) {
    if (commit.chunkIndex !== 0 || commit.chunkKind !== 'rebase') {
      throw new ArchiveContractError('pending_intent_corrupt');
    }
    const active = readActiveArchiveRepair(storage);
    if (active) throw new ArchiveContractError('pending_intent_corrupt');
    const latch = [
      ...storage.sql.exec<{ operation_id: string }>(
        'SELECT operation_id FROM ledger_integrity_state WHERE id = 1',
      ),
    ][0];
    if ((latch?.operation_id ?? null) !== commit.plan.expectedIntegrityOperationId) {
      throw new ArchiveContractError('pending_intent_corrupt');
    }
    storage.sql.exec(
      'INSERT INTO ledger_repair_fingerprints (operation_id, fingerprint_index, data) SELECT ?, fingerprint_index, data FROM ledger_scan_fingerprints WHERE part_id = ?',
      commit.plan.operationId,
      commit.plan.partId,
    );
    const state: StoredArchiveRepair = {
      plan: commit.plan,
      planDigest: commit.planDigest,
      status: 'active',
      appliedChunks: 1,
    };
    storage.sql.exec(
      'INSERT INTO ledger_repairs (operation_id, part_id, status, data) VALUES (?, ?, ?, ?)',
      commit.plan.operationId,
      commit.plan.partId,
      'active',
      JSON.stringify(state),
    );
    if (commit.plan.expectedIntegrityOperationId !== null) {
      storage.sql.exec(
        'DELETE FROM ledger_integrity_state WHERE id = 1 AND operation_id = ?',
        commit.plan.expectedIntegrityOperationId,
      );
    }
    return;
  }
  if (
    existing.status !== 'active' ||
    commit.chunkKind !== 'delta' ||
    commit.chunkIndex !== existing.appliedChunks
  ) {
    throw new ArchiveContractError('pending_intent_corrupt');
  }
  const updated = { ...existing, appliedChunks: existing.appliedChunks + 1 };
  storage.sql.exec(
    "UPDATE ledger_repairs SET data = ? WHERE operation_id = ? AND status = 'active'",
    JSON.stringify(updated),
    commit.plan.operationId,
  );
}

export function finalizeArchiveRepairState(
  storage: DurableObjectStorage,
  operationId: string,
  expected: ArchiveRepairStateExpectation,
): StoredArchiveRepair {
  const repair = readArchiveRepair(storage, operationId);
  if (repair?.status !== 'active') {
    throw new ArchiveContractError('archive_repair_precondition_failed');
  }
  const finalized: StoredArchiveRepair = { ...repair, status: 'finalized', finalState: expected };
  storage.transactionSync(() => {
    storage.sql.exec(
      "UPDATE ledger_repairs SET status = 'finalized', data = ? WHERE operation_id = ? AND status = 'active'",
      JSON.stringify(finalized),
      operationId,
    );
  });
  return finalized;
}

export function archivedRepairFingerprintCount(
  storage: DurableObjectStorage,
  operationId: string,
): number {
  ensureArchiveRepairTables(storage);
  return (
    [
      ...storage.sql.exec<{ count: number }>(
        'SELECT COUNT(*) AS count FROM ledger_repair_fingerprints WHERE operation_id = ?',
        operationId,
      ),
    ][0]?.count ?? 0
  );
}
