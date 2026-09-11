import { requireRecoveryReason } from '@trace-flow/tinybird-client';

export interface InspectFactRepairCapacityInput {
  afterRepairId?: number;
  limit?: number;
}

export interface FactRepairCompactionCandidate {
  repairId: number;
  recoveryId: number;
  dataBytes: number;
  proofSha256: string;
}

export interface FactRepairCapacityIssue {
  repairId: number;
  reason: string;
}

export interface InspectFactRepairCapacityResult {
  databaseSizeBytes: number;
  startupBlockedReason: string | null;
  queuedRows: number;
  alarmScheduledAtMs: number | null;
  highestRepairId: number | null;
  scannedRows: number;
  scannedDataBytes: number;
  inspectedPayloadBytes: number;
  legacyRows: number;
  emptyRows: number;
  candidateRows: number;
  candidateBytes: number;
  candidates: FactRepairCompactionCandidate[];
  compactedRepairs: FactRepairCompactionCandidate[];
  issues: FactRepairCapacityIssue[];
  nextAfterRepairId: number | null;
}

export interface CompactFactRepairDuplicatesInput {
  reason: string;
  candidates: Pick<FactRepairCompactionCandidate, 'repairId' | 'proofSha256'>[];
}

export interface CompactedFactRepairDuplicate {
  repairId: number;
  recoveryId: number;
  clearedInlineBytes: number;
  proofSha256: string;
}

export interface CompactFactRepairDuplicatesResult {
  databaseSizeBeforeBytes: number;
  databaseSizeAfterBytes: number;
  compacted: CompactedFactRepairDuplicate[];
  failure: { repairId: number; reason: string } | null;
  remainingRepairIds: number[];
  startupBlockedReason: string | null;
}

export interface QuiesceFactRepairCapacityInput {
  expectedAlarmScheduledAtMs: number;
  reason: string;
}

export interface QuiesceFactRepairCapacityResult {
  clearedAlarmScheduledAtMs: number;
  alarmScheduledAtMs: null;
  databaseSizeBytes: number;
  queuedRows: number;
}

export function validateInspectionInput(input: InspectFactRepairCapacityInput) {
  if (!input || typeof input !== 'object') throw new Error('invalid repair inspection input');
  const afterRepairId = input.afterRepairId ?? 0;
  const limit = input.limit ?? DEFAULT_INSPECTION_LIMIT;
  if (!Number.isSafeInteger(afterRepairId) || afterRepairId < 0) {
    throw new Error('invalid repair cursor');
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_INSPECTION_LIMIT) {
    throw new Error(`repair inspection limit must be between 1 and ${MAX_INSPECTION_LIMIT}`);
  }
  return { afterRepairId, limit };
}

export function validateCompactionInput(input: CompactFactRepairDuplicatesInput) {
  if (!input || typeof input !== 'object') {
    throw new Error('invalid fact repair compaction input');
  }
  requireRecoveryReason(input.reason);
  if (
    !Array.isArray(input.candidates) ||
    input.candidates.length < 1 ||
    input.candidates.length > 25
  ) {
    throw new Error('fact repair compaction requires between 1 and 25 candidates');
  }
  const candidates = input.candidates.map((candidate) => ({
    repairId: validatePositiveInteger(candidate?.repairId, 'repair ID'),
    proofSha256: validateSha256(candidate?.proofSha256, 'repair proof'),
  }));
  if (new Set(candidates.map(({ repairId }) => repairId)).size !== candidates.length) {
    throw new Error('fact repair compaction candidates must be unique');
  }
  return candidates;
}

export function validateQuiescenceInput(input: QuiesceFactRepairCapacityInput) {
  if (!input || typeof input !== 'object') {
    throw new Error('invalid fact repair quiescence input');
  }
  if (
    !Number.isSafeInteger(input.expectedAlarmScheduledAtMs) ||
    input.expectedAlarmScheduledAtMs < 1
  ) {
    throw new Error('invalid expected fact repair alarm');
  }
  requireRecoveryReason(input.reason);
  return input.expectedAlarmScheduledAtMs;
}

export function compactionFailure(
  databaseSizeBeforeBytes: number,
  databaseSizeAfterBytes: number,
  compacted: CompactedFactRepairDuplicate[],
  candidates: { repairId: number }[],
  index: number,
  repairId: number,
  reason: string,
): CompactFactRepairDuplicatesResult {
  return {
    databaseSizeBeforeBytes,
    databaseSizeAfterBytes,
    compacted,
    failure: { repairId, reason },
    remainingRepairIds: candidates.slice(index + 1).map((candidate) => candidate.repairId),
    startupBlockedReason: null,
  };
}

function validatePositiveInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error(`invalid ${name}`);
  return value as number;
}

function validateSha256(value: unknown, name: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`invalid ${name}`);
  }
  return value;
}

const DEFAULT_INSPECTION_LIMIT = 10;
const MAX_INSPECTION_LIMIT = 25;
