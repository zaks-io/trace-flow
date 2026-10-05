import * as Sentry from '@sentry/cloudflare';
import { env, evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { stageAgentDelivery } from '@trace-flow/utils';
import { captureSafeException } from '@trace-flow/utils/sentry-tracing';
import type { AgentDeliveryReference } from '@trace-flow/types';
import { queueMessage, emptyQueueFacts, messageFact } from './factories';
import { AgentDelivery } from '../agent-delivery';

const { events } = vi.hoisted(() => ({ events: [] as Sentry.Event[] }));
const TRACE_A = '11111111111111111111111111111111';
const TRACE_B = '22222222222222222222222222222222';
const PARENT = '3333333333333333';

function testClient(captured = events) {
  const client = new Sentry.CloudflareClient({
    dsn: 'https://public@example.test/1',
    integrations: [],
    stackParser: () => [],
    tracesSampleRate: 1,
    transport: () => ({
      send: async (envelope) => {
        for (const [header, payload] of envelope[1])
          if (header.type === 'event' || header.type === 'transaction')
            captured.push(payload as Sentry.Event);
        return { statusCode: 200 };
      },
      flush: async () => true,
    }),
  });
  client.init();
  return client;
}

async function process(delivery: Awaited<ReturnType<typeof staged>>) {
  return runInDurableObject(delivery.host, async (instance: InstanceType<typeof AgentDelivery>) => {
    const client = testClient();
    try {
      return await Sentry.withScope((scope) => {
        scope.setClient(client);
        return Sentry.continueTrace(
          { sentryTrace: `${TRACE_B}-${PARENT}-1`, baggage: undefined },
          () =>
            Sentry.startSpan({ name: 'test rpc invocation', forceTransaction: true }, () =>
              instance.process(delivery.reference),
            ),
        );
      });
    } finally {
      await client.flush(1000);
    }
  });
}

async function staged(traceId = TRACE_A, orgId = `tracing-${crypto.randomUUID()}`) {
  const message = queueMessage({
    tenancy: {
      org_id: orgId,
      user_id: 'user',
      collector_id: 'collector',
      collector_credential_id: 'credential',
    },
    facts: { ...emptyQueueFacts(), messages: [messageFact({ event_at: Date.now() })] },
    sentry_trace_context: {
      'sentry-trace': `${traceId}-${PARENT}-1`,
      baggage: 'private=value,sentry-release=private-release',
    },
  });
  const reference = await stageAgentDelivery({
    storage: env.AGENT_DELIVERIES,
    message,
    encryption: { rootKeyBase64: env.BODY_ENCRYPTION_ROOT_KEY },
  });
  const host = env.AGENT_DELIVERY.getByName(reference.key);
  const revision = await host.register(reference, [new Date().toISOString().slice(0, 10)]);
  return {
    host,
    reference: { ...reference, delivery_revision: revision } as AgentDeliveryReference,
  };
}

function writes(fail = false, onSentry?: () => void) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    if (new URL(String(input)).hostname === 'example.test') {
      const lines = String(init?.body).split('\n');
      for (let i = 1; i < lines.length - 1; i += 2) {
        if (['event', 'transaction'].includes(JSON.parse(lines[i]!).type))
          events.push(JSON.parse(lines[i + 1]!));
      }
      onSentry?.();
      return new Response('{}');
    }
    if (new URL(String(input)).pathname !== '/v0/events') return Response.json({ data: [] });
    if (fail) throw new Error('private-upstream-body');
    const count = String(init?.body).trim().split('\n').length;
    return Response.json({ successful_rows: count, quarantined_rows: 0 });
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  events.length = 0;
});

