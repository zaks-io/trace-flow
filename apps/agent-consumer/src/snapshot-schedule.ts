import type { AgentSnapshotQueueMessage } from '@trace-flow/types';
import type { AgentDeliveryCoordinatorStats } from './agent-delivery-coordinator-contract';

const AGENT_SNAPSHOT_DEBOUNCE_MS = 5 * 60 * 1000;
const AGENT_SNAPSHOT_CONTINUATION_DELAY_MS = 30 * 1000;

export async function scheduleAgentSnapshot(
  storage: DurableObjectStorage,
  orgId: string,
): Promise<void> {
  if (!orgId || orgId.length > 256 || orgId.includes(':'))
    throw new Error('Invalid snapshot organization');
  const existing = await storage.get<string>('snapshot_org_id');
  if (existing !== undefined && existing !== orgId)
    throw new Error('Snapshot organization mismatch');
  if (existing === undefined) await storage.put('snapshot_org_id', orgId);
  if ((await storage.getAlarm()) === null)
    await storage.setAlarm(Date.now() + AGENT_SNAPSHOT_DEBOUNCE_MS);
}

export async function scheduleAgentSnapshotContinuation(
  storage: DurableObjectStorage,
  orgId: string,
): Promise<void> {
  await scheduleAgentSnapshot(storage, orgId);
  const continuationAt = Date.now() + AGENT_SNAPSHOT_CONTINUATION_DELAY_MS;
  const alarm = await storage.getAlarm();
  if (alarm === null || alarm > continuationAt) await storage.setAlarm(continuationAt);
}

export async function publishAgentSnapshot(
  storage: DurableObjectStorage,
  queue: Queue<AgentSnapshotQueueMessage>,
  stats: AgentDeliveryCoordinatorStats,
): Promise<void> {
  if (stats.dirtyDays <= stats.incompleteDays) {
    await storage.deleteAlarm();
    return;
  }
  const orgId = await storage.get<string>('snapshot_org_id');
  if (!orgId) throw new Error('Dirty snapshot has no organization');
  await storage.setAlarm(Date.now() + AGENT_SNAPSHOT_DEBOUNCE_MS);
  if (
    stats.gatePhase === 'snapshot' &&
    stats.gateExpiresAtMs !== null &&
    stats.gateExpiresAtMs > Date.now()
  ) {
    return;
  }
  await queue.send({ type: 'agent-snapshot', org_id: orgId });
}
