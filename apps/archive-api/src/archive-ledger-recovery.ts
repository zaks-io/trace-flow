import type { ArchiveApiEnv } from './context';
import { ArchiveContractError } from './archive-contract';
import { hasPendingIntent, readPendingIntent } from './archive-ledger-intent';
import {
  commitIntentAndEnqueueBudgetCommit,
  discardIntentAndEnqueueRelease,
  drainPendingBudgetCommits,
  drainPendingReleases,
  hasPendingBudgetCommits,
  hasPendingReleases,
} from './archive-ledger-release-outbox';
import { readLedgerSnapshot } from './archive-ledger-storage';
import { storageBudgetObject } from './archive-r2';
import { verifyObjects } from './archive-ledger-intent-recovery';
import { ARCHIVE_ROTATION_RETRY_MS } from './archive-key-rotation-state';

export async function armLedgerRecovery(storage: DurableObjectStorage): Promise<void> {
  const scheduledAt = Date.now() + ARCHIVE_ROTATION_RETRY_MS;
  const current = await storage.getAlarm();
  if (current === null || scheduledAt < current) await storage.setAlarm(scheduledAt);
}

export async function scheduleLedgerRecovery(storage: DurableObjectStorage): Promise<void> {
  if (
    hasPendingIntent(storage) ||
    hasPendingReleases(storage) ||
    hasPendingBudgetCommits(storage)
  ) {
    await armLedgerRecovery(storage);
  } else {
    await storage.deleteAlarm();
  }
}

export async function resumeLedgerRecovery(
  storage: DurableObjectStorage,
  env: ArchiveApiEnv,
): Promise<void> {
  await drainPendingReleases(storage, env);
  await drainPendingBudgetCommits(storage, env);
  const pending = readPendingIntent(storage);
  if (!pending) return;
  if (!pending.commit) throw new ArchiveContractError('pending_intent_corrupt');
  const current = readLedgerSnapshot(storage);
  if (
    pending.baseElementCount !== current.elementCount ||
    pending.baseChainHead !== current.chainHead
  ) {
    return;
  }
  if (pending.status === 'building' || pending.status === 'ready') {
    discardIntentAndEnqueueRelease(storage, pending, 'unreserved_only');
    await drainPendingReleases(storage, env);
    return;
  }
  const orgId = pending.commit.scope.orgId;
  const keyVersion = pending.commit.keyVersion;
  const objects = pending.objects.map((object) => storageBudgetObject(object, keyVersion));
  const budget = env.STORAGE_BUDGET.getByName(orgId);
  const reservation = await budget.reserveStorage({ orgId, objects });
  if (!reservation.accepted) return;
  await verifyObjects(env.ARCHIVE_STORAGE, pending.objects);
  commitIntentAndEnqueueBudgetCommit(storage, pending);
  await drainPendingBudgetCommits(storage, env);
}
