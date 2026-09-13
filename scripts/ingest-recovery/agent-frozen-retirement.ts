import {
  validateLegacyRetirementProof,
  validateLegacyRetirementRecord,
  type LegacyRetirementProof,
  type LegacyRetirementRecord,
} from '../../apps/agent-consumer/src/legacy-retirement';
import { canonicalDeliveryFence, type CanonicalHashIndex } from './agent-canonical-index';
import type { FrozenVerificationReport } from './agent-frozen-verification';

export function retirementProof(
  report: FrozenVerificationReport,
  index: CanonicalHashIndex,
  migrationState: unknown,
): LegacyRetirementProof {
  if (!report.eligibleForLegacyRetirement || report.missing !== 0 || report.conflicts !== 0) {
    throw new Error('Frozen verification did not authorize legacy retirement');
  }
  const state = migrationState as {
    migration?: { complete?: unknown; proofSha256?: unknown };
  };
  if (state?.migration?.complete !== true || !isSha256(state.migration.proofSha256)) {
    throw new Error('Completed migration proof is unavailable');
  }
  const deliverySequence = canonicalDeliveryFence(migrationState);
  if (index.exportDeliverySequence !== deliverySequence) {
    throw new Error('Canonical verification fence does not match retirement');
  }
  return validateLegacyRetirementProof({
    verificationSha256: report.verificationSha256,
    migrationProofSha256: state.migration.proofSha256,
    deliverySequence,
    oldestDay: index.oldestDay,
    todayDay: index.todayDay,
    frozenFactCount: report.total,
  });
}

export function existingRetirement(migrationState: unknown): LegacyRetirementRecord | null {
  const state = migrationState as { legacy?: { retirement?: unknown } };
  if (state?.legacy?.retirement === null || state?.legacy?.retirement === undefined) return null;
  return validateLegacyRetirementRecord(state.legacy.retirement);
}

export function recordedRetirementProof(record: LegacyRetirementRecord): LegacyRetirementProof {
  return {
    verificationSha256: record.verificationSha256,
    migrationProofSha256: record.migrationProofSha256,
    deliverySequence: record.deliverySequence,
    oldestDay: record.oldestDay,
    todayDay: record.todayDay,
    frozenFactCount: record.frozenFactCount,
  };
}

export function assertCompletedRetirement(
  result: unknown,
  proof: LegacyRetirementProof,
): LegacyRetirementRecord {
  const record = validateLegacyRetirementRecord(result);
  if (record.state !== 'complete') throw new Error('Legacy retirement did not complete');
  for (const [key, value] of Object.entries(proof)) {
    if (record[key as keyof LegacyRetirementProof] !== value) {
      throw new Error('Legacy retirement result does not match verified proof');
    }
  }
  return record;
}

const isSha256 = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
