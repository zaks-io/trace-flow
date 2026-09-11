import { env as workerEnv, runInDurableObject } from 'cloudflare:test';
import type { ArchiveScope } from '../archive-contract';
import type { StorageBudget } from '../archive-storage-budget';
import { budgetState } from '../archive-storage-budget-ledger';
import { archiveObjectKey } from '../archive-storage-key';
import type { ArchiveApiEnv } from '../context';

export const runtimeEnv = workerEnv as unknown as Pick<
  ArchiveApiEnv,
  'ARCHIVE_STORAGE' | 'STORAGE_BUDGET'
>;

export function budget(orgId: string): DurableObjectStub<StorageBudget> {
  return runtimeEnv.STORAGE_BUDGET.getByName(orgId);
}

export async function initializeBudget(
  stub: DurableObjectStub<StorageBudget>,
  orgId: string,
): Promise<void> {
  await runInDurableObject(stub, (_instance, state) => {
    budgetState(state.storage, orgId);
  });
}

export function scope(orgId: string): ArchiveScope {
  return {
    orgId,
    userId: `user-${crypto.randomUUID()}`,
    contributionId: `contribution-${crypto.randomUUID()}`,
    source: 'claude',
    sourceSessionId: `session-${crypto.randomUUID()}`,
  };
}

export async function inventoryKeys(currentScope: ArchiveScope): Promise<string[]> {
  return [
    await archiveObjectKey(currentScope, 'chunks', `sha256:${'a'.repeat(64)}`),
    await archiveObjectKey(currentScope, 'manifests', `sha256:${'b'.repeat(64)}`),
    await archiveObjectKey(currentScope, 'chunks', `sha256:${'c'.repeat(64)}`),
  ];
}
