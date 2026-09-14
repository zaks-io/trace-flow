import { CATEGORIES, type Category } from './facts';

const SHA256 = /^[0-9a-f]{64}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MAX_RECONCILIATION_PROOFS = 100;
const MAX_RECONCILIATION_BYTES = 128 * 1024;

export type FrozenRepairDisposition = 'exact' | 'superseded' | 'expired';

export interface FrozenRepairCanonicalProof {
  eventDay: string;
  deliverySequence: number;
  contentHash: string;
  ingestedAtMs: number;
  rowSha256: string;
}

export interface ReconcileFrozenRepairInput {
  recoveryId: number;
  expectedPayloadSha256: string;
  expectedOutcomeSha256: string;
  orgId: string;
  category: Category;
  factId: string;
  migrationProofSha256: string;
  deliverySequence: number;
  oldestDay: string;
  todayDay: string;
  fullVerificationSha256: string;
  disposition: FrozenRepairDisposition;
  sourceEventDay: string;
  sourceIngestedAtMs: number;
  sourceRowSha256: string;
  canonical: FrozenRepairCanonicalProof | null;
}

export interface ReconcileFrozenRepairsInput {
  repairs: ReconcileFrozenRepairInput[];
}

export interface ReconcileFrozenRepairsResult {
  resolved: { recoveryId: number; resolution: string }[];
  storage: {
    databaseSizeBeforeBytes: number;
    databaseSizeAfterBytes: number;
    releasedRecoveryBytes: number;
    hydratedRepairBytes: number;
    tombstoneBytes: number;
  };
}

export function validateReconcileFrozenRepairsInput(value: unknown): ReconcileFrozenRepairInput[] {
  assertRecord(value);
  assertExactKeys(value, ['repairs']);
  if (
    !Array.isArray(value.repairs) ||
    value.repairs.length < 1 ||
    value.repairs.length > MAX_RECONCILIATION_PROOFS ||
    new TextEncoder().encode(JSON.stringify(value)).byteLength > MAX_RECONCILIATION_BYTES
  ) {
    throw new Error('frozen repair reconciliation batch exceeds its bound');
  }
  const repairs = value.repairs.map(validateReconcileFrozenRepairInput);
  if (new Set(repairs.map(({ recoveryId }) => recoveryId)).size !== repairs.length) {
    throw new Error('frozen repair reconciliation batch contains duplicate records');
  }
  const fence = repairs[0]!;
  if (
    repairs.some(
      (repair) =>
        repair.orgId !== fence.orgId ||
        repair.migrationProofSha256 !== fence.migrationProofSha256 ||
        repair.deliverySequence !== fence.deliverySequence ||
        repair.oldestDay !== fence.oldestDay ||
        repair.todayDay !== fence.todayDay ||
        repair.fullVerificationSha256 !== fence.fullVerificationSha256,
    )
  ) {
    throw new Error('frozen repair reconciliation batch mixes verification fences');
  }
  return repairs;
}

