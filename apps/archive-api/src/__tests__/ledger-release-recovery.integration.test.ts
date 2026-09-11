import { describe, expect, it, vi } from 'vitest';
import {
  archiveKey,
  base64,
  checkpoint,
  commitArchiveSession,
  envelope,
  exactPrefix,
  newLedger,
  observation,
  partFor,
  readLedgerSnapshot,
  readPendingIntent,
  runInDurableObject,
  runtimeEnv,
  scope,
} from './ledger.integration.fixtures';
import type {
  ArchiveApiEnv,
  ArchiveSessionLedger,
  ArchiveUploadRequest,
} from './ledger.integration.fixtures';
import { ACTIVATION_ID, FakeArchiveCustody, installCustody } from './key-rotation-custody-fixture';
import { wrapKey } from './key-rotation-crypto-fixture';
import { initializeBudget } from './storage-budget-fixture';

async function requestFor(label: string) {
  const currentScope = scope('codex', `${label}-${crypto.randomUUID()}`);
  const record = await observation(
    currentScope.source,
    currentScope.sourceSessionId,
    partFor(currentScope.source),
    `${label}-record`,
    JSON.stringify({ label }),
  );
  const upload = {
    source_session_id: currentScope.sourceSessionId,
    observations: [record],
    checkpoint: await checkpoint(
      currentScope.source,
      currentScope.sourceSessionId,
      partFor(currentScope.source),
      [record],
    ),
    complete_prefix_base64: base64(exactPrefix([record])),
  } satisfies ArchiveUploadRequest;
  return { currentScope, request: await envelope(currentScope, upload) };
}

async function leaveReadyReserved(label: string) {
  const { currentScope, request } = await requestFor(label);
  const ledger = newLedger(currentScope);
  const interruptedEnv = {
    ...runtimeEnv,
    STORAGE_BUDGET: {
      getByName: (orgId: string) => {
        const delegated = runtimeEnv.STORAGE_BUDGET.getByName(orgId);
        return {
          reserveStorage: async (input: Parameters<typeof delegated.reserveStorage>[0]) => {
            await delegated.reserveStorage(input);
            throw new Error('reserve_response_lost');
          },
        };
      },
    },
  } as unknown as ArchiveApiEnv;
  await expect(
    runInDurableObject(ledger, (_instance, state) =>
      commitArchiveSession(state.storage, interruptedEnv, request),
    ),
  ).rejects.toThrow('reserve_response_lost');
  return {
    currentScope,
    request,
    ledger,
    budget: runtimeEnv.STORAGE_BUDGET.getByName(currentScope.orgId),
  };
}

async function leaveAuthorizedPartial(label: string) {
  const { currentScope, request } = await requestFor(label);
  const ledger = newLedger(currentScope);
  let putCount = 0;
  let failedKey: string | undefined;
  const partialBucket = {
    get: runtimeEnv.ARCHIVE_STORAGE.get.bind(runtimeEnv.ARCHIVE_STORAGE),
    head: runtimeEnv.ARCHIVE_STORAGE.head.bind(runtimeEnv.ARCHIVE_STORAGE),
    put: async (key: string, body: string, options?: R2PutOptions) => {
      putCount += 1;
      if (putCount === 2) {
        failedKey = key;
        throw new Error('second_put_interrupted');
      }
      return runtimeEnv.ARCHIVE_STORAGE.put(key, body, options);
    },
  } as unknown as R2Bucket;
  await expect(
    runInDurableObject(ledger, (_instance, state) =>
      commitArchiveSession(
        state.storage,
        { ...runtimeEnv, ARCHIVE_STORAGE: partialBucket } as ArchiveApiEnv,
        request,
      ),
    ),
  ).rejects.toThrow('second_put_interrupted');
  if (!failedKey) throw new Error('fault injection did not reach the second R2 put');
  return {
    currentScope,
    request,
    ledger,
    failedKey,
    budget: runtimeEnv.STORAGE_BUDGET.getByName(currentScope.orgId),
  };
}

