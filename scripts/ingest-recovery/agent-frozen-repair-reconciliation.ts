import { createHash } from 'node:crypto';
import type { RecoveryRecord } from '../../packages/tinybird-client/src/recovery';
import {
  factIngestedAtMs,
  factPartitionKey,
  rowIdentity,
  ROW_IDENTITY_FIELDS,
  stableHash,
} from '../../apps/agent-consumer/src/facts';
import type {
  FrozenRepairDisposition,
  ReconcileFrozenRepairInput,
} from '../../apps/agent-consumer/src/frozen-repair-reconciliation-contract';
import { CATEGORIES, type Category, type Row } from './agent-data';
import type { CanonicalHashIndex } from './agent-canonical-index';
import type { FrozenRepairReconciliationJournal } from './agent-frozen-repair-journal';
import { normalized, type AgentRecoveryClient } from './agent-transport';

export interface FrozenRepairReconciliationReport {
  total: number;
  exact: number;
  superseded: number;
  expired: number;
  storage: {
    batches: number;
    databaseSizeBeforeBytes: number | null;
    databaseSizeAfterBytes: number | null;
    releasedRecoveryBytes: number;
    hydratedRepairBytes: number;
    tombstoneBytes: number;
  };
}

interface ReconciliationFence {
  migrationProofSha256: string;
  deliverySequence: number;
  fullVerificationSha256: string;
}

export async function reconcileAllFrozenRepairs(
  recovery: AgentRecoveryClient,
  index: CanonicalHashIndex,
  fence: ReconciliationFence,
  journal: FrozenRepairReconciliationJournal,
): Promise<FrozenRepairReconciliationReport> {
  if (!index.complete || index.exportDeliverySequence !== fence.deliverySequence) {
    throw new Error('Frozen repair reconciliation requires the complete canonical index fence');
  }
  if (!journal.complete) {
    let afterId = journal.afterId;
    for (let pageNumber = 0; pageNumber < 100_000; pageNumber++) {
      const page = await recovery.call('listRecovery', { afterId, state: 'blocked', limit: 100 });
      if (!page || !Array.isArray(page.records) || page.records.length > 100) {
        throw new Error('Invalid blocked recovery page');
      }
      const entries = page.records.map((value: unknown) => {
        const record = validateBlockedRepair(value);
        return { record, proof: repairProof(recovery.org, record, index, fence) };
      });
      journal.appendPage(entries, page.nextAfterId);
      if (page.nextAfterId === null) break;
      afterId = page.nextAfterId;
    }
    if (!journal.complete) throw new Error('Blocked recovery page bound exceeded');
  }
  journal.assertReadyToMutate();
  while (true) {
    const batch = journal.nextPendingBatch();
    if (batch.length === 0) return journal.report();
    const result = await recovery.call('reconcileFrozenRepairs', { repairs: batch });
    if (
      !result ||
      !Array.isArray(result.resolved) ||
      result.resolved.length !== batch.length ||
      result.resolved.some(
        (resolved: any, index: number) =>
          resolved?.recoveryId !== batch[index]!.recoveryId ||
          resolved.resolution !== `frozen-journal-${batch[index]!.disposition}`,
      )
    ) {
      throw new Error('Frozen repair reconciliation returned an invalid resolution');
    }
    const storage = validateStorageResult(result.storage);
    journal.confirm(batch, storage);
  }
}

function validateStorageResult(value: unknown): {
  databaseSizeBeforeBytes: number;
  databaseSizeAfterBytes: number;
  releasedRecoveryBytes: number;
  hydratedRepairBytes: number;
  tombstoneBytes: number;
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Frozen repair reconciliation returned invalid storage measurements');
  }
  const storage = value as Record<string, unknown>;
  const values = [
    storage.databaseSizeBeforeBytes,
    storage.databaseSizeAfterBytes,
    storage.releasedRecoveryBytes,
    storage.hydratedRepairBytes,
    storage.tombstoneBytes,
  ];
  if (
    values.some((item) => !Number.isSafeInteger(item) || Number(item) < 0) ||
    Number(storage.databaseSizeAfterBytes) > Number(storage.databaseSizeBeforeBytes) ||
    Number(storage.releasedRecoveryBytes) < Number(storage.hydratedRepairBytes)
  ) {
    throw new Error('Frozen repair reconciliation returned invalid storage measurements');
  }
  return storage as ReturnType<typeof validateStorageResult>;
}

