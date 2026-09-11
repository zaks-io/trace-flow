import type { RecoveryRecord, TinybirdRecoveryStore } from '@trace-flow/tinybird-client';
import {
  CATEGORIES,
  ROW_IDENTITY_FIELDS,
  factIngestedAtMs,
  rowIdentity,
  stableHash,
  type Category,
} from './facts';

export interface StoredFactRepair {
  [key: string]: string | number | null;
  id: number;
  category: string;
  fact_id: string;
  old_hash: string;
  new_hash: string;
  seen_at_ms: number;
  data: string | null;
  recovery_dedupe_key: string | null;
}

export interface VerifiedFactRepairDuplicate {
  row: StoredFactRepair;
  recovery: RecoveryRecord;
  dataBytes: number;
  proofSha256: string;
}

export type FactRepairVerification<T> =
  | { verified: true; value: T }
  | { verified: false; reason: string };

export class FactRepairProof {
  constructor(private readonly recovery: TinybirdRecoveryStore) {}

  async verify(
    row: StoredFactRepair,
    orgId: string,
  ): Promise<FactRepairVerification<VerifiedFactRepairDuplicate>> {
    const verification = this.verifySync(row, orgId);
    if (!verification.verified) return verification;
    return {
      verified: true,
      value: {
        ...verification.value,
        proofSha256: await sha256Hex(
          JSON.stringify([
            row.id,
            row.category,
            row.fact_id,
            row.old_hash,
            row.new_hash,
            row.seen_at_ms,
            row.recovery_dedupe_key,
            row.data,
            verification.value.recovery.id,
            verification.value.recovery.payload,
            verification.value.recovery.outcome,
          ]),
        ),
      },
    };
  }

  async verifyCompacted(
    row: StoredFactRepair,
    orgId: string,
  ): Promise<FactRepairVerification<VerifiedFactRepairDuplicate>> {
    if (row.data !== null) return issue('fact repair still has inline payload data');
    if (!row.recovery_dedupe_key) return issue('recovery dedupe key is absent');
    const recovery = this.recovery.repairByDedupeKey(row.recovery_dedupe_key);
    if (!recovery) return issue('matching repair recovery is absent');
    return this.verify({ ...row, data: recovery.payload }, orgId);
  }

  verifySync(
    row: StoredFactRepair,
    orgId: string,
  ): FactRepairVerification<Omit<VerifiedFactRepairDuplicate, 'proofSha256'>> {
    if (!row.data) return issue('inline payload is empty');
    if (!row.recovery_dedupe_key) return issue('recovery dedupe key is absent');
    if (!isCategory(row.category)) return issue('repair category is invalid');
    const recovery = this.recovery.repairByDedupeKey(row.recovery_dedupe_key);
    if (!recovery) return issue('matching repair recovery is absent');
    if (
      recovery.kind !== 'repair' ||
      recovery.classification !== 'changed' ||
      recovery.target !== null
    ) {
      return issue('matching recovery metadata is invalid');
    }
    if (recovery.payload !== row.data) return issue('recovery payload differs from inline payload');
    try {
      const payload = parseRecord(row.data);
      const outcome = parseRecord(recovery.outcome);
      if (
        !hasExactKeys(outcome, ['category', 'factId', 'newHash', 'oldHash', 'originalPayload']) ||
        outcome.category !== row.category ||
        outcome.factId !== row.fact_id ||
        outcome.oldHash !== row.old_hash ||
        outcome.newHash !== row.new_hash ||
        stableHash(payload) !== row.new_hash ||
        rowIdentity(payload, ROW_IDENTITY_FIELDS[row.category]) !== row.fact_id ||
        payload.OrgId !== orgId ||
        JSON.stringify([
          row.category,
          row.fact_id,
          row.old_hash,
          row.new_hash,
          factIngestedAtMs(payload),
        ]) !== row.recovery_dedupe_key
      ) {
        return issue('repair outcome or current payload metadata differs');
      }
      if (outcome.originalPayload !== null) {
        if (typeof outcome.originalPayload !== 'string') {
          return issue('original payload is invalid');
        }
        const original = parseRecord(outcome.originalPayload);
        if (
          stableHash(original) !== row.old_hash ||
          rowIdentity(original, ROW_IDENTITY_FIELDS[row.category]) !== row.fact_id ||
          original.OrgId !== orgId
        ) {
          return issue('original payload metadata differs');
        }
      }
      return { verified: true, value: { row, recovery, dataBytes: utf8Length(row.data) } };
    } catch (error) {
      return issue(`repair payload or outcome is invalid: ${errorMessage(error)}`);
    }
  }
}

export function sameFactRepairMetadata(left: StoredFactRepair, right: StoredFactRepair): boolean {
  return (
    left.id === right.id &&
    left.category === right.category &&
    left.fact_id === right.fact_id &&
    left.old_hash === right.old_hash &&
    left.new_hash === right.new_hash &&
    left.seen_at_ms === right.seen_at_ms &&
    left.recovery_dedupe_key === right.recovery_dedupe_key
  );
}

export function sameFactRepairRow(left: StoredFactRepair, right: StoredFactRepair): boolean {
  return sameFactRepairMetadata(left, right) && left.data === right.data;
}

export function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : `non-Error value: ${String(error)}`;
}

function issue(reason: string): FactRepairVerification<never> {
  return { verified: false, reason };
}

function parseRecord(value: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('invalid object');
  }
  return parsed as Record<string, unknown>;
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return (
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
  );
}

function isCategory(value: string): value is Category {
  return (CATEGORIES as readonly string[]).includes(value);
}

async function sha256Hex(value: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)),
  );
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
