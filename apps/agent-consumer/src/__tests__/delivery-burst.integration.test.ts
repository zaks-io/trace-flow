import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import { stageAgentDelivery } from '@trace-flow/utils';
import type { AgentDeliveryReference } from '@trace-flow/types';
import { AgentDelivery } from '../agent-delivery';
import type { AgentConsumerEnv } from '../context';
import { processDeliveryReferences } from '../delivery-queue';
import { emptyQueueFacts, messageFact, queueMessage } from './factories';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('completes an ordered 20-delivery burst through crashes, duplicates and lost replies', async () => {
  let now = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const orgId = `burst-${crypto.randomUUID()}`;
  const references: AgentDeliveryReference[] = [];
  const pending: { reference: AgentDeliveryReference; due: number }[] = [];
  const writes: Record<string, unknown>[] = [];
  const instances = new Map<string, InstanceType<typeof AgentDelivery>>();
  const counts = { process: 0, sends: 0, deletes: 0, rowReads: 0 };
  let lostFinish = false;
  let lostSend = false;
  let uncertainWrite = false;
  const coordinator = env.AGENT_DELIVERY_COORDINATOR.getByName(`org:${orgId}`);
  const observed = {
    ...env,
    AGENT_DELIVERIES: new Proxy(env.AGENT_DELIVERIES, {
      get(bucket, method) {
        if (method === 'delete')
          return async (keys: string | string[]) => {
            counts.deletes++;
            return bucket.delete(keys);
          };
        if (method === 'get')
          return async (key: string) => {
            if (key.startsWith('agent-delivery-rows/')) counts.rowReads++;
            return bucket.get(key);
          };
        const value = Reflect.get(bucket, method);
        return typeof value === 'function' ? value.bind(bucket) : value;
      },
    }),
    AGENT_QUEUE: {
      send: async (reference: AgentDeliveryReference) => {
        counts.sends++;
        pending.push({ reference, due: now });
        if (
          reference.delivery_revision === references[6]?.delivery_revision &&
          writes.some((row) => row.DeliverySequence === references[5]?.delivery_revision) &&
          !lostSend
        ) {
          lostSend = true;
          throw new Error('queue send reply lost after publication');
        }
      },
    },
    AGENT_DELIVERY_COORDINATOR: {
      getByName: () =>
        new Proxy(env.AGENT_DELIVERY_COORDINATOR.getByName(`org:${orgId}`), {
          get(stub, method) {
            if (method === 'finishDelivery')
              return async (input: Parameters<typeof coordinator.finishDelivery>[0]) => {
                const result = await stub.finishDelivery(input);
                if (input.deliveryId === references[4]?.key && !lostFinish) {
                  lostFinish = true;
                  throw new Error('finish reply lost after coordinator commit');
                }
                return result;
              };
            const value = Reflect.get(stub, method);
            return typeof value === 'function'
              ? (...args: unknown[]) => Reflect.apply(value, stub, args)
              : value;
          },
        }),
    },
    AGENT_DELIVERY: {
      getByName: (key: string) => ({
        process: async (reference: AgentDeliveryReference) => {
          counts.process++;
          const outcome = await runInDurableObject(
            env.AGENT_DELIVERY.getByName(key),
            async (_instance, state) => {
              try {
                return { result: await deliveryFor(reference.key, state).process(reference) };
              } catch (error) {
                return { error: String(error) };
              }
            },
          );
          if (outcome.error) throw new Error(outcome.error);
          return outcome.result;
        },
      }),
    },
  } as unknown as AgentConsumerEnv;
  function deliveryFor(key: string, state: DurableObjectState) {
    let delivery = instances.get(key);
    if (!delivery) {
      delivery = new AgentDelivery(state, observed);
      instances.set(key, delivery);
    }
    return delivery;
  }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/agent_fact_identity_day_batch.json'))
        return Response.json({ data: [] });
      if (url.pathname.includes('agent_delivery_receipt'))
        return Response.json({
          data: writes
            .filter(
              (row) => row.DeliverySequence === Number(url.searchParams.get('delivery_sequence')),
            )
            .map((row) => ({
              FactIdentity: `${orgId}\x1fs1\x1f${String(row.message_pk)}`,
              EventDay: String(row.EventAt).slice(0, 10),
              IsDeleted: row.IsDeleted,
              ContentHash: row.ContentHash,
            })),
        });
      if (url.pathname === '/v0/events') {
        const rows = String(init?.body)
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line));
        writes.push(...rows);
        if (rows[0]?.DeliverySequence === references[8]?.delivery_revision && !uncertainWrite) {
          uncertainWrite = true;
          return Response.json({}, { status: 202 });
        }
        return Response.json({ successful_rows: rows.length, quarantined_rows: 0 });
      }
      throw new Error(`Unexpected burst request ${url.pathname}`);
    }),
  );
  for (let index = 0; index < 20; index++) {
    const reference = await stageAgentDelivery({
      storage: observed.AGENT_DELIVERIES,
      message: queueMessage({
        tenancy: { org_id: orgId, user_id: 'u', collector_id: 'c', collector_credential_id: 'cc' },
        facts: {
          ...emptyQueueFacts(),
          messages: [messageFact({ message_pk: `message-${index}`, event_at: now })],
        },
      }),
      encryption: { rootKeyBase64: env.BODY_ENCRYPTION_ROOT_KEY },
    });
    const revision = await env.AGENT_DELIVERY.getByName(reference.key).register(reference, [
      new Date(now).toISOString().slice(0, 10),
    ]);
    if (revision === null) throw new Error('Expected admitted burst');
    references.push({ ...reference, delivery_revision: revision });
  }
  // The first publisher crashes after registration. Other initial messages arrive in reverse order.
  pending.push(
    ...references
      .slice(1)
      .reverse()
      .map((reference) => ({ reference, due: now })),
  );
  async function dispatchDue() {
    const due = pending.filter((entry) => entry.due <= now);
    for (const entry of due) pending.splice(pending.indexOf(entry), 1);
    const acknowledged: AgentDeliveryReference[] = [];
    await processDeliveryReferences(
      due.map(({ reference }) => ({
        id: crypto.randomUUID(),
        timestamp: new Date(now),
        attempts: 1,
        body: reference,
        ack: () => {
          acknowledged.push(reference);
        },
        retry: (options?: QueueRetryOptions) => {
          pending.push({ reference, due: now + (options?.delaySeconds ?? 60) * 1000 });
        },
      })),
      observed,
    );
    for (const reference of acknowledged) {
      await runInDurableObject(
        env.AGENT_DELIVERY.getByName(reference.key),
        async (_instance, state) => {
          expect(await state.storage.get('receipt')).toMatchObject({ phase: 'complete' });
        },
      );
    }
  }
  for (let turn = 0; turn < 80; turn++) {
    for (const reference of references) {
      await runInDurableObject(
        env.AGENT_DELIVERY.getByName(reference.key),
        async (_instance, state) => {
          const alarm = await state.storage.getAlarm();
          if (alarm !== null && alarm <= now) await deliveryFor(reference.key, state).alarm();
        },
      );
    }
    await dispatchDue();
    if (writes.length === 20 && (await coordinator.getStats({})).activeDeliveries === 0) break;
    now += 60_000;
  }
  expect(writes.map((row) => row.DeliverySequence)).toEqual(
    references.map((reference) => reference.delivery_revision),
  );
  for (const reference of references) {
    pending.push({ reference, due: now });
  }
  await dispatchDue();
  // Include original waiting messages when their delayed retry becomes due.
  now += 12 * 60 * 60_000;
  await dispatchDue();
  for (const reference of references) {
    await runInDurableObject(
      env.AGENT_DELIVERY.getByName(reference.key),
      async (_instance, state) => {
        expect(await state.storage.get('receipt')).toMatchObject({ phase: 'complete' });
      },
    );
  }
  expect({ lostFinish, lostSend, uncertainWrite }).toEqual({
    lostFinish: true,
    lostSend: true,
    uncertainWrite: true,
  });
  console.info('delivery_burst_counts', counts);
  expect(counts.process).toBeLessThan(130);
  expect(counts.sends).toBeLessThan(50);
  expect(counts.deletes).toBe(20);
  expect(counts.rowReads).toBe(1);
}, 60_000);