function repairProof(
  orgId: string,
  record: RecoveryRecord,
  index: CanonicalHashIndex,
  fence: ReconciliationFence,
): ReconcileFrozenRepairInput {
  const outcome = parseObject(record.outcome, 'repair outcome');
  const row = parseObject(record.payload, 'repair payload') as Row;
  if (
    !hasExactKeys(outcome, ['category', 'factId', 'newHash', 'oldHash', 'originalPayload']) ||
    !(CATEGORIES as readonly unknown[]).includes(outcome.category) ||
    typeof outcome.factId !== 'string' ||
    !outcome.factId
  ) {
    throw new Error(`Blocked repair ${record.id} has invalid identity metadata`);
  }
  const category = outcome.category as Category;
  if (
    row.OrgId !== orgId ||
    rowIdentity(row, ROW_IDENTITY_FIELDS[category]) !== outcome.factId ||
    stableHash(row) !== outcome.newHash
  ) {
    throw new Error(`Blocked repair ${record.id} payload does not match its identity metadata`);
  }
  const schema = index.sourceSchema(category);
  if (!schema) throw new Error(`Canonical index has no ${category} source schema`);
  const sourceEventDay = factPartitionKey(category, row);
  const sourceIngestedAtMs = factIngestedAtMs(row);
  const sourceRowSha256 = sha256(JSON.stringify(normalized(row, schema.meta)));
  const current = index.get(category, outcome.factId);
  let disposition: FrozenRepairDisposition;
  if (sourceEventDay < index.oldestDay) {
    disposition = 'expired';
  } else if (!current) {
    throw new Error(`Blocked repair ${record.id} is missing from retained canonical facts`);
  } else if (current.rowSha256 === sourceRowSha256) {
    disposition = 'exact';
  } else if (current.ingestedAtMs > sourceIngestedAtMs) {
    disposition = 'superseded';
  } else {
    throw new Error(`Blocked repair ${record.id} conflicts with canonical facts`);
  }
  return {
    recoveryId: record.id,
    expectedPayloadSha256: sha256(record.payload),
    expectedOutcomeSha256: sha256(record.outcome),
    orgId,
    category,
    factId: outcome.factId,
    migrationProofSha256: fence.migrationProofSha256,
    deliverySequence: fence.deliverySequence,
    oldestDay: index.oldestDay,
    todayDay: index.todayDay,
    fullVerificationSha256: fence.fullVerificationSha256,
    disposition,
    sourceEventDay,
    sourceIngestedAtMs,
    sourceRowSha256,
    canonical:
      disposition === 'expired'
        ? null
        : {
            eventDay: current!.eventDay,
            deliverySequence: current!.deliverySequence,
            contentHash: current!.contentHash,
            ingestedAtMs: current!.ingestedAtMs,
            rowSha256: current!.rowSha256,
          },
  };
}

function validateBlockedRepair(value: unknown): RecoveryRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid blocked recovery record');
  }
  const record = value as RecoveryRecord;
  if (!Number.isSafeInteger(record.id) || record.id < 1 || record.state !== 'blocked') {
    throw new Error('Invalid blocked recovery record');
  }
  if (record.kind !== 'repair') {
    throw new Error(
      `Blocked ${record.kind || 'unknown'} recovery ${record.id} prevents repair reconciliation`,
    );
  }
  if (
    record.classification !== 'changed' ||
    record.target !== null ||
    typeof record.payload !== 'string' ||
    typeof record.outcome !== 'string'
  ) {
    throw new Error(`Blocked repair ${record.id} has invalid recovery metadata`);
  }
  return record;
}

function parseObject(value: string, label: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch {
    throw new Error(`Invalid ${label}`);
  }
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return (
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
  );
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
