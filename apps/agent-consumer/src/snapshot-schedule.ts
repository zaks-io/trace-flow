import type { AgentSnapshotQueueMessage } from '@trace-flow/types';
import type { AgentDeliveryCoordinatorStats } from './agent-delivery-coordinator-contract';
import { readSnapshotCheck, SNAPSHOT_FIRST_CHECK_MS, snapshotStartedAt } from './snapshot-checks';
import { readSnapshotFailure } from './snapshot-failure';

const AGENT_SNAPSHOT_DEBOUNCE_MS = 60_000;
const DISPATCH_RECOVERY_MS = 60_000;

export async function readSnapshotSchedule(storage: DurableObjectStorage) {
  const check = readSnapshotCheck(storage);
  return {
    check,
    failure: readSnapshotFailure(storage),
    startedAtMs: snapshotStartedAt(storage),
    dirtySinceMs: (await storage.get<number>('snapshot_dirty_since_ms')) ?? null,
    wakeAtMs: check?.nextCheckAtMs ?? (await storage.get<number>('snapshot_wake_at_ms')) ?? null,
  };
}

export async function scheduleAgentSnapshot(
  storage: DurableObjectStorage,
  orgId: string,
): Promise<void> {
  await bindSnapshotOrg(storage, orgId);
  if (readSnapshotFailure(storage) || readSnapshotCheck(storage)?.blockedReason) {
    await storage.deleteAlarm();
    return;
  }
  if ((await storage.get<number>('snapshot_dirty_since_ms')) === undefined)
    await storage.put('snapshot_dirty_since_ms', Date.now());
  if ((await storage.getAlarm()) === null) {
    const wakeAt = Date.now() + AGENT_SNAPSHOT_DEBOUNCE_MS;
    await storage.put('snapshot_wake_at_ms', wakeAt);
    await storage.setAlarm(wakeAt);
  }
}

export async function scheduleAgentSnapshotContinuation(
  storage: DurableObjectStorage,
  orgId: string,
): Promise<void> {
  await bindSnapshotOrg(storage, orgId);
  if (readSnapshotFailure(storage)) {
    await storage.deleteAlarm();
    return;
  }
  const check = readSnapshotCheck(storage);
  if (check?.blockedReason) {
    await storage.deleteAlarm();
    return;
  }
  const wakeAt = check ? check.nextCheckAtMs : Date.now() + SNAPSHOT_FIRST_CHECK_MS;
  await storage.put('snapshot_wake_at_ms', wakeAt);
  await storage.setAlarm(Math.max(Date.now() + 1, wakeAt));
}

export async function publishAgentSnapshot(
  storage: DurableObjectStorage,
  queue: Queue<AgentSnapshotQueueMessage>,
  stats: AgentDeliveryCoordinatorStats,
): Promise<void> {
  const schedule = await readSnapshotSchedule(storage);
  if (
    schedule.failure ||
    schedule.check?.blockedReason ||
    (stats.gatePhase !== 'snapshot' && stats.dirtyDays <= stats.incompleteDays)
  ) {
    await storage.deleteAlarm();
    await storage.delete('snapshot_wake_at_ms');
    if (stats.dirtyDays === 0) await storage.delete('snapshot_dirty_since_ms');
    return;
  }
  const orgId = await storage.get<string>('snapshot_org_id');
  if (!orgId) throw new Error('Dirty snapshot has no organization');
  if (schedule.wakeAtMs !== null && schedule.wakeAtMs > Date.now()) {
    await storage.setAlarm(schedule.wakeAtMs);
    return;
  }
  if (
    stats.gatePhase === 'snapshot' &&
    stats.gateExpiresAtMs !== null &&
    stats.gateExpiresAtMs > Date.now()
  ) {
    await storage.setAlarm(stats.gateExpiresAtMs);
    return;
  }
  // Keep a durable wake-up if dispatch succeeds but its queue consumer crashes.
  await storage.setAlarm(Date.now() + DISPATCH_RECOVERY_MS);
  await queue.send({ type: 'agent-snapshot', org_id: orgId });
}

async function bindSnapshotOrg(storage: DurableObjectStorage, orgId: string): Promise<void> {
  if (!orgId || orgId.length > 256 || orgId.includes(':'))
    throw new Error('Invalid snapshot organization');
  const existing = await storage.get<string>('snapshot_org_id');
  if (existing !== undefined && existing !== orgId)
    throw new Error('Snapshot organization mismatch');
  if (existing === undefined) await storage.put('snapshot_org_id', orgId);
}
