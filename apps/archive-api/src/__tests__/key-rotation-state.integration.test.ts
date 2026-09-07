import { describe, expect, it } from 'vitest';
import { runInDurableObject } from 'cloudflare:test';
import {
  ensureRotationSchema,
  writeRotationState,
  type ArchiveKeyRotationState,
} from '../archive-key-rotation-state';
import type { StorageBudget } from '../archive-storage-budget';
import { ACTIVATION_ID } from './key-rotation-custody-fixture';
import { budget } from './storage-budget-fixture';

function succeededState(operationId: string, fromVersion: number): ArchiveKeyRotationState {
  return {
    operationId,
    fromVersion,
    toVersion: fromVersion + 1,
    status: 'succeeded',
    generation: fromVersion,
    reencryptedCount: 1,
    remainingReferences: 0,
    activationId: ACTIVATION_ID,
    updatedAt: Date.now(),
  };
}

describe('archive key rotation state migration', () => {
  it('does not copy a previous operation legacy root into a later rotation', async () => {
    const orgId = `rotation-root-migration-${crypto.randomUUID()}`;
    const stub = budget(orgId);
    await stub.getStorageBudget({ orgId });

    const roots = await runInDurableObject(stub, (_instance: StorageBudget, state) => {
      writeRotationState(state.storage, succeededState('rotation-1-2', 1));
      state.storage.sql.exec(
        'UPDATE archive_key_rotation SET manifest_root_hashes = ? WHERE id = 1',
        JSON.stringify(['a'.repeat(64)]),
      );
      ensureRotationSchema(state.storage);
      writeRotationState(state.storage, succeededState('rotation-2-3', 2));
      ensureRotationSchema(state.storage);
      return [
        ...state.storage.sql.exec<{ operation_id: string; root_hash: string }>(
          'SELECT operation_id, root_hash FROM archive_key_rotation_manifest_roots ORDER BY operation_id',
        ),
      ];
    });

    expect(roots).toEqual([{ operation_id: 'rotation-1-2', root_hash: 'a'.repeat(64) }]);
  });
});
