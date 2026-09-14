import { agentAnalyticsDayBounds, sha256Hex } from '@trace-flow/utils';
import type { DurableObjectStorage } from '@cloudflare/workers-types';
import type { RecoveryRecord, TinybirdRecoveryStore } from '@trace-flow/tinybird-client';
import type { AgentConsumerEnv } from './context';
import { FactRepairProof, type StoredFactRepair } from './fact-repair-proof';
import { factIngestedAtMs, factPartitionKey, rowIdentity, ROW_IDENTITY_FIELDS } from './facts';
import {
  validateReconcileFrozenRepairsInput,
  type ReconcileFrozenRepairInput,
  type ReconcileFrozenRepairsInput,
  type ReconcileFrozenRepairsResult,
} from './frozen-repair-reconciliation-contract';
import type { LegacyIngestionState } from './legacy-ingestion-state';

const MAX_DATABASE_SIZE_BYTES = 10 * 1024 ** 3;
const TRANSACTION_HEADROOM_BYTES = 1024 * 1024;

interface FrozenRepairReconciliationContext {
  storage: DurableObjectStorage;
  recovery: TinybirdRecoveryStore;
  coordinators: AgentConsumerEnv['AGENT_DELIVERY_COORDINATOR'];
  legacyState: LegacyIngestionState;
  flushInProgress: boolean;
  assertMaintenanceUnlocked(): void;
  pendingRows(): number;
  blockedRows(): number;
}

export async function reconcileFrozenRepairs(
  orgId: string,
  value: ReconcileFrozenRepairsInput,
  context: FrozenRepairReconciliationContext,
): Promise<ReconcileFrozenRepairsResult> {
  const proofs = validateReconcileFrozenRepairsInput(value);
  const fence = proofs[0]!;
  if (orgId !== fence.orgId) throw new Error('frozen repair organization does not match shard');
  context.legacyState.assertFrozen();
  context.assertMaintenanceUnlocked();
  if (context.flushInProgress || context.pendingRows() !== 0 || context.blockedRows() !== 0) {
    throw new Error('frozen repair reconciliation requires a quiescent legacy batcher');
  }

  const proofHashes = await Promise.all(proofs.map((proof) => sha256Hex(JSON.stringify(proof))));
  const inspected = await Promise.all(
    proofs.map((proof, index) => inspectRecord(orgId, proof, proofHashes[index]!, context)),
  );
  const coordinator = context.coordinators.getByName(`org:${orgId}`);
  const [migration, stats] = await Promise.all([
    coordinator.getIngestionMigrationState(),
    coordinator.getStats({}),
  ]);
  const { oldestDay, today } = agentAnalyticsDayBounds(Date.now());
  if (
    migration?.complete !== true ||
    migration.proofSha256 !== fence.migrationProofSha256 ||
    stats.activeDeliveries !== 0 ||
    stats.lastDeliverySequence !== fence.deliverySequence ||
    oldestDay !== fence.oldestDay ||
    today !== fence.todayDay
  ) {
    throw new Error('frozen repair migration proof, delivery fence, or retention window changed');
  }

  context.legacyState.assertFrozen();
  context.assertMaintenanceUnlocked();
  if (context.flushInProgress || context.pendingRows() !== 0 || context.blockedRows() !== 0) {
    throw new Error('frozen repair reconciliation lost legacy quiescence');
  }
  const current = await Promise.all(
    proofs.map((proof, index) => inspectRecord(orgId, proof, proofHashes[index]!, context)),
  );
  if (current.some((value, index) => changed(value, inspected[index]!))) {
    throw new Error('frozen repair changed during reconciliation');
  }
  const databaseSizeBeforeBytes = context.storage.sql.databaseSize;
  const unresolved = current.flatMap((value, index) =>
    value.record.state === 'blocked' ? [{ value, proof: proofs[index]!, index }] : [],
  );
  const releasedRecoveryBytes = unresolved.reduce(
    (bytes, { value }) =>
      bytes + utf8Length(value.record.payload) + utf8Length(value.record.outcome),
    0,
  );
  const hydratedRepairBytes = unresolved.reduce(
    (bytes, { value }) =>
      bytes + (value.repair.data === null ? utf8Length(value.record.payload) : 0),
    0,
  );
  const tombstoneBytes = unresolved.reduce(
    (bytes, { proof }) => bytes + utf8Length(`frozen-journal-${proof.disposition}`) + 64 + 40,
    0,
  );
  if (unresolved.length > 0) {
    const availableBytes =
      MAX_DATABASE_SIZE_BYTES - databaseSizeBeforeBytes + releasedRecoveryBytes;
    if (availableBytes < hydratedRepairBytes + tombstoneBytes + TRANSACTION_HEADROOM_BYTES) {
      throw new Error('frozen repair reconciliation has uncertain SQLite capacity headroom');
    }
  }
  const resolved =
    unresolved.length === 0
      ? []
      : context.recovery.resolveBatchWithMutation(
          unresolved.map(({ value, proof, index }) => ({
            id: value.record.id,
            resolution: `frozen-journal-${proof.disposition}`,
            reason: proofHashes[index]!,
          })),
          () => {
            for (const { value } of unresolved) {
              context.storage.sql.exec(
                'DELETE FROM recovery_payload_chunks WHERE recovery_id = ?',
                value.record.id,
              );
              context.storage.sql.exec(
                'DELETE FROM recovery_outcome_chunks WHERE recovery_id = ?',
                value.record.id,
              );
              const cleared = context.storage.sql.exec(
                "UPDATE recovery_records SET payload = '', outcome = '' WHERE id = ? AND state = 'blocked'",
                value.record.id,
              ).rowsWritten;
              if (cleared !== 1) throw new Error('frozen repair changed before payload release');
              if (value.repair.data === null) {
                const hydrated = context.storage.sql.exec(
                  'UPDATE fact_repairs SET data = ? WHERE id = ? AND data IS NULL',
                  value.record.payload,
                  value.repair.id,
                ).rowsWritten;
                if (hydrated !== 1) {
                  throw new Error('frozen repair changed before payload preservation');
                }
              }
            }
          },
          () => {
            if (context.storage.sql.databaseSize > databaseSizeBeforeBytes) {
              throw new Error('frozen repair reconciliation would grow SQLite storage');
            }
          },
        );
  const resolvedById = new Map(resolved.map((record) => [record.id, record]));
  const databaseSizeAfterBytes = context.storage.sql.databaseSize;
  return {
    resolved: current.map(({ record }) => {
      const result = resolvedById.get(record.id) ?? record;
      return { recoveryId: result.id, resolution: result.resolution! };
    }),
    storage: {
      databaseSizeBeforeBytes,
      databaseSizeAfterBytes,
      releasedRecoveryBytes,
      hydratedRepairBytes,
      tombstoneBytes,
    },
  };
}