describe('durable producer tracing', () => {
  it('restores distinct producers and stores no baggage or payload in plaintext tracing metadata', async () => {
    writes(true);
    const deliveries = await Promise.all([staged(TRACE_A), staged(TRACE_B)]);
    for (const delivery of deliveries) await expect(process(delivery)).rejects.toThrow();
    const errors = events.filter(
      (event) => event.exception && event.tags?.operation === 'agent_delivery.process',
    );
    expect(errors.map((event) => event.contexts?.trace?.trace_id).sort()).toEqual([
      TRACE_A,
      TRACE_B,
    ]);
    for (const [index, delivery] of deliveries.entries()) {
      await runInDurableObject(delivery.host, async (_instance, state) => {
        const receipt = await state.storage.get<{ sentryTraceHeader: string; rowsSha256: string }>(
          'receipt',
        );
        expect(receipt?.sentryTraceHeader).toBe(`${[TRACE_A, TRACE_B][index]}-${PARENT}-1`);
        expect(receipt?.rowsSha256).toBeTruthy();
        expect(JSON.stringify(receipt)).not.toMatch(/private=value|private-release|input_tokens/);
      });
    }
    expect(JSON.stringify(errors)).not.toContain('private-upstream-body');
  });

  it('continues a rows-ready retry without rereading the deleted source', async () => {
    writes(true);
    const delivery = await staged();
    await expect(process(delivery)).rejects.toThrow();
    await env.AGENT_DELIVERIES.delete(delivery.reference.key);
    vi.restoreAllMocks();
    writes();
    await expect(process(delivery)).resolves.toBe('complete');
    expect(
      events
        .filter((event) => event.transaction === 'process agent-delivery')
        .map((event) => event.contexts?.trace?.trace_id),
    ).toEqual([TRACE_A, TRACE_A]);
  });

  it('keeps producer context when the coordinator constructs cold during processing', async () => {
    writes(true);
    const delivery = await staged();
    await evictDurableObject(
      env.AGENT_DELIVERY_COORDINATOR.getByName(`org:${delivery.reference.org_id}`),
    );
    await expect(process(delivery)).rejects.toThrow();
    const failure = events.find(
      (event) => event.exception && event.tags?.operation === 'agent_delivery.process',
    );
    expect(failure?.contexts?.trace?.trace_id).toBe(TRACE_A);
    const processing = events.find((event) => event.transaction === 'process agent-delivery');
    expect(processing?.spans?.some((span) => span.op === 'db.query')).toBe(true);
    expect(processing?.spans?.every((span) => span.trace_id === TRACE_A)).toBe(true);
    vi.restoreAllMocks();
    writes();
    await evictDurableObject(
      env.AGENT_DELIVERY_COORDINATOR.getByName(`org:${delivery.reference.org_id}`),
    );
    await expect(process(delivery)).resolves.toBe('complete');
    await runInDurableObject(
      env.AGENT_DELIVERY_COORDINATOR.getByName(`org:${delivery.reference.org_id}`),
      async (_instance, state) => {
        const links = state.storage.sql
          .exec<{ sentry_trace: string }>('SELECT sentry_trace FROM snapshot_producer_traces')
          .toArray();
        expect(links.length).toBeGreaterThan(0);
        expect(links.every((link) => link.sentry_trace.startsWith(`${TRACE_A}-`))).toBe(true);
      },
    );
  });

  it.each([undefined, null])(
    'keeps caller context for a legacy rows-ready header %s',
    async (header) => {
      writes(true);
      const delivery = await staged();
      await expect(process(delivery)).rejects.toThrow();
      await runInDurableObject(delivery.host, async (_instance, state) => {
        const receipt = await state.storage.get<Record<string, unknown>>('receipt');
        expect(receipt?.rowsSha256).toBeTruthy();
        if (header === undefined) delete receipt!.sentryTraceHeader;
        else receipt!.sentryTraceHeader = header;
        await state.storage.put('receipt', receipt!);
      });
      await env.AGENT_DELIVERIES.delete(delivery.reference.key);
      events.length = 0;
      await expect(process(delivery)).rejects.toThrow();
      const failure = events.find(
        (event) => event.exception && event.tags?.operation === 'agent_delivery.process',
      );
      expect(failure?.contexts?.trace?.trace_id).toBe(TRACE_B);
      expect(events.some((event) => event.transaction === 'process agent-delivery')).toBe(false);
    },
  );

  it('preserves reference idempotency after producer metadata is persisted', async () => {
    writes(true);
    const delivery = await staged();
    await expect(process(delivery)).rejects.toThrow();
    const { delivery_revision: revision, ...reference } = delivery.reference;
    await expect(
      delivery.host.register(reference, [new Date().toISOString().slice(0, 10)]),
    ).resolves.toBe(revision);
    expect(Object.keys(reference).sort()).toEqual([
      'created_at',
      'expires_at',
      'key',
      'org_id',
      'sha256',
      'type',
      'version',
    ]);
  });

  it('finishes a committing retry under its stored producer after source and rows disappear', async () => {
    writes();
    const delivery = await staged();
    await expect(process(delivery)).resolves.toBe('complete');
    expect(await env.AGENT_DELIVERIES.head(delivery.reference.key)).toBeNull();
    await runInDurableObject(delivery.host, async (_instance, state) => {
      const receipt = await state.storage.get<Record<string, unknown>>('receipt');
      expect(receipt?.plannedDirtyDays).toBeDefined();
      await state.storage.put('receipt', { ...receipt, phase: 'committing' });
    });
    events.length = 0;
    await expect(process(delivery)).resolves.toBe('complete');
    expect(
      events.find((event) => event.transaction === 'process agent-delivery')?.contexts?.trace
        ?.trace_id,
    ).toBe(TRACE_A);
  });

  it('links an alarm to its producer while retaining a separate alarm execution trace', async () => {
    const exported = new Promise<void>((resolve) => writes(true, resolve));
    const delivery = await staged();
    await expect(process(delivery)).rejects.toThrow();
    events.length = 0;
    await runInDurableObject(delivery.host, async (_instance, state) => {
      const instance = new AgentDelivery(state, {
        ...env,
        SENTRY_DSN: 'https://public@example.test/1',
      });
      await instance.alarm();
    });
    await exported;
    const alarm = events.find((event) => event.transaction === 'alarm');
    expect(alarm?.contexts?.trace?.trace_id).toBeTruthy();
    expect(alarm?.contexts?.trace?.trace_id).not.toBe(TRACE_A);
    expect(alarm?.contexts?.trace?.links).toEqual(
      expect.arrayContaining([expect.objectContaining({ trace_id: TRACE_A, span_id: PARENT })]),
    );
  });

  it('preserves one safe capture on the original Error object before scope unwinds', async () => {
    const captured: Sentry.Event[] = [];
    const client = testClient(captured);
    const original = new Error('private-message', { cause: new Error('private-cause') });
    await Sentry.withScope(async (scope) => {
      scope.setClient(client);
      await Sentry.startSpan({ name: 'safe-process', forceTransaction: true }, async (span) => {
        captureSafeException(original, {
          message: 'Safe operation failure',
          operation: 'test.safe',
        });
        Sentry.captureException(original);
        await client.flush(1000);
        expect(captured).toHaveLength(1);
        expect(captured[0]?.contexts?.trace?.span_id).toBe(span.spanContext().spanId);
      });
    });
    expect(JSON.stringify(captured)).not.toMatch(/private-message|private-cause/);
    expect(original.message).toBe('private-message');
  });

  it('safely captures expiry failure on a linked alarm after a cold coordinator starts', async () => {
    const exported = new Promise<void>((resolve) => writes(true, resolve));
    const delivery = await staged();
    await expect(process(delivery)).rejects.toThrow();
    events.length = 0;
    await runInDurableObject(delivery.host, async (_instance, state) => {
      const receipt = await state.storage.get<{ reference: AgentDeliveryReference }>('receipt');
      await state.storage.put('receipt', {
        ...receipt,
        reference: { ...receipt!.reference, expires_at: Date.now() - 1 },
      });
    });
    await evictDurableObject(
      env.AGENT_DELIVERY_COORDINATOR.getByName(`org:${delivery.reference.org_id}`),
    );
    await runInDurableObject(delivery.host, async (_instance, state) => {
      const instance = new AgentDelivery(state, {
        ...env,
        SENTRY_DSN: 'https://public@example.test/1',
      });
      await expect(instance.alarm()).rejects.toThrow('active delivery has not expired');
    });
    await exported;
    const error = events.find(
      (event) => event.exception && event.tags?.operation === 'agent_delivery.alarm',
    );
    const alarm = events.find((event) => event.transaction === 'alarm');
    expect(error?.contexts?.trace?.trace_id).toBeTruthy();
    expect(error?.contexts?.trace?.trace_id).toBe(alarm?.contexts?.trace?.trace_id);
    expect(error?.contexts?.trace?.trace_id).not.toBe(TRACE_A);
    expect(alarm?.contexts?.trace?.links).toEqual(
      expect.arrayContaining([expect.objectContaining({ trace_id: TRACE_A, span_id: PARENT })]),
    );
    expect(events.filter((event) => event.exception)).toHaveLength(1);
    expect(JSON.stringify(error)).not.toContain('active delivery has not expired');
  });
});
