import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { stageAgentDelivery } from '@trace-flow/utils';
import type { AgentDeliveryReference, AgentDeliveryStagedReference } from '@trace-flow/types';
import { AgentDelivery } from '../agent-delivery';
import { priceDelivery, storeDeliveryRows } from '../delivery-rows';
import { emptyQueueFacts, messageFact, queueMessage } from './factories';
import { makeKv } from './harness';

const writes: Record<string, unknown>[][] = [];

async function staged(
  options: {
    days?: string[];
    legacySourceOrder?: boolean;
    message?: ReturnType<typeof queueMessage>;
  } = {},
) {
  const orgId = `test-${crypto.randomUUID()}`;
  const source =
    options.message ??
    queueMessage({
      facts: { ...emptyQueueFacts(), messages: [messageFact({ event_at: Date.now() })] },
    });
  const message = {
    ...source,
    tenancy: {
      ...source.tenancy,
      org_id: orgId,
    },
  };
  const reference = await stageAgentDelivery({
    storage: env.AGENT_DELIVERIES,
    message,
    encryption: { rootKeyBase64: env.BODY_ENCRYPTION_ROOT_KEY },
  });
  const host = env.AGENT_DELIVERY.getByName(reference.key);
  const revision = await host.register(
    reference,
    options.days ?? [new Date().toISOString().slice(0, 10)],
    options.legacySourceOrder ? { legacySourceOrder: true } : undefined,
  );
  return {
    host,
    stagedReference: reference,
    reference: { ...reference, delivery_revision: revision } as AgentDeliveryReference,
    orgId,
  };
}

async function unregistered() {
  const orgId = `test-${crypto.randomUUID()}`;
  const source = queueMessage({
    tenancy: {
      org_id: orgId,
      user_id: 'user',
      collector_id: 'collector',
      collector_credential_id: 'credential',
    },
  });
  const reference = await stageAgentDelivery({
    storage: env.AGENT_DELIVERIES,
    message: source,
    encryption: { rootKeyBase64: env.BODY_ENCRYPTION_ROOT_KEY },
  });
  return { host: env.AGENT_DELIVERY.getByName(reference.key), orgId, reference };
}

async function recoverySource(costUsd = 12.34) {
  const orgId = `test-${crypto.randomUUID()}`;
  const createdAt = Date.now();
  const expiresAt = createdAt + 24 * 60 * 60 * 1_000;
  const source = await priceDelivery(
    queueMessage({
      tenancy: {
        org_id: orgId,
        user_id: 'user',
        collector_id: 'collector',
        collector_credential_id: 'credential',
      },
      facts: { ...emptyQueueFacts(), messages: [messageFact()] },
    }),
    1,
    expiresAt,
    makeKv({}).kv,
  );
  (source.rows.messages[0] as Record<string, unknown>).cost_usd = costUsd;
  const key = `agent-deliveries/${orgId}/${crypto.randomUUID()}`;
  const sha256 = await storeDeliveryRows(env, key, source);
  const stagedReference: AgentDeliveryStagedReference = {
    type: 'agent-delivery',
    version: 1,
    key,
    org_id: orgId,
    sha256,
    created_at: createdAt,
    expires_at: expiresAt,
  };
  const days = [String((source.rows.messages[0] as Record<string, unknown>).EventAt).slice(0, 10)];
  const host = env.AGENT_DELIVERY.getByName(key);
  return { host, stagedReference, orgId, days };
}

async function stagedRecovery(costUsd = 12.34, proveCanonicalAbsence = false) {
  const source = await recoverySource(costUsd);
  const { host, stagedReference, orgId, days } = source;
  const revision = await host.registerPricedRecovery(
    stagedReference,
    days,
    proveCanonicalAbsence
      ? [
          {
            category: 'messages',
            factId: `${orgId}\x1fs1\x1fmsg_1`,
            expected: null,
          },
        ]
      : undefined,
  );
  return {
    ...source,
    reference: { ...stagedReference, delivery_revision: revision },
  };
}

