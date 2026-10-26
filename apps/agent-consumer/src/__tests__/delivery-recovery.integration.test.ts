import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import { stageAgentDelivery } from '@trace-flow/utils';
import { AgentDelivery } from '../agent-delivery';
import type { AgentConsumerEnv } from '../context';
import { emptyQueueFacts, messageFact, queueMessage } from './factories';

afterEach(() => vi.restoreAllMocks());

async function delivery(orgId = `recovery-${crypto.randomUUID()}`) {
  const staged = await stageAgentDelivery({
    storage: env.AGENT_DELIVERIES,
    message: queueMessage({
      tenancy: { org_id: orgId, user_id: 'u', collector_id: 'c', collector_credential_id: 'cc' },
      facts: { ...emptyQueueFacts(), messages: [messageFact({ event_at: Date.now() })] },
    }),
    encryption: { rootKeyBase64: env.BODY_ENCRYPTION_ROOT_KEY },
  });
  const host = env.AGENT_DELIVERY.getByName(staged.key);
  const revision = await host.register(staged, [new Date().toISOString().slice(0, 10)]);
  if (revision === null) throw new Error('Expected admitted delivery');
  return { host, reference: { ...staged, delivery_revision: revision }, orgId };
}

function transport(failInsert = false) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    if (new URL(String(input)).pathname !== '/v0/events') return Response.json({ data: [] });
    if (failInsert) throw new Error('insert unavailable');
    return Response.json({
      successful_rows: String(init?.body).trim().split('\n').length,
      quarantined_rows: 0,
    });
  });
}

it('does no R2 cleanup on completed revisits or retention alarms and upgrades a legacy receipt once', async () => {
  transport();
  const f = await delivery();
  await f.host.process(f.reference);
  await runInDurableObject(f.host, async (_instance, state) => {
    const remove = vi.fn(async () => undefined);
    const instance = new AgentDelivery(state, {
      ...env,
      AGENT_DELIVERIES: { delete: remove },
    } as unknown as AgentConsumerEnv);
    await instance.process(f.reference);
    await instance.alarm();
    expect(remove).not.toHaveBeenCalled();
    const receipt = await state.storage.get<Record<string, unknown>>('receipt');
    delete receipt!.bodiesRemoved;
    await state.storage.put('receipt', receipt);
    remove.mockRejectedValueOnce(new Error('delete interrupted'));
    await expect(instance.process(f.reference)).rejects.toThrow('delete interrupted');
    expect(await state.storage.get('receipt')).not.toHaveProperty('bodiesRemoved');
    await instance.process(f.reference);
    await instance.process(f.reference);
    expect(remove).toHaveBeenCalledTimes(2);
    vi.spyOn(Date, 'now').mockReturnValue(f.reference.expires_at);
    await instance.alarm();
    expect(remove).toHaveBeenCalledTimes(2);
    expect(await state.storage.get('receipt')).toBeUndefined();
  });
});

it('finishes the last committing snapshot handoff after expiry without replaying facts', async () => {
  const fetch = transport();
  const f = await delivery();
  await runInDurableObject(f.host, async (_instance, state) => {
    const coordinator = env.AGENT_DELIVERY_COORDINATOR.getByName(`org:${f.orgId}`);
    expect((await coordinator.getSnapshotSchedule({})).wakeAtMs).toBeNull();
    const instance = new AgentDelivery(state, {
      ...env,
      AGENT_DELIVERY_COORDINATOR: {
        getByName: () =>
          new Proxy(coordinator, {
            get(stub, method) {
              if (method === 'finishDelivery')
                return async (input: Parameters<typeof coordinator.finishDelivery>[0]) => {
                  await stub.complete({
                    deliveryId: input.deliveryId,
                    payloadSha256: input.payloadSha256,
                  });
                  throw new Error('crash before snapshot scheduling');
                };
              const value = Reflect.get(stub, method);
              return typeof value === 'function'
                ? (...args: unknown[]) => Reflect.apply(value, stub, args)
                : value;
            },
          }),
      },
    } as unknown as AgentConsumerEnv);
    await expect(instance.process(f.reference)).rejects.toThrow('crash before snapshot scheduling');
    expect(await coordinator.getReservation({ deliveryId: f.reference.key })).toBeNull();
    expect((await coordinator.getSnapshotSchedule({})).wakeAtMs).toBeNull();
    const reads = fetch.mock.calls.length;
    vi.spyOn(Date, 'now').mockReturnValue(f.reference.expires_at + 1);
    await new AgentDelivery(state, env).alarm();
    expect(fetch).toHaveBeenCalledTimes(reads);
    expect((await coordinator.getSnapshotSchedule({})).wakeAtMs).not.toBeNull();
    expect(await state.storage.get('receipt')).toBeUndefined();
  });
});

