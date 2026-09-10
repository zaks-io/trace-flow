import type { Category } from './facts';

export interface BeginFactRebuildInput {
  operationId: string;
  executorId: string;
  reason: string;
  tinybirdWorkspaceId: string;
  tinybirdTokenFingerprints: string[];
}

export interface BeginFactRebuildResult {
  status: 'quiescent' | 'retry-needed' | 'completed';
  operationId: string;
  reason: string;
  startedAtMs: number;
  expectedFactCount: number;
  tinybirdTokenFingerprint: string;
  tinybirdWorkspaceId: string;
  tinybirdHost: string;
}

export interface RebuildFactCursor {
  category: Category;
  factId: string;
}

export interface ListRebuildFactsInput {
  operationId: string;
  executorId: string;
  after?: RebuildFactCursor;
  limit?: number;
}

export interface RebuildPendingFact {
  table: 'clean' | 'legacy';
  rowId: number;
  contentHash: string | null;
  payload: string | null;
  missingPayload: boolean;
}

export interface RebuildFact {
  category: Category;
  factId: string;
  contentHash: string;
  payload: string | null;
  missingPayload: boolean;
  replacement?: {
    contentHash: string;
    payload: string;
    recoveryId: number;
  };
  pending: RebuildPendingFact[];
}

export interface ListRebuildFactsResult {
  facts: RebuildFact[];
  nextAfter: RebuildFactCursor | null;
  serializedBytes: number;
}

export interface FactRebuildConfirmation {
  category: Category;
  factId: string;
  expectedOldHash: string;
  newHash: string;
  row: unknown;
}

export interface FactRecoveryConfirmation {
  recoveryId: number;
  expectedPayloadHash: string;
}

export interface StageFactRebuildInput {
  phase: 'stage';
  operationId: string;
  executorId: string;
  reason: string;
  confirmations: FactRebuildConfirmation[];
  repairRecoveryConfirmations?: FactRecoveryConfirmation[];
  insertRecoveryConfirmations?: FactRecoveryConfirmation[];
}

export interface FinalizeFactRebuildInput {
  phase: 'finalize';
  operationId: string;
  executorId: string;
  reason: string;
  proof: {
    backupSha256: string;
    canonicalFingerprint: string;
    legacyFingerprint: string;
  };
}

export type CompleteFactRebuildInput = StageFactRebuildInput | FinalizeFactRebuildInput;

export interface CompleteFactRebuildResult {
  status: 'staged' | 'completed';
  operationId: string;
  confirmedFactCount: number;
  expectedFactCount: number;
  resolvedRepairRecords?: number;
  resolvedInsertRecords?: number;
}