function mockTransport(
  ambiguous = false,
  identityDays: {
    FactIdentity: string;
    EventDay: string;
    DeliverySequence: number;
    ContentHash?: string;
    IngestedAt?: string;
  }[] = [],
) {
  let first = true;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname.includes('agent_fact_identity_day')) {
        return Response.json({
          data: identityDays.map((row) => ({
            ContentHash: 'f'.repeat(64),
            IngestedAt: '2026-05-20 00:00:00.000',
            ...row,
          })),
        });
      }
      if (url.pathname.includes('agent_delivery_receipt'))
        return Response.json({
          data: writes.flat().map((row) => ({
            FactIdentity: `${String(row.OrgId)}\x1f${String(row.session_pk)}\x1f${String(row.message_pk)}`,
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
        writes.push(rows);
        if (ambiguous && first) {
          first = false;
          return Response.json({}, { status: 202 });
        }
        return Response.json({ successful_rows: rows.length, quarantined_rows: 0 });
      }
      throw new Error(`Unexpected test request ${url.pathname}`);
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  writes.length = 0;
});

describe('bounded delivery durability', () => {
  it('commits once, deletes encrypted bodies, and retains a small duplicate receipt', async () => {
    mockTransport();
    const { host, reference, orgId } = await staged();
    await host.process(reference);
    await host.process(reference);
    expect(writes).toHaveLength(1);
    expect(await env.AGENT_DELIVERIES.head(reference.key)).toBeNull();
    expect(
      await env.AGENT_DELIVERIES.head(
        reference.key.replace('agent-deliveries/', 'agent-delivery-rows/'),
      ),
    ).toBeNull();
    expect(
      await env.AGENT_DELIVERY_COORDINATOR.getByName(`org:${orgId}`).getStats({}),
    ).toMatchObject({ activeDeliveries: 0, dirtyDays: 1, incompleteDays: 0 });
    await runInDurableObject(host, async (_instance, state) => {
      const receipt = JSON.stringify(await state.storage.get('receipt'));
      expect(receipt.length).toBeLessThan(2048);
      expect(receipt).toContain('"inputFormat":"queue"');
      expect(receipt).not.toContain('input_tokens');
      expect(await state.storage.getAlarm()).toBe(reference.expires_at);
    });
  });

  it('reconciles an ambiguous committed insert without a second write', async () => {
    mockTransport(true);
    const { host, reference } = await staged();
    await runInDurableObject(host, async (instance) => {
      await expect(instance.process(reference)).rejects.toThrow();
    });
    expect(await env.AGENT_DELIVERIES.head(reference.key)).not.toBeNull();
    await host.process(reference);
    expect(writes).toHaveLength(1);
    expect(await env.AGENT_DELIVERIES.head(reference.key)).toBeNull();
  });

  it('confirms an all-superseded legacy delivery without writing facts', async () => {
    const enqueuedAt = Date.parse('2026-09-13T01:00:00.000Z');
    const message = queueMessage({
      enqueued_at: enqueuedAt,
      facts: {
        ...emptyQueueFacts(),
        messages: [messageFact({ event_at: enqueuedAt })],
      },
    });
    const stagedDelivery = await staged({ legacySourceOrder: true, message });
    mockTransport(false, [
      {
        FactIdentity: `${stagedDelivery.orgId}\x1fs1\x1fmsg_1`,
        EventDay: '2026-09-13',
        DeliverySequence: 1,
        ContentHash: 'f'.repeat(64),
        IngestedAt: '2026-09-13 02:00:00.000',
      },
    ]);

    await stagedDelivery.host.process(stagedDelivery.reference);

    expect(writes).toEqual([]);
    expect(await env.AGENT_DELIVERIES.head(stagedDelivery.reference.key)).toBeNull();
    expect(
      await env.AGENT_DELIVERIES.head(
        stagedDelivery.reference.key.replace('agent-deliveries/', 'agent-delivery-rows/'),
      ),
    ).toBeNull();
    expect(
      await env.AGENT_DELIVERY_COORDINATOR.getByName(`org:${stagedDelivery.orgId}`).getStats({}),
    ).toMatchObject({ activeDeliveries: 0, dirtyDays: 0, incompleteDays: 0 });
    await runInDurableObject(
      env.AGENT_DELIVERY_COORDINATOR.getByName(`org:${stagedDelivery.orgId}`),
      async (_instance, state) => {
        expect(await state.storage.getAlarm()).toBeNull();
      },
    );
    expect(
      vi.mocked(fetch).mock.calls.some(([input]) => String(input).includes('repair_agent_')),
    ).toBe(false);
    await runInDurableObject(stagedDelivery.host, async (_instance, state) => {
      expect(await state.storage.get('receipt')).toMatchObject({
        phase: 'complete',
        legacySourceOrder: true,
        plannedDirtyDays: [],
      });
    });
  });

  it('promotes only retained plan days when a legacy delivery is partly superseded', async () => {
    const enqueuedAt = Date.parse('2026-09-13T03:00:00.000Z');
    const message = queueMessage({
      enqueued_at: enqueuedAt,
      facts: {
        ...emptyQueueFacts(),
        messages: [
          messageFact({
            message_pk: 'msg_old',
            vendor_message_id: 'vm-old',
            event_at: Date.parse('2026-09-12T01:00:00.000Z'),
          }),
          messageFact({
            message_pk: 'msg_live',
            vendor_message_id: 'vm-live',
            event_at: Date.parse('2026-09-13T01:00:00.000Z'),
          }),
        ],
      },
    });
    const stagedDelivery = await staged({
      days: ['2026-09-12', '2026-09-13'],
      legacySourceOrder: true,
      message,
    });
    mockTransport(false, [
      {
        FactIdentity: `${stagedDelivery.orgId}\x1fs1\x1fmsg_old`,
        EventDay: '2026-09-12',
        DeliverySequence: 1,
        ContentHash: 'f'.repeat(64),
        IngestedAt: '2026-09-13 04:00:00.000',
      },
    ]);

    await stagedDelivery.host.process(stagedDelivery.reference);

    expect(writes.flat()).toHaveLength(1);
    expect(writes[0]![0]).toMatchObject({ message_pk: 'msg_live' });
    await expect(
      env.AGENT_DELIVERY_COORDINATOR.getByName(`org:${stagedDelivery.orgId}`).getStats({}),
    ).resolves.toMatchObject({ activeDeliveries: 0, dirtyDays: 1, incompleteDays: 0 });
    await expect(
      env.AGENT_DELIVERY_COORDINATOR.getByName(`org:${stagedDelivery.orgId}`).beginSnapshot({
        claimId: crypto.randomUUID(),
      }),
    ).resolves.toMatchObject({ dirtyDays: ['2026-09-13'] });
  });

  it('rejects tampered queue references before reading or writing facts', async () => {
    mockTransport();
    const { host, reference } = await staged();
    await runInDurableObject(host, async (instance) => {
      await expect(instance.process({ ...reference, sha256: 'f'.repeat(64) })).rejects.toThrow(
        'registered receipt',
      );
    });
    expect(writes).toHaveLength(0);
    expect(await env.AGENT_DELIVERIES.head(reference.key)).not.toBeNull();
  });

  it('expires failed delivery bodies and records an incomplete day instead of publishing partial totals', async () => {
    const { host, reference, orgId } = await staged();
    vi.spyOn(Date, 'now').mockReturnValue(reference.expires_at + 1);
    await runInDurableObject(host, async (instance, state) => {
      await instance.alarm();
      expect(await state.storage.get('receipt')).toBeUndefined();
      expect(await state.storage.getAlarm()).toBeNull();
    });
    expect(await env.AGENT_DELIVERIES.head(reference.key)).toBeNull();
    expect(
      await env.AGENT_DELIVERY_COORDINATOR.getByName(`org:${orgId}`).getStats({}),
    ).toMatchObject({ activeDeliveries: 0, dirtyDays: 1, incompleteDays: 1 });
  });

  it('recovers the crash between registration and queue publication through its alarm', async () => {
    const { host, reference } = await staged();
    const send = vi.fn(async () => undefined);
    await runInDurableObject(host, async (_instance, state) => {
      const delivery = new AgentDelivery(state, {
        ...env,
        AGENT_QUEUE: { send } as unknown as typeof env.AGENT_QUEUE,
      });
      await delivery.alarm();
      expect(send).toHaveBeenCalledWith(reference);
      expect(await state.storage.getAlarm()).not.toBeNull();
    });
  });

  it('removes a late staged body when erasure permanently rejects its reservation', async () => {
    const { host, reference } = await unregistered();
    const reserveError = new Error('agent ingestion erasure has started');
    const reserve = vi.fn().mockRejectedValue(reserveError);

    await runInDurableObject(host, async (_instance, state) => {
      const delivery = new AgentDelivery(state, {
        ...env,
        AGENT_DELIVERY_COORDINATOR: {
          getByName: vi.fn(() => ({
            reserve,
            getErasureState: vi.fn(async () => ({ erasureStarted: true })),
            getReservation: vi.fn(async () => null),
          })),
        } as unknown as typeof env.AGENT_DELIVERY_COORDINATOR,
      });

      await expect(
        delivery.register(reference, [new Date().toISOString().slice(0, 10)]),
      ).rejects.toThrow('agent ingestion erasure has started');
      expect(await state.storage.get('receipt')).toBeUndefined();
      expect(await state.storage.getAlarm()).toBeNull();
    });
    expect(await env.AGENT_DELIVERIES.head(reference.key)).toBeNull();
  });

  it('preserves a staged body when a failed reserve may already exist', async () => {
    const { host, reference } = await unregistered();
    const reserveError = new Error('reserve response was lost');
    const reserve = vi.fn().mockRejectedValue(reserveError);

    await runInDurableObject(host, async (_instance, state) => {
      const delivery = new AgentDelivery(state, {
        ...env,
        AGENT_DELIVERY_COORDINATOR: {
          getByName: vi.fn(() => ({
            reserve,
            getErasureState: vi.fn(async () => ({ erasureStarted: true })),
            getReservation: vi.fn(async () => ({
              deliveryId: reference.key,
              payloadSha256: reference.sha256,
            })),
          })),
        } as unknown as typeof env.AGENT_DELIVERY_COORDINATOR,
      });

      await expect(
        delivery.register(reference, [new Date().toISOString().slice(0, 10)]),
      ).rejects.toThrow('reserve response was lost');
      expect(await state.storage.get('receipt')).toMatchObject({ phase: 'registered' });
      expect(await state.storage.getAlarm()).not.toBeNull();
    });
    expect(await env.AGENT_DELIVERIES.head(reference.key)).not.toBeNull();
  });

  it('preserves canonical proof when an alarm retries an interrupted recovery registration', async () => {
    const { host, stagedReference, orgId, days } = await recoverySource();
    const proof = [
      {
        category: 'messages' as const,
        factId: `${orgId}\x1fs1\x1fmsg_1`,
        expected: null,
      },
    ];
    const reserve = vi
      .fn()
      .mockRejectedValueOnce(new Error('registration interrupted'))
      .mockResolvedValueOnce({ deliverySequence: 2 });
    const send = vi.fn(async () => undefined);

    await runInDurableObject(host, async (_instance, state) => {
      const delivery = new AgentDelivery(state, {
        ...env,
        AGENT_DELIVERY_COORDINATOR: {
          getByName: vi.fn(() => ({ reserve })),
        } as unknown as typeof env.AGENT_DELIVERY_COORDINATOR,
        AGENT_QUEUE: { send } as unknown as typeof env.AGENT_QUEUE,
      });
      await expect(delivery.registerPricedRecovery(stagedReference, days, proof)).rejects.toThrow(
        'registration interrupted',
      );
      await delivery.alarm();
      expect(send).toHaveBeenCalledWith({ ...stagedReference, delivery_revision: 2 });
      expect(await state.storage.get('receipt')).toMatchObject({
        canonicalProof: proof,
        revision: 2,
      });
    });
  });

  it('rejects changing a registered delivery from queue input to priced recovery', async () => {
    const { host, stagedReference } = await staged();

    await runInDurableObject(host, async (instance) => {
      await expect(
        instance.registerPricedRecovery(stagedReference, [new Date().toISOString().slice(0, 10)]),
      ).rejects.toThrow('registration conflict');
    });
  });

  it('rejects stale canonical absence proof under the write permit before inserting', async () => {
    const recovery = await stagedRecovery(12.34, true);
    mockTransport(false, [
      {
        FactIdentity: `${recovery.orgId}\x1fs1\x1fmsg_1`,
        EventDay: recovery.days[0]!,
        DeliverySequence: 2,
        ContentHash: 'f'.repeat(64),
      },
    ]);

    await runInDurableObject(recovery.host, async (instance, state) => {
      await expect(instance.process(recovery.reference)).rejects.toThrow('canonical fact changed');
      await state.storage.deleteAlarm();
    });
    expect(writes).toHaveLength(0);
    expect(await env.AGENT_DELIVERIES.head(recovery.reference.key)).not.toBeNull();
    await runInDurableObject(recovery.host, async (_instance, state) => {
      await state.storage.deleteAll();
    });
  });

  it('finishes a committing retry without rereading proof after its reservation completed', async () => {
    const recovery = await stagedRecovery(12.34, true);
    const identityDays: {
      FactIdentity: string;
      EventDay: string;
      DeliverySequence: number;
      ContentHash?: string;
      IngestedAt?: string;
    }[] = [];
    mockTransport(false, identityDays);
    let reservation: { payloadSha256: string; deliverySequence: number } | null = {
      payloadSha256: recovery.reference.sha256,
      deliverySequence: recovery.reference.delivery_revision,
    };
    const scheduleSnapshot = vi
      .fn()
      .mockRejectedValueOnce(new Error('snapshot scheduling interrupted'))
      .mockResolvedValueOnce({ scheduled: true });
    const send = vi.fn(async () => undefined);

    await runInDurableObject(recovery.host, async (_instance, state) => {
      const delivery = new AgentDelivery(state, {
        ...env,
        AGENT_DELIVERY_COORDINATOR: {
          getByName: vi.fn(() => ({
            getReservation: vi.fn(async () => reservation),
            acquireWrite: vi.fn(async () => true),
            replaceDirtyDays: vi.fn(async ({ dirtyDays }) => ({ dirtyDays })),
            linkDirtyDays: vi.fn(async () => undefined),
            complete: vi.fn(async () => {
              reservation = null;
            }),
            scheduleSnapshot,
            getNextDelivery: vi.fn(async () => null),
          })),
        } as unknown as typeof env.AGENT_DELIVERY_COORDINATOR,
        AGENT_QUEUE: { send } as unknown as typeof env.AGENT_QUEUE,
      });
      await expect(delivery.process(recovery.reference)).rejects.toThrow(
        'snapshot scheduling interrupted',
      );
      const identityReadsBeforeRetry = vi
        .mocked(fetch)
        .mock.calls.filter(([input]) => String(input).includes('agent_fact_identity_day')).length;
      identityDays.push({
        FactIdentity: `${recovery.orgId}\x1fs1\x1fmsg_1`,
        EventDay: recovery.days[0]!,
        DeliverySequence: recovery.reference.delivery_revision + 1,
        ContentHash: 'f'.repeat(64),
      });

      await delivery.process(recovery.reference);

      expect(
        vi
          .mocked(fetch)
          .mock.calls.filter(([input]) => String(input).includes('agent_fact_identity_day')),
      ).toHaveLength(identityReadsBeforeRetry);
      expect(await state.storage.get('receipt')).toMatchObject({ phase: 'complete' });
    });
    expect(writes).toHaveLength(1);
    expect(await env.AGENT_DELIVERIES.head(recovery.reference.key)).toBeNull();
  });

  it('keeps recovery cost, creates an old-day tombstone, and stores no facts in its receipt', async () => {
    const recovery = await stagedRecovery(98.7654321);
    const oldDay = '2026-05-19';
    mockTransport(false, [
      {
        FactIdentity: `${recovery.orgId}\x1fs1\x1fmsg_1`,
        EventDay: oldDay,
        DeliverySequence: 1,
      },
    ]);

    await recovery.host.process(recovery.reference);

    const rows = writes.flat();
    const live = rows.find((row) => row.IsDeleted === 0)!;
    const tombstone = rows.find((row) => row.IsDeleted === 1)!;
    expect(live).toMatchObject({
      OrgId: recovery.orgId,
      DeliverySequence: recovery.reference.delivery_revision,
      cost_usd: 98.7654321,
    });
    expect(tombstone).toMatchObject({
      OrgId: recovery.orgId,
      EventAt: `${oldDay} 00:00:00.000`,
      DeliverySequence: recovery.reference.delivery_revision,
      IsDeleted: 1,
    });
    expect(await env.AGENT_DELIVERIES.head(recovery.reference.key)).toBeNull();
    expect(
      await env.AGENT_DELIVERIES.head(
        recovery.reference.key.replace('agent-deliveries/', 'agent-delivery-rows/'),
      ),
    ).toBeNull();
    await runInDurableObject(recovery.host, async (_instance, state) => {
      const receipt = JSON.stringify(await state.storage.get('receipt'));
      expect(receipt).toContain('"inputFormat":"priced"');
      expect(receipt).not.toContain('98.7654321');
      expect(receipt).not.toContain('msg_1');
    });
  });

  it('reconciles an uncertain priced recovery write without repricing or changing its plan', async () => {
    const recovery = await stagedRecovery(54.321);
    mockTransport(true);
    const pricingGet = vi.fn(async () => {
      throw new Error('priced recovery must not read model pricing');
    });

    await runInDurableObject(recovery.host, async (_instance, state) => {
      const delivery = new AgentDelivery(state, {
        ...env,
        MODEL_PRICING: { get: pricingGet } as unknown as KVNamespace,
      });
      await expect(delivery.process(recovery.reference)).rejects.toThrow();
      expect(await env.AGENT_DELIVERIES.head(recovery.reference.key)).not.toBeNull();
      expect(
        await env.AGENT_DELIVERIES.head(
          recovery.reference.key.replace('agent-deliveries/', 'agent-delivery-rows/'),
        ),
      ).not.toBeNull();
      await delivery.process(recovery.reference);
    });

    expect(writes).toHaveLength(1);
    expect(writes[0]![0]).toMatchObject({
      DeliverySequence: recovery.reference.delivery_revision,
      cost_usd: 54.321,
    });
    expect(pricingGet).not.toHaveBeenCalled();
    expect(await env.AGENT_DELIVERIES.head(recovery.reference.key)).toBeNull();
    expect(
      await env.AGENT_DELIVERIES.head(
        recovery.reference.key.replace('agent-deliveries/', 'agent-delivery-rows/'),
      ),
    ).toBeNull();
  });
});