function changed(current: InspectedRepair, inspected: InspectedRepair): boolean {
  if (current.record.state === 'resolved') return false;
  if (inspected.record.state === 'resolved') return true;
  return (
    current.record.payload !== inspected.record.payload ||
    current.record.outcome !== inspected.record.outcome ||
    current.repair.id !== inspected.repair.id ||
    current.repair.data !== inspected.repair.data ||
    current.repair.recovery_dedupe_key !== inspected.repair.recovery_dedupe_key
  );
}

interface InspectedRepair {
  record: RecoveryRecord;
  repair: StoredFactRepair;
}

async function inspectRecord(
  orgId: string,
  proof: ReconcileFrozenRepairInput,
  proofSha256: string,
  context: Pick<FrozenRepairReconciliationContext, 'recovery' | 'storage'>,
): Promise<InspectedRepair> {
  const record = inspectRecoveryRecord(proof.recoveryId, context.recovery);
  const repair = linkedRepair(proof.recoveryId, context.storage);
  if (record.state === 'resolved') {
    const journaled = new FactRepairProof(context.recovery).verifyJournaledSync(repair, orgId);
    if (
      !journaled.verified ||
      record.resolution !== `frozen-journal-${proof.disposition}` ||
      record.resolutionReason !== proofSha256 ||
      record.payload !== '' ||
      record.outcome !== '' ||
      repair.category !== proof.category ||
      repair.fact_id !== proof.factId
    ) {
      throw new Error('frozen repair was already resolved with another proof');
    }
    const row = JSON.parse(journaled.value.row.data!) as Record<string, unknown>;
    if (
      factPartitionKey(proof.category, row) !== proof.sourceEventDay ||
      factIngestedAtMs(row) !== proof.sourceIngestedAtMs
    ) {
      throw new Error('frozen repair was already resolved with another source row');
    }
    return { record, repair };
  }
  const [payloadSha256, outcomeSha256] = await Promise.all([
    sha256Hex(record.payload),
    sha256Hex(record.outcome),
  ]);
  if (
    payloadSha256 !== proof.expectedPayloadSha256 ||
    outcomeSha256 !== proof.expectedOutcomeSha256
  ) {
    throw new Error('frozen repair payload or outcome SHA256 changed');
  }
  return inspectBlockedRepair(orgId, proof, record, repair, context.recovery);
}

function linkedRepair(recoveryId: number, storage: DurableObjectStorage): StoredFactRepair {
  const repairs = [
    ...storage.sql.exec<StoredFactRepair>(
      `SELECT f.id, f.category, f.fact_id, f.old_hash, f.new_hash, f.seen_at_ms,
              f.data, f.recovery_dedupe_key
       FROM fact_repairs AS f
       JOIN recovery_records AS r ON r.dedupe_key = f.recovery_dedupe_key
       WHERE r.id = ? AND r.kind = 'repair'`,
      recoveryId,
    ),
  ];
  if (repairs.length !== 1) throw new Error('frozen repair recovery link is not unique');
  return repairs[0]!;
}

function inspectBlockedRepair(
  orgId: string,
  proof: ReconcileFrozenRepairInput,
  record: RecoveryRecord,
  repair: StoredFactRepair,
  recovery: TinybirdRecoveryStore,
): InspectedRepair {
  const hydrated = repair.data === null ? { ...repair, data: record.payload } : repair;
  const verified = new FactRepairProof(recovery).verifySync(hydrated, orgId);
  if (!verified.verified || verified.value.recovery.id !== record.id) {
    throw new Error(
      verified.verified
        ? 'frozen repair recovery link changed'
        : `invalid frozen repair: ${verified.reason}`,
    );
  }
  const row = JSON.parse(record.payload) as Record<string, unknown>;
  if (
    repair.category !== proof.category ||
    repair.fact_id !== proof.factId ||
    rowIdentity(row, ROW_IDENTITY_FIELDS[proof.category]) !== proof.factId ||
    row.OrgId !== orgId ||
    factPartitionKey(proof.category, row) !== proof.sourceEventDay ||
    factIngestedAtMs(row) !== proof.sourceIngestedAtMs
  ) {
    throw new Error('frozen repair identity or source metadata changed');
  }
  return { record, repair };
}

function inspectRecoveryRecord(
  recoveryId: number,
  recovery: TinybirdRecoveryStore,
): RecoveryRecord {
  const record = recovery.get(recoveryId);
  if (
    record.kind !== 'repair' ||
    record.classification !== 'changed' ||
    record.target !== null ||
    !['blocked', 'resolved'].includes(record.state)
  ) {
    throw new Error('frozen repair recovery record is not a verifiable repair');
  }
  return record;
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
