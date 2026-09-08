import { createWorkerLogger } from '@trace-flow/logging';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { archiveKeyVersionMetadata } from '../archive-r2';
import { recordRotatedObject } from '../archive-key-rotation-state';
import type { StorageBudget } from '../archive-storage-budget';
import { reconcileBudgetInventoryPage } from '../archive-storage-budget-reconciliation';
import type { ArchiveApiEnv } from '../context';
import {
  createCommittedObject,
  finishActiveGeneration,
  reconciliationState,
} from './storage-budget-reconciliation-rotation-fixture';
import { runtimeEnv } from './storage-budget-fixture';

const logger = createWorkerLogger({
  service: 'archive-api-test',
  request: new Request('https://archive.test/storage-reconciliation'),
  emitToConsole: false,
});

const reconciliationEnv = runtimeEnv as unknown as Pick<
  ArchiveApiEnv,
  | 'ARCHIVE_STORAGE'
  | 'CONVEX_SITE_URL'
  | 'ARCHIVE_API_SHARED_SECRET'
  | 'ARCHIVE_KEY_WRAPPING_SECRET'
>;

describe('StorageBudget reconciliation listing strictness', () => {
  it('rejects fresh catalog divergence before persisting a snapshot', async () => {
    const input = await createCommittedObject('fresh-divergence');
    await runInDurableObject(input.stub, (_instance, state) => {
      recordRotatedObject(state.storage, input.objectKey, 2, input.bytes + 7);
    });

    const error = await runInDurableObject(input.stub, async (instance: StorageBudget) => {
      try {
        await instance.reconcileArchiveInventory({ orgId: input.orgId, limit: 1000 });
        return null;
      } catch (cause) {
        return cause instanceof Error ? cause.message : String(cause);
      }
    });
    expect(error).toBe('storage_object_metadata_mismatch');

    expect(await reconciliationState(input)).toMatchObject({
      catalog: { bytes: input.bytes + 7, key_version: 2 },
      reconciliation: {
        active_generation: expect.any(Number),
        finalization_phase: null,
        error: 'storage_object_metadata_mismatch',
      },
      snapshotCount: 0,
      guarded: true,
    });
  });

  it('retries a rotation that lands after listing and clears its transient guard', async () => {
    const input = await createCommittedObject('listing-race');
    const rotatedBody = 'rotated-v2-listing-race-with-new-length';
    const rotatedBytes = new TextEncoder().encode(rotatedBody).byteLength;
    const firstError = await runInDurableObject(input.stub, async (_instance, state) => {
      const delayedStorage = {
        list: async (options: R2ListOptions) => {
          const listed = await reconciliationEnv.ARCHIVE_STORAGE.list(options);
          await reconciliationEnv.ARCHIVE_STORAGE.put(input.objectKey, rotatedBody, {
            customMetadata: archiveKeyVersionMetadata(2),
          });
          recordRotatedObject(state.storage, input.objectKey, 2, rotatedBytes);
          return listed;
        },
      } as R2Bucket;
      try {
        await reconcileBudgetInventoryPage(
          state.storage,
          { ...reconciliationEnv, ARCHIVE_STORAGE: delayedStorage },
          logger,
          { orgId: input.orgId, limit: 1000 },
        );
        return null;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    });
    expect(firstError).toBe('storage_object_metadata_mismatch');
    expect(await reconciliationState(input)).toMatchObject({ snapshotCount: 0, guarded: true });

    await finishActiveGeneration(input);
    expect(await reconciliationState(input)).toMatchObject({ guarded: true });
    await finishActiveGeneration(input);
    expect(await reconciliationState(input)).toMatchObject({
      catalog: { bytes: rotatedBytes, key_version: 2 },
      reconciliation: { active_generation: null, error: null },
      guarded: false,
    });
  });
});
