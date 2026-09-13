import type { DurableObjectStorage } from '@cloudflare/workers-types';

export interface LegacyRetirementProof {
  verificationSha256: string;
  migrationProofSha256: string;
  deliverySequence: number;
  oldestDay: string;
  todayDay: string;
  frozenFactCount: number;
}

export interface LegacyRetirementRecord extends LegacyRetirementProof {
  state: 'intent' | 'complete';
  completedAtMs: number | null;
}

interface StoredLegacyRetirement extends Record<string, string | number | null> {
  verification_sha256: string;
  migration_proof_sha256: string;
  delivery_sequence: number;
  oldest_day: string;
  today_day: string;
  frozen_fact_count: number;
  state: 'intent' | 'complete';
  completed_at_ms: number | null;
}

export function initializeLegacyRetirement(storage: DurableObjectStorage): void {
  storage.sql.exec(`
    CREATE TABLE IF NOT EXISTS legacy_retirement (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      verification_sha256 TEXT NOT NULL,
      migration_proof_sha256 TEXT NOT NULL,
      delivery_sequence INTEGER NOT NULL,
      oldest_day TEXT NOT NULL,
      today_day TEXT NOT NULL,
      frozen_fact_count INTEGER NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('intent', 'complete')),
      completed_at_ms INTEGER
    )
  `);
}

export function readLegacyRetirement(storage: DurableObjectStorage): LegacyRetirementRecord | null {
  const row = [
    ...storage.sql.exec<StoredLegacyRetirement>(
      `SELECT verification_sha256,migration_proof_sha256,delivery_sequence,
              oldest_day,today_day,frozen_fact_count,state,completed_at_ms
       FROM legacy_retirement WHERE singleton = 1`,
    ),
  ][0];
  return row ? validateLegacyRetirementRecord(fromStored(row)) : null;
}

export function beginLegacyRetirement(
  storage: DurableObjectStorage,
  input: LegacyRetirementProof,
): LegacyRetirementRecord {
  const proof = validateLegacyRetirementProof(input);
  return storage.transactionSync(() => {
    const existing = readLegacyRetirement(storage);
    if (existing) {
      if (!sameProof(existing, proof)) throw new Error('legacy retirement proof conflict');
      return existing;
    }
    storage.sql.exec(
      `INSERT INTO legacy_retirement
       (singleton,verification_sha256,migration_proof_sha256,delivery_sequence,
        oldest_day,today_day,frozen_fact_count,state,completed_at_ms)
       VALUES (1,?,?,?,?,?,?,'intent',NULL)`,
      proof.verificationSha256,
      proof.migrationProofSha256,
      proof.deliverySequence,
      proof.oldestDay,
      proof.todayDay,
      proof.frozenFactCount,
    );
    return { ...proof, state: 'intent', completedAtMs: null };
  });
}

export function completeLegacyRetirement(
  storage: DurableObjectStorage,
  verificationSha256: string,
  now: number,
): LegacyRetirementRecord {
  return storage.transactionSync(() => {
    const existing = readLegacyRetirement(storage);
    if (existing?.verificationSha256 !== verificationSha256) {
      throw new Error('legacy retirement completion conflict');
    }
    if (existing.state === 'complete') return existing;
    storage.sql.exec(
      `UPDATE legacy_retirement SET state='complete',completed_at_ms=? WHERE singleton=1`,
      now,
    );
    return { ...existing, state: 'complete', completedAtMs: now };
  });
}

export function validateLegacyRetirementProof(input: unknown): LegacyRetirementProof {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('invalid legacy retirement proof');
  }
  const value = input as Record<string, unknown>;
  const keys = [
    'deliverySequence',
    'frozenFactCount',
    'migrationProofSha256',
    'oldestDay',
    'todayDay',
    'verificationSha256',
  ];
  if (
    JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(keys) ||
    !isSha256(value.verificationSha256) ||
    !isSha256(value.migrationProofSha256) ||
    !Number.isSafeInteger(value.deliverySequence) ||
    (value.deliverySequence as number) < 1 ||
    !Number.isSafeInteger(value.frozenFactCount) ||
    (value.frozenFactCount as number) < 0 ||
    !isDay(value.oldestDay) ||
    !isDay(value.todayDay) ||
    value.oldestDay > value.todayDay
  ) {
    throw new Error('invalid legacy retirement proof');
  }
  return input as LegacyRetirementProof;
}

export function validateLegacyRetirementRecord(input: unknown): LegacyRetirementRecord {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('invalid legacy retirement record');
  }
  const value = input as Record<string, unknown>;
  const keys = [
    'completedAtMs',
    'deliverySequence',
    'frozenFactCount',
    'migrationProofSha256',
    'oldestDay',
    'state',
    'todayDay',
    'verificationSha256',
  ];
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(keys)) {
    throw new Error('invalid legacy retirement record');
  }
  validateLegacyRetirementProof({
    verificationSha256: value.verificationSha256,
    migrationProofSha256: value.migrationProofSha256,
    deliverySequence: value.deliverySequence,
    oldestDay: value.oldestDay,
    todayDay: value.todayDay,
    frozenFactCount: value.frozenFactCount,
  });
  if (
    (value.state === 'intent' && value.completedAtMs !== null) ||
    (value.state === 'complete' &&
      (!Number.isSafeInteger(value.completedAtMs) || (value.completedAtMs as number) < 1))
  ) {
    throw new Error('invalid legacy retirement record');
  }
  if (!['intent', 'complete'].includes(value.state as string)) {
    throw new Error('invalid legacy retirement record');
  }
  return input as LegacyRetirementRecord;
}

function fromStored(row: StoredLegacyRetirement): LegacyRetirementRecord {
  return {
    verificationSha256: row.verification_sha256,
    migrationProofSha256: row.migration_proof_sha256,
    deliverySequence: row.delivery_sequence,
    oldestDay: row.oldest_day,
    todayDay: row.today_day,
    frozenFactCount: row.frozen_fact_count,
    state: row.state,
    completedAtMs: row.completed_at_ms,
  };
}

function sameProof(record: LegacyRetirementRecord, proof: LegacyRetirementProof): boolean {
  return Object.entries(proof).every(
    ([key, value]) => record[key as keyof LegacyRetirementProof] === value,
  );
}

const isSha256 = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const isDay = (value: unknown): value is string =>
  typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
