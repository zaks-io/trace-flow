import { agentAnalyticsDayBounds } from '@trace-flow/utils';
import type { DurableObjectStorage } from '@cloudflare/workers-types';
import type { AgentConsumerEnv } from './context';
import type { LegacyIngestionState } from './legacy-ingestion-state';
import {
  validateLegacyRetirementProof,
  type LegacyRetirementProof,
  type LegacyRetirementRecord,
} from './legacy-retirement';

interface LegacyLedgerRetirementContext {
  storage: DurableObjectStorage;
  coordinators: AgentConsumerEnv['AGENT_DELIVERY_COORDINATOR'];
  legacyObjectId: string;
  legacyState: LegacyIngestionState;
  flushInProgress: boolean;
  assertMaintenanceUnlocked(): void;
  pendingRows(): number;
  blockedRows(): number;
  blockedRecords(): number;
}

export async function retireFrozenLegacyLedger(
  orgId: string,
  input: LegacyRetirementProof,
  context: LegacyLedgerRetirementContext,
): Promise<LegacyRetirementRecord> {
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(orgId)) {
    throw new Error('Invalid legacy retirement organization');
  }
  const proof = validateLegacyRetirementProof(input);
  const retirementCoordinator = context.coordinators.getByName(
    `retirement:${context.legacyObjectId}`,
  );
  const existing = await retirementCoordinator.getLegacyRetirement({});
  if (existing) {
    validateProofMatch(existing, proof);
    context.legacyState.applyRetirement(existing);
    if (existing.state === 'complete') return existing;
    return deleteAndComplete(context, proof);
  }

  const { oldestDay, today } = agentAnalyticsDayBounds(Date.now());
  if (proof.oldestDay !== oldestDay || proof.todayDay !== today) {
    throw new Error('Legacy retirement analytics window changed');
  }
  context.legacyState.assertFrozen();
  context.assertMaintenanceUnlocked();
  const frozenFactCount = context.storage.sql
    .exec<{ count: number }>('SELECT COUNT(*) AS count FROM fact_ledger')
    .one().count;
  if (
    context.flushInProgress ||
    context.pendingRows() !== 0 ||
    context.blockedRows() !== 0 ||
    context.blockedRecords() !== 0 ||
    frozenFactCount !== proof.frozenFactCount
  ) {
    throw new Error('Legacy frozen ledger is not quiescent or does not match verification');
  }
  const coordinator = context.coordinators.getByName(`org:${orgId}`);
  const [migration, stats] = await Promise.all([
    coordinator.getIngestionMigrationState(),
    coordinator.getStats({}),
  ]);
  if (
    migration?.complete !== true ||
    migration.proofSha256 !== proof.migrationProofSha256 ||
    stats.activeDeliveries !== 0 ||
    stats.lastDeliverySequence !== proof.deliverySequence
  ) {
    throw new Error('Legacy retirement migration proof or delivery fence changed');
  }
  const intent = await retirementCoordinator.beginLegacyRetirement(proof);
  context.legacyState.applyRetirement(intent);
  return deleteAndComplete(context, proof);
}

async function deleteAndComplete(
  context: LegacyLedgerRetirementContext,
  proof: LegacyRetirementProof,
): Promise<LegacyRetirementRecord> {
  await context.storage.deleteAlarm();
  await context.storage.deleteAll();
  const completed = await context.coordinators
    .getByName(`retirement:${context.legacyObjectId}`)
    .completeLegacyRetirement({ verificationSha256: proof.verificationSha256 });
  context.legacyState.applyRetirement(completed);
  return completed;
}

function validateProofMatch(record: LegacyRetirementRecord, proof: LegacyRetirementProof): void {
  for (const [key, value] of Object.entries(proof)) {
    if (record[key as keyof LegacyRetirementProof] !== value) {
      throw new Error('legacy retirement proof conflict');
    }
  }
}
