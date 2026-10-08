import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { AGENT_DEAD_LETTERS_INSTANCE_NAME } from '../dead-letters';
import { TraceRecovery } from '../index';

describe('agent TraceRecovery dead-letter routing', () => {
  it.each(['org-1', '', ' __dlq__ ', 'other:__dlq__'])(
    'rejects shard %j for both recovery operations',
    async (shardId) => {
      const ctx = createExecutionContext();
      const service = new TraceRecovery(ctx, env);
      await expect(async () => service.listRecovery(shardId)).rejects.toThrow(
        'Agent recovery records exist only in the shared dead-letter store',
      );
      await expect(async () =>
        service.reconcileRecovery(shardId, {
          recoveryId: 1,
          action: 'retire-dead-letter',
          reason: 'operator decision',
        }),
      ).rejects.toThrow('shardId must be "__dlq__"');
      await waitOnExecutionContext(ctx);
    },
  );

  it('lists and retires dead letters through the shared shard', async () => {
    const ctx = createExecutionContext();
    const service = new TraceRecovery(ctx, env);
    const store = env.AGENT_DEAD_LETTERS.getByName(AGENT_DEAD_LETTERS_INSTANCE_NAME);
    const record = await store.preserveDlq('{"complete":true}', '{}', crypto.randomUUID());
    const page = await service.listRecovery('__dlq__', { afterId: record.id - 1 });
    expect(page.records).toEqual([record]);
    const resolved = await service.reconcileRecovery('__dlq__', {
      recoveryId: record.id,
      action: 'retire-dead-letter',
      reason: 'operator decision',
    });
    expect(resolved).toMatchObject({ state: 'resolved', payload: record.payload });
    expect(
      (await service.listRecovery('__dlq__', { state: 'resolved', afterId: record.id - 1 }))
        .records,
    ).toEqual([resolved]);
    await waitOnExecutionContext(ctx);
  });
});