export function validateReconcileFrozenRepairInput(value: unknown): ReconcileFrozenRepairInput {
  assertRecord(value);
  assertExactKeys(value, [
    'canonical',
    'category',
    'deliverySequence',
    'disposition',
    'expectedOutcomeSha256',
    'expectedPayloadSha256',
    'factId',
    'fullVerificationSha256',
    'migrationProofSha256',
    'oldestDay',
    'orgId',
    'recoveryId',
    'sourceEventDay',
    'sourceIngestedAtMs',
    'sourceRowSha256',
    'todayDay',
  ]);
  if (!Number.isSafeInteger(value.recoveryId) || Number(value.recoveryId) < 1) {
    throw new Error('invalid frozen repair recovery ID');
  }
  if (typeof value.orgId !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(value.orgId)) {
    throw new Error('invalid frozen repair organization');
  }
  if (!(CATEGORIES as readonly unknown[]).includes(value.category)) {
    throw new Error('invalid frozen repair category');
  }
  if (typeof value.factId !== 'string' || !value.factId || value.factId.length > 4096) {
    throw new Error('invalid frozen repair fact identity');
  }
  for (const [label, hash] of [
    ['payload', value.expectedPayloadSha256],
    ['outcome', value.expectedOutcomeSha256],
    ['migration', value.migrationProofSha256],
    ['full verification', value.fullVerificationSha256],
    ['source row', value.sourceRowSha256],
  ] as const) {
    if (typeof hash !== 'string' || !SHA256.test(hash)) {
      throw new Error(`invalid frozen repair ${label} SHA256`);
    }
  }
  if (!Number.isSafeInteger(value.deliverySequence) || Number(value.deliverySequence) < 1) {
    throw new Error('invalid frozen repair delivery sequence');
  }
  if (
    typeof value.oldestDay !== 'string' ||
    !DAY.test(value.oldestDay) ||
    typeof value.todayDay !== 'string' ||
    !DAY.test(value.todayDay) ||
    value.oldestDay > value.todayDay ||
    typeof value.sourceEventDay !== 'string' ||
    !DAY.test(value.sourceEventDay)
  ) {
    throw new Error('invalid frozen repair retention window');
  }
  if (!Number.isSafeInteger(value.sourceIngestedAtMs) || Number(value.sourceIngestedAtMs) < 0) {
    throw new Error('invalid frozen repair source ingestion time');
  }
  if (!['exact', 'superseded', 'expired'].includes(String(value.disposition))) {
    throw new Error('invalid frozen repair disposition');
  }
  const canonical = validateCanonical(
    value.canonical,
    Number(value.deliverySequence),
    value.oldestDay,
    value.todayDay,
  );
  if (value.disposition === 'expired') {
    if (value.sourceEventDay >= value.oldestDay || canonical !== null) {
      throw new Error('invalid expired frozen repair proof');
    }
  } else {
    if (
      value.sourceEventDay < value.oldestDay ||
      value.sourceEventDay > value.todayDay ||
      !canonical
    ) {
      throw new Error('invalid retained frozen repair proof');
    }
    if (
      value.disposition === 'exact' &&
      (canonical.rowSha256 !== value.sourceRowSha256 ||
        canonical.ingestedAtMs !== value.sourceIngestedAtMs)
    ) {
      throw new Error('invalid exact frozen repair proof');
    }
    if (
      value.disposition === 'superseded' &&
      canonical.ingestedAtMs <= Number(value.sourceIngestedAtMs)
    ) {
      throw new Error('invalid superseded frozen repair proof');
    }
  }
  return {
    recoveryId: Number(value.recoveryId),
    expectedPayloadSha256: value.expectedPayloadSha256 as string,
    expectedOutcomeSha256: value.expectedOutcomeSha256 as string,
    orgId: value.orgId,
    category: value.category as Category,
    factId: value.factId,
    migrationProofSha256: value.migrationProofSha256 as string,
    deliverySequence: Number(value.deliverySequence),
    oldestDay: value.oldestDay,
    todayDay: value.todayDay,
    fullVerificationSha256: value.fullVerificationSha256 as string,
    disposition: value.disposition as FrozenRepairDisposition,
    sourceEventDay: value.sourceEventDay,
    sourceIngestedAtMs: Number(value.sourceIngestedAtMs),
    sourceRowSha256: value.sourceRowSha256 as string,
    canonical,
  };
}

function validateCanonical(
  value: unknown,
  deliveryFence: number,
  oldestDay: string,
  todayDay: string,
): FrozenRepairCanonicalProof | null {
  if (value === null) return null;
  assertRecord(value);
  assertExactKeys(value, [
    'contentHash',
    'deliverySequence',
    'eventDay',
    'ingestedAtMs',
    'rowSha256',
  ]);
  if (
    typeof value.eventDay !== 'string' ||
    !DAY.test(value.eventDay) ||
    value.eventDay < oldestDay ||
    value.eventDay > todayDay ||
    !Number.isSafeInteger(value.deliverySequence) ||
    Number(value.deliverySequence) < 1 ||
    Number(value.deliverySequence) > deliveryFence ||
    typeof value.contentHash !== 'string' ||
    !SHA256.test(value.contentHash) ||
    !Number.isSafeInteger(value.ingestedAtMs) ||
    Number(value.ingestedAtMs) < 0 ||
    typeof value.rowSha256 !== 'string' ||
    !SHA256.test(value.rowSha256)
  ) {
    throw new Error('invalid frozen repair canonical proof');
  }
  return {
    eventDay: value.eventDay,
    deliverySequence: Number(value.deliverySequence),
    contentHash: value.contentHash,
    ingestedAtMs: Number(value.ingestedAtMs),
    rowSha256: value.rowSha256,
  };
}

function assertRecord(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('invalid frozen repair reconciliation proof');
  }
}

function assertExactKeys(value: Record<string, unknown>, keys: string[]): void {
  if (Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) {
    throw new Error('invalid frozen repair reconciliation proof');
  }
}