describe('Archive Session Ledger release and alarm recovery', () => {
  it('replays a rejected release from the key-unavailable discard path', async () => {
    const { currentScope, request, ledger, budget } =
      await leaveReadyReserved('key-unavailable-release');
    const custody = new FakeArchiveCustody();
    const custodyFetch = installCustody(custody);
    try {
      const wrappedKey = await wrapKey(currentScope.orgId, 2);
      custody.versions.set(2, wrappedKey);
      custody.activeVersion = 2;
      const rejectedReleaseEnv = {
        ...runtimeEnv,
        STORAGE_BUDGET: {
          getByName: () => ({
            releaseStorage: async () => {
              throw new Error('release_rejected');
            },
          }),
        },
      } as unknown as ArchiveApiEnv;
      await expect(
        runInDurableObject(ledger, (_instance, state) =>
          commitArchiveSession(state.storage, rejectedReleaseEnv, {
            ...request,
            keyVersion: 2,
            wrappedKey,
          }),
        ),
      ).rejects.toThrow('release_rejected');
      const local = await runInDurableObject(ledger, (_instance, state) => ({
        pending: readPendingIntent(state.storage),
        releases: [
          ...state.storage.sql.exec<{ count: number }>(
            'SELECT COUNT(*) AS count FROM pending_releases',
          ),
        ][0]!.count,
      }));
      expect(local.pending).toBeNull();
      expect(local.releases).toBeGreaterThan(0);
      await expect(
        budget.countKeyVersionReferences({ orgId: currentScope.orgId, keyVersion: 1 }),
      ).resolves.toBeGreaterThan(0);

      await runInDurableObject(ledger, (instance: ArchiveSessionLedger) => instance.alarm());
      await expect(
        budget.countKeyVersionReferences({ orgId: currentScope.orgId, keyVersion: 1 }),
      ).resolves.toBe(0);
    } finally {
      custodyFetch.mockRestore();
    }
  });

  it('replays a rejected release from the cap-rejection discard path', async () => {
    const { currentScope, request } = await requestFor('cap-release');
    const ledger = newLedger(currentScope);
    const budget = runtimeEnv.STORAGE_BUDGET.getByName(currentScope.orgId);
    await initializeBudget(budget, currentScope.orgId);
    const rejectedSnapshot = await budget.getStorageBudget({ orgId: currentScope.orgId });
    const rejectedReleaseEnv = {
      ...runtimeEnv,
      STORAGE_BUDGET: {
        getByName: () => ({
          reserveStorage: async () => ({
            accepted: false as const,
            reason: 'storage_cap_exceeded' as const,
            snapshot: rejectedSnapshot,
          }),
          releaseStorage: async () => {
            throw new Error('release_rejected');
          },
        }),
      },
    } as unknown as ArchiveApiEnv;
    await expect(
      runInDurableObject(ledger, (_instance, state) =>
        commitArchiveSession(state.storage, rejectedReleaseEnv, request),
      ),
    ).rejects.toThrow('release_rejected');
    const local = await runInDurableObject(ledger, (_instance, state) => ({
      pending: readPendingIntent(state.storage),
      releases: [
        ...state.storage.sql.exec<{ count: number }>(
          'SELECT COUNT(*) AS count FROM pending_releases',
        ),
      ][0]!.count,
    }));
    expect(local.pending).toBeNull();
    expect(local.releases).toBeGreaterThan(0);

    await runInDurableObject(ledger, (instance: ArchiveSessionLedger) => instance.alarm());
    await expect(
      budget.countKeyVersionReferences({ orgId: currentScope.orgId, keyVersion: 1 }),
    ).resolves.toBe(0);
  });

  it('discards and releases an abandoned ready intent without a client retry', async () => {
    const { currentScope, ledger, budget } = await leaveReadyReserved('ready-alarm');
    const custody = new FakeArchiveCustody();
    const custodyFetch = installCustody(custody);
    try {
      custody.versions.set(1, await archiveKey(currentScope.orgId));
      custody.versions.set(2, await wrapKey(currentScope.orgId, 2));
      custody.activeVersion = 2;
      custody.retiringVersion = 1;
      custody.operationId = `rotate:${currentScope.orgId}:1:2`;
      custody.rotationStatus = 'rotating';
      await budget.startKeyRotation({
        orgId: currentScope.orgId,
        operationId: custody.operationId,
        fromVersion: 1,
        toVersion: 2,
        activationId: ACTIVATION_ID,
      });
      await expect(budget.advanceKeyRotation({ orgId: currentScope.orgId })).resolves.toMatchObject(
        {
          status: 'rotating',
        },
      );

      await runInDurableObject(ledger, (instance: ArchiveSessionLedger) => instance.alarm());
      await expect(
        runInDurableObject(ledger, (_instance, state) => readPendingIntent(state.storage)),
      ).resolves.toBeNull();
      await expect(
        budget.countKeyVersionReferences({ orgId: currentScope.orgId, keyVersion: 1 }),
      ).resolves.toBe(0);
      await expect(budget.advanceKeyRotation({ orgId: currentScope.orgId })).resolves.toMatchObject(
        {
          status: 'succeeded',
        },
      );
    } finally {
      custodyFetch.mockRestore();
    }
  });

  it.each(['rejected', 'response_lost'] as const)(
    'replays a durable release after the first release is %s',
    async (failure) => {
      const { currentScope, request } = await requestFor(`release-${failure}`);
      const ledger = newLedger(currentScope);
      const interruptedEnv = {
        ...runtimeEnv,
        ARCHIVE_STORAGE: {
          get: async () => {
            throw new Error('read_before_put_failed');
          },
          head: async () => null,
        } as unknown as R2Bucket,
        STORAGE_BUDGET: {
          getByName: (orgId: string) => {
            const delegated = runtimeEnv.STORAGE_BUDGET.getByName(orgId);
            return {
              reserveStorage: (input: Parameters<typeof delegated.reserveStorage>[0]) =>
                delegated.reserveStorage(input),
              releaseStorage: async (input: Parameters<typeof delegated.releaseStorage>[0]) => {
                if (failure === 'response_lost') await delegated.releaseStorage(input);
                throw new Error(`release_${failure}`);
              },
            };
          },
        },
      } as unknown as ArchiveApiEnv;
      await expect(
        runInDurableObject(ledger, (_instance, state) =>
          commitArchiveSession(state.storage, interruptedEnv, request),
        ),
      ).rejects.toThrow('read_before_put_failed');
      const pendingReleaseCount = await runInDurableObject(
        ledger,
        (_instance, state) =>
          [
            ...state.storage.sql.exec<{ count: number }>(
              'SELECT COUNT(*) AS count FROM pending_releases',
            ),
          ][0]!.count,
      );
      expect(pendingReleaseCount).toBeGreaterThan(0);

      await runInDurableObject(ledger, (instance: ArchiveSessionLedger) => instance.alarm());
      const recovered = await runInDurableObject(ledger, async (_instance, state) => ({
        pending: readPendingIntent(state.storage),
        releases: [
          ...state.storage.sql.exec<{ count: number }>(
            'SELECT COUNT(*) AS count FROM pending_releases',
          ),
        ][0]!.count,
        alarm: await state.storage.getAlarm(),
      }));
      expect(recovered).toEqual({ pending: null, releases: 0, alarm: null });
      await expect(
        runtimeEnv.STORAGE_BUDGET.getByName(currentScope.orgId).countKeyVersionReferences({
          orgId: currentScope.orgId,
          keyVersion: 1,
        }),
      ).resolves.toBe(0);
    },
  );

  it('resumes a partially written intent during rotation through the commit queue', async () => {
    const { currentScope, ledger, budget } = await leaveAuthorizedPartial('partial-alarm');
    const pending = await runInDurableObject(ledger, (_instance, state) =>
      readPendingIntent(state.storage),
    );
    expect(pending).toMatchObject({ status: 'write_authorized' });
    const custody = new FakeArchiveCustody();
    const custodyFetch = installCustody(custody);
    try {
      custody.versions.set(1, await archiveKey(currentScope.orgId));
      custody.versions.set(2, await wrapKey(currentScope.orgId, 2));
      custody.activeVersion = 2;
      custody.retiringVersion = 1;
      custody.operationId = `rotate:${currentScope.orgId}:1:2`;
      custody.rotationStatus = 'rotating';
      await budget.startKeyRotation({
        orgId: currentScope.orgId,
        operationId: custody.operationId,
        fromVersion: 1,
        toVersion: 2,
        activationId: ACTIVATION_ID,
      });
      await expect(budget.advanceKeyRotation({ orgId: currentScope.orgId })).resolves.toMatchObject(
        {
          status: 'rotating',
        },
      );
      await runInDurableObject(ledger, (instance: ArchiveSessionLedger) => instance.alarm());
      await expect(budget.advanceKeyRotation({ orgId: currentScope.orgId })).resolves.toMatchObject(
        {
          status: 'succeeded',
        },
      );
      await expect(
        runInDurableObject(ledger, (_instance, state) => readLedgerSnapshot(state.storage)),
      ).resolves.toMatchObject({ generation: 1 });
    } finally {
      custodyFetch.mockRestore();
    }
  });

  it('keeps a collided partial intent and its alarm pinned', async () => {
    const { currentScope, ledger, failedKey, budget } = await leaveAuthorizedPartial('collision');
    await runtimeEnv.ARCHIVE_STORAGE.put(failedKey, '{"keyVersion":1,"collision":true}');
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await runInDurableObject(ledger, (instance: ArchiveSessionLedger) => instance.alarm());
    consoleError.mockRestore();
    const local = await runInDurableObject(ledger, async (_instance, state) => ({
      pending: readPendingIntent(state.storage),
      alarm: await state.storage.getAlarm(),
      releaseCount: [
        ...state.storage.sql.exec<{ count: number }>(
          'SELECT COUNT(*) AS count FROM pending_releases',
        ),
      ][0]!.count,
    }));
    expect(local.pending).toMatchObject({ status: 'write_authorized' });
    expect(local.alarm).not.toBeNull();
    expect(local.releaseCount).toBe(0);
    await expect(
      budget.countKeyVersionReferences({ orgId: currentScope.orgId, keyVersion: 1 }),
    ).resolves.toBeGreaterThan(0);
  });

  it('does not release an intent whose base checkpoint drifted', async () => {
    const { currentScope, ledger, budget } = await leaveReadyReserved('base-drift');
    await runInDurableObject(ledger, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE pending_intents SET base_chain_head = 'sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'",
      );
    });
    await runInDurableObject(ledger, (instance: ArchiveSessionLedger) => instance.alarm());
    const local = await runInDurableObject(ledger, async (_instance, state) => ({
      pending: readPendingIntent(state.storage),
      alarm: await state.storage.getAlarm(),
    }));
    expect(local.pending).toMatchObject({ status: 'ready' });
    expect(local.alarm).not.toBeNull();
    await expect(
      budget.countKeyVersionReferences({ orgId: currentScope.orgId, keyVersion: 1 }),
    ).resolves.toBeGreaterThan(0);
  });

  it('serializes an alarm with a concurrent client commit exactly once', async () => {
    const { currentScope, request, ledger, budget } = await leaveReadyReserved('concurrent');
    const response = await runInDurableObject(ledger, async (instance: ArchiveSessionLedger) => {
      const alarm = instance.alarm();
      const commit = instance.fetch(
        new Request('https://ledger.test/commit', {
          method: 'POST',
          body: JSON.stringify(request),
        }),
      );
      const [, result] = await Promise.all([alarm, commit]);
      return { status: result.status, body: await result.json<Record<string, unknown>>() };
    });
    expect(response).toMatchObject({ status: 200, body: { generation: 1 } });
    const local = await runInDurableObject(ledger, (_instance, state) => {
      const checkpoint = readLedgerSnapshot(state.storage);
      return {
        checkpoint,
        elements: [
          ...state.storage.sql.exec<{ count: number }>(
            'SELECT COUNT(*) AS count FROM ledger_elements',
          ),
        ][0]!.count,
        releases: [
          ...state.storage.sql.exec<{ count: number }>(
            'SELECT COUNT(*) AS count FROM pending_releases',
          ),
        ][0]!.count,
        commits: [
          ...state.storage.sql.exec<{ count: number }>(
            'SELECT COUNT(*) AS count FROM pending_budget_commits',
          ),
        ][0]!.count,
      };
    });
    expect(local.checkpoint.generation).toBe(1);
    expect(local.elements).toBe(local.checkpoint.elementCount);
    expect(local).toMatchObject({ releases: 0, commits: 0 });
    const accounting = await budget.getStorageBudget({ orgId: currentScope.orgId });
    expect(accounting.reservedBytes).toBe(0);
    expect(accounting.committedBytes).toBeGreaterThan(0);
  });
});
