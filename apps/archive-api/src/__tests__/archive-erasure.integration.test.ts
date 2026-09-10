import { createExecutionContext, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { app } from '../index';
import { archiveOrganizationPrefix } from '../archive-storage-key';
import {
  assertArchiveWritable,
  beginArchiveErasureState,
  clearArchiveBudgetState,
  ledgerErasureOrgId,
  registeredArchiveLedgers,
  removeRegisteredArchiveLedgers,
} from '../archive-erasure-state';
import {
  base64,
  call,
  checkpoint,
  envelope,
  exactPrefix,
  newLedger,
  observation,
  partFor,
  runtimeEnv,
  scope,
} from './ledger.integration.fixtures';
import type { ArchiveScope, ArchiveUploadRequest } from '../archive-contract';

const SHARED_SECRET = 'archive-status-test-secret';

async function oneRecordEnvelope(currentScope: ArchiveScope): Promise<Record<string, unknown>> {
  const record = await observation(
    currentScope.source,
    currentScope.sourceSessionId,
    partFor(currentScope.source),
    'record-1',
    '"archive record"',
  );
  const upload: ArchiveUploadRequest = {
    source_session_id: currentScope.sourceSessionId,
    observations: [record],
    checkpoint: await checkpoint(
      currentScope.source,
      currentScope.sourceSessionId,
      partFor(currentScope.source),
      [record],
    ),
    complete_prefix_base64: base64(exactPrefix([record])),
  };
  return await envelope(currentScope, upload);
}

async function erasureRequest(path: string, body: unknown): Promise<Response> {
  return await app.fetch(
    new Request(`https://archive.test/internal/archive-erasure/${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${SHARED_SECRET}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    }),
    runtimeEnv,
    createExecutionContext(),
  );
}

describe('archive cryptoerasure', () => {
  it('erases an unregistered legacy ledger, keeps foreign state, and rejects late writes', async () => {
    const deletedScope = scope('codex', `erase-${crypto.randomUUID()}`);
    const foreignScope = scope('claude', `foreign-${crypto.randomUUID()}`);
    const deletedLedger = newLedger(deletedScope);
    const foreignLedger = newLedger(foreignScope);
    const deletedEnvelope = await oneRecordEnvelope(deletedScope);
    const foreignEnvelope = await oneRecordEnvelope(foreignScope);
    expect((await call(deletedLedger, deletedEnvelope)).response.status).toBe(200);
    expect((await call(foreignLedger, foreignEnvelope)).response.status).toBe(200);

    expect((await erasureRequest('begin', { orgId: deletedScope.orgId })).status).toBe(200);
    const ledgerResponse = await erasureRequest('ledgers', {
      orgId: deletedScope.orgId,
      ledgerIds: [deletedLedger.id.toString(), foreignLedger.id.toString()],
    });
    expect(ledgerResponse.status).toBe(200);
    expect(await ledgerResponse.json()).toEqual({ checked: 2, erased: 1 });
    const firstFinish = await erasureRequest('finish', { orgId: deletedScope.orgId });
    expect(firstFinish.status).toBe(200);
    expect(await firstFinish.json()).toEqual({ erased: false, deletedObjects: 2 });
    const finalFinish = await erasureRequest('finish', { orgId: deletedScope.orgId });
    expect(finalFinish.status).toBe(200);
    expect(await finalFinish.json()).toEqual({ erased: true, deletedObjects: 0 });

    const deletedObjects = await runtimeEnv.ARCHIVE_STORAGE.list({
      prefix: `${await archiveOrganizationPrefix(deletedScope.orgId)}/`,
    });
    expect(deletedObjects.objects).toHaveLength(0);
    const deletedState = await runInDurableObject(deletedLedger, async (_instance, state) => ({
      orgId: await ledgerErasureOrgId(state.storage),
      rows: [
        ...state.storage.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM ledger_state'),
      ][0]?.count,
    }));
    expect(deletedState).toEqual({ orgId: deletedScope.orgId, rows: 0 });
    const lateWrite = await call(deletedLedger, deletedEnvelope);
    expect(lateWrite.response.status).toBe(409);
    expect(lateWrite.body).toEqual({ error: 'archive_deleting' });

    const foreignRows = await runInDurableObject(foreignLedger, (_instance, state) => [
      ...state.storage.sql.exec('SELECT data FROM ledger_state'),
    ]);
    expect(foreignRows).toHaveLength(1);
  });

  it('uses the budget tombstone to reject a ledger registration after deletion starts', async () => {
    const currentScope = scope('codex', `registration-race-${crypto.randomUUID()}`);
    const budget = runtimeEnv.STORAGE_BUDGET.getByName(currentScope.orgId);
    await budget.beginArchiveErasure({ orgId: currentScope.orgId });

    await runInDurableObject(budget, async (_instance, state) => {
      await expect(assertArchiveWritable(state.storage)).rejects.toMatchObject({
        errorClass: 'archive_deleting',
      });
    });
  });

  it('tombstones a registered ledger before its first commit can store scope', async () => {
    const currentScope = scope('codex', `registered-race-${crypto.randomUUID()}`);
    const ledger = newLedger(currentScope);
    const budget = runtimeEnv.STORAGE_BUDGET.getByName(currentScope.orgId);
    const pendingEnvelope = await oneRecordEnvelope(currentScope);
    await budget.registerLedger({
      orgId: currentScope.orgId,
      ledgerId: ledger.id.toString(),
    });

    expect((await erasureRequest('begin', { orgId: currentScope.orgId })).status).toBe(200);
    const erased = await erasureRequest('ledgers', {
      orgId: currentScope.orgId,
      ledgerIds: [],
      includeRegistered: true,
    });
    expect(erased.status).toBe(200);
    expect(await erased.json()).toEqual({ checked: 1, erased: 1 });

    const lateCommit = await call(ledger, pendingEnvelope);
    expect(lateCommit.response.status).toBe(409);
    expect(lateCommit.body).toEqual({ error: 'archive_deleting' });
    expect(
      (
        await runtimeEnv.ARCHIVE_STORAGE.list({
          prefix: `${await archiveOrganizationPrefix(currentScope.orgId)}/`,
        })
      ).objects,
    ).toHaveLength(0);
  });

  it('requires the internal Archive API authority', async () => {
    const response = await app.fetch(
      new Request('https://archive.test/internal/archive-erasure/begin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orgId: 'org-unauthorized' }),
      }),
      runtimeEnv,
      createExecutionContext(),
    );
    expect(response.status).toBe(401);
  });

  it('pages and clears a large registry while retaining the budget tombstone', async () => {
    const orgId = `org-registry-${crypto.randomUUID()}`;
    const budget = runtimeEnv.STORAGE_BUDGET.getByName(orgId);
    await runInDurableObject(budget, async (_instance, state) => {
      const entries = Object.fromEntries(
        Array.from({ length: 101 }, (_, index) => {
          const ledgerId = index.toString(16).padStart(64, '0');
          return [`archive_ledger:${ledgerId}`, orgId];
        }),
      );
      await state.storage.put(entries);
      await beginArchiveErasureState(state.storage, orgId);

      const first = await registeredArchiveLedgers(state.storage, orgId, undefined, 100);
      expect(first.ledgerIds).toHaveLength(100);
      expect(first.cursor).toBe(first.ledgerIds.at(-1));
      await removeRegisteredArchiveLedgers(state.storage, orgId, first.ledgerIds);

      const second = await registeredArchiveLedgers(state.storage, orgId, first.cursor, 100);
      expect(second.ledgerIds).toHaveLength(1);
      expect(second.cursor).toBeUndefined();
      await removeRegisteredArchiveLedgers(state.storage, orgId, second.ledgerIds);
      await clearArchiveBudgetState(state.storage);

      await expect(assertArchiveWritable(state.storage)).rejects.toMatchObject({
        errorClass: 'archive_deleting',
      });
      const stateRows = [
        ...state.storage.sql.exec<{ count: number }>(
          'SELECT COUNT(*) AS count FROM storage_budget_state',
        ),
      ];
      expect(stateRows[0]?.count).toBe(0);
    });
  });
});
