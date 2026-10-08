import { env as workerEnv, runInDurableObject } from 'cloudflare:test';
import { sha256Hex } from '@trace-flow/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentDeadLettersInstance } from '../dead-letters';

const env = workerEnv as unknown as {
  AGENT_DEAD_LETTERS: DurableObjectNamespace<AgentDeadLettersInstance>;
};

describe('AgentDeadLetters', () => {
  let store: DurableObjectStub<AgentDeadLettersInstance>;

  beforeEach(() => {
    store = env.AGENT_DEAD_LETTERS.get(env.AGENT_DEAD_LETTERS.newUniqueId());
  });
  afterEach(() => vi.restoreAllMocks());

  it('preserves complete payloads and dedupes redelivery by key', async () => {
    const payload = JSON.stringify({ messageId: 'dead', body: { preserved: true } });
    const record = await store.preserveDlq(payload, '{"reason":"dead_letter"}', 'dead');
    expect(await store.preserveDlq(payload, '{"reason":"retry"}', 'dead')).toEqual(record);
    expect(await store.listRecovery()).toEqual({ records: [record], nextAfterId: null });
    expect(record).toMatchObject({ kind: 'dlq', state: 'blocked', payload });
  });

  it('retires a dead letter without Tinybird fetches and keeps its payload', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    const payload = JSON.stringify({ messageId: 'dead', body: { orgId: 'org-1' } });
    const dlq = await store.preserveDlq(payload, '{}', 'dead');
    const resolved = await store.reconcileRecovery({
      recoveryId: dlq.id,
      action: 'retire-dead-letter',
      reason: 'operator chose to retire the message',
    });
    expect(resolved).toMatchObject({
      state: 'resolved',
      resolution: 'retire-dead-letter',
      payload,
    });
    expect((await store.listRecovery()).records).toEqual([]);
    expect((await store.listRecovery({ state: 'resolved' })).records).toEqual([resolved]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects a wrong action and a blank reason without resolving the record', async () => {
    const dlq = await store.preserveDlq('{}', '{}', 'dead');
    await runInDurableObject(store, (instance) => {
      expect(() =>
        instance.reconcileRecovery({
          recoveryId: dlq.id,
          action: 'retain-original',
          reason: 'wrong action',
        }),
      ).toThrow('dlq recovery records allow retire-dead-letter');
      expect(() =>
        instance.reconcileRecovery({
          recoveryId: dlq.id,
          action: 'retire-dead-letter',
          reason: '   ',
        }),
      ).toThrow('recovery reason is required');
    });
    expect((await store.listRecovery()).records).toEqual([dlq]);
  });

  it('pages organization cleanup across other tenants and resolved records', async () => {
    const records = [];
    for (const [index, orgId] of ['org-2', 'org-1', 'org-2', 'org-1', 'org-2'].entries()) {
      records.push(
        await store.preserveDlq(
          JSON.stringify({ body: { tenancy: { org_id: orgId } } }),
          '{}',
          `dead-${index}`,
        ),
      );
    }
    await store.reconcileRecovery({
      recoveryId: records[3]!.id,
      action: 'retire-dead-letter',
      reason: 'retired before erasure',
    });
    const first = await store.discardOrganizationDlq('org-1', { limit: 1 });
    expect(first).toEqual({ deleted: 0, nextAfterId: records[0]!.id });
    const second = await store.discardOrganizationDlq('org-1', {
      afterId: first.nextAfterId!,
      limit: 2,
    });
    expect(second).toEqual({ deleted: 1, nextAfterId: records[2]!.id });
    expect(
      await store.discardOrganizationDlq('org-1', { afterId: second.nextAfterId!, limit: 2 }),
    ).toEqual({ deleted: 1, nextAfterId: null });
    expect((await store.listRecovery()).records).toEqual([records[0], records[2], records[4]]);
    expect((await store.listRecovery({ state: 'resolved' })).records).toEqual([]);
  });

  it('requires the exact payload hash before discarding a dead letter', async () => {
    const payload = '{"preserved":true}';
    const record = await store.preserveDlq(payload, '{}', 'dead');
    await runInDurableObject(store, async (instance) => {
      await expect(instance.discardDlq(record.id, 'invalid')).rejects.toThrow(
        'invalid expected DLQ payload hash',
      );
      await expect(instance.discardDlq(record.id, '0'.repeat(64))).rejects.toThrow(
        'DLQ payload hash does not match',
      );
    });
    expect((await store.listRecovery()).records).toEqual([record]);
    await store.discardDlq(record.id, await sha256Hex(payload));
    expect((await store.listRecovery()).records).toEqual([]);
    expect(await store.preserveDlq(payload, '{}', 'dead')).toMatchObject({
      state: 'blocked',
      payload,
    });
  });
});