it.each(['coordinator', 'receipt-cleanup'] as const)(
  'retains explicit expiry recovery beyond eight %s failures',
  async (failure) => {
    const f = await delivery();
    let now = f.reference.expires_at;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    await runInDurableObject(f.host, async (_instance, state) => {
      const cleanup = vi.spyOn(state.storage, 'deleteAll');
      const probe = vi.fn().mockRejectedValue(new Error('coordinator unavailable'));
      if (failure === 'receipt-cleanup')
        cleanup.mockRejectedValue(new Error('cleanup unavailable'));
      const instance = new AgentDelivery(
        state,
        failure === 'coordinator'
          ? ({
              ...env,
              AGENT_DELIVERY_COORDINATOR: { getByName: () => ({ getReservation: probe }) },
            } as unknown as AgentConsumerEnv)
          : env,
      );
      for (let attempt = 0; attempt < 8; attempt++) {
        await expect(instance.alarm()).rejects.toThrow('unavailable');
        expect(await state.storage.getAlarm()).toBe(now + 60_000);
        expect(await state.storage.get('receipt')).toMatchObject({ phase: 'expired' });
        now += 60_000;
      }
      cleanup.mockRestore();
      await new AgentDelivery(state, env).alarm();
      expect(await state.storage.get('receipt')).toBeUndefined();
      expect(await state.storage.getAlarm()).toBeNull();
    });
    expect(
      await env.AGENT_DELIVERY_COORDINATOR.getByName(`org:${f.orgId}`).getStats({}),
    ).toMatchObject({ activeDeliveries: 0, incompleteDays: 1 });
  },
);

it('wakes the successor after head expiry even while erasure drains admitted writes', async () => {
  transport();
  const first = await delivery();
  vi.spyOn(Date, 'now').mockReturnValue(first.reference.created_at + 1_000);
  const second = await delivery(first.orgId);
  const coordinator = env.AGENT_DELIVERY_COORDINATOR.getByName(`org:${first.orgId}`);
  await coordinator.beginErasure({});
  vi.spyOn(Date, 'now').mockReturnValue(first.reference.expires_at);
  await runInDurableObject(first.host, async (instance) => instance.alarm());
  await runInDurableObject(second.host, async (_instance, state) => {
    const send = vi.fn(async () => undefined);
    await new AgentDelivery(state, {
      ...env,
      AGENT_QUEUE: { send },
    } as unknown as AgentConsumerEnv).alarm();
    expect(send).toHaveBeenCalledExactlyOnceWith(second.reference);
  });
  await second.host.process(second.reference);
  expect(await coordinator.getErasureState({})).toMatchObject({ ready: true });
});

it('keeps recovery armed when the head probe fails and publishes once it recovers', async () => {
  const f = await delivery();
  await runInDurableObject(f.host, async (_instance, state) => {
    const instance = new AgentDelivery(state, {
      ...env,
      AGENT_DELIVERY_COORDINATOR: {
        getByName: () => ({
          getNextDelivery: async () => {
            throw new Error('probe unavailable');
          },
        }),
      },
    } as unknown as AgentConsumerEnv);
    await expect(instance.alarm()).rejects.toThrow('probe unavailable');
    expect(await state.storage.getAlarm()).not.toBeNull();
    const send = vi.fn(async () => undefined);
    await new AgentDelivery(state, {
      ...env,
      AGENT_QUEUE: { send },
    } as unknown as AgentConsumerEnv).alarm();
    expect(send).toHaveBeenCalledExactlyOnceWith(f.reference);
  });
});

it('verifies the persisted hash on a resumed plan before another write', async () => {
  transport(true);
  const f = await delivery();
  await runInDurableObject(f.host, async (instance, state) => {
    await expect(instance.process(f.reference)).rejects.toThrow();
    const receipt = await state.storage.get<Record<string, unknown>>('receipt');
    receipt!.rowsSha256 = 'f'.repeat(64);
    await state.storage.put('receipt', receipt);
    const fetch = transport();
    fetch.mockClear();
    await expect(instance.process(f.reference)).rejects.toThrow('integrity check');
    expect(fetch).not.toHaveBeenCalled();
    expect(await env.AGENT_DELIVERIES.head(f.reference.key)).not.toBeNull();
  });
});
