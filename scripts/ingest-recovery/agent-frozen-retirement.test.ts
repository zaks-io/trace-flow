import { expect, test } from 'bun:test';
import type { CanonicalHashIndex } from './agent-canonical-index';
import type { FrozenVerificationReport } from './agent-frozen-verification';
import {
  assertCompletedRetirement,
  existingRetirement,
  recordedRetirementProof,
  retirementProof,
} from './agent-frozen-retirement';

const verificationSha256 = 'a'.repeat(64);
const migrationProofSha256 = 'b'.repeat(64);

test('binds retirement to the full verification, migration, window, count, and sequence', () => {
  const proof = retirementProof(report(), index(), migrationState());
  expect(proof).toEqual({
    verificationSha256,
    migrationProofSha256,
    deliverySequence: 42,
    oldestDay: '2025-09-14',
    todayDay: '2026-09-13',
    frozenFactCount: 9,
  });
  const complete = { ...proof, state: 'complete' as const, completedAtMs: 1_789_000_000_000 };
  expect(
    recordedRetirementProof(existingRetirement({ legacy: { retirement: complete } })!),
  ).toEqual(proof);
  expect(assertCompletedRetirement(complete, proof)).toEqual(complete);
});

test('rejects an unsafe verification or a changed delivery fence', () => {
  expect(() => retirementProof({ ...report(), missing: 1 }, index(), migrationState())).toThrow(
    'did not authorize',
  );
  expect(() => retirementProof(report(), index(), migrationState(43))).toThrow(
    'does not match retirement',
  );
  const proof = retirementProof(report(), index(), migrationState());
  expect(() =>
    assertCompletedRetirement(
      { ...proof, verificationSha256: 'c'.repeat(64), state: 'complete', completedAtMs: 1 },
      proof,
    ),
  ).toThrow('does not match verified proof');
});

function report(): FrozenVerificationReport {
  return {
    total: 9,
    exactMatches: 7,
    safelySuperseded: 1,
    expired: 1,
    missing: 0,
    conflicts: 0,
    eligibleForLegacyRetirement: true,
    verificationSha256,
    byCategory: {} as FrozenVerificationReport['byCategory'],
  };
}

function index(): CanonicalHashIndex {
  return {
    exportDeliverySequence: 42,
    oldestDay: '2025-09-14',
    todayDay: '2026-09-13',
  } as CanonicalHashIndex;
}

function migrationState(sequence = 42) {
  return {
    migration: { complete: true, proofSha256: migrationProofSha256 },
    coordinator: { activeDeliveries: 0, lastDeliverySequence: sequence },
  };
}
