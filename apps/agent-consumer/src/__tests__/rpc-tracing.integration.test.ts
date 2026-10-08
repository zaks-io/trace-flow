import * as Sentry from '@sentry/cloudflare';
import { createExecutionContext, env as runtimeEnv, waitOnExecutionContext } from 'cloudflare:test';
import { WorkerEntrypoint } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TRACE_FLOW_PROPAGATION_TARGETS } from '@trace-flow/utils/sentry-tracing';
import { AgentIngestion, TraceRecovery } from '../index';
import { AGENT_DEAD_LETTERS_INSTANCE_NAME } from '../dead-letters';
import type { AgentConsumerEnv } from '../context';

const TRACE_ID = '11111111111111111111111111111111';
const PARENT_ID = '2222222222222222';
const metadata = { __sentry_rpc_meta__: { 'sentry-trace': `${TRACE_ID}-${PARENT_ID}-1` } };

function options(events: Sentry.Event[]): Sentry.CloudflareOptions {
  return {
    dsn: 'https://public@example.test/1',
    tracesSampleRate: 1,
    skipOpenTelemetrySetup: true,
    enableRpcTracePropagation: true,
    tracePropagationTargets: TRACE_FLOW_PROPAGATION_TARGETS,
    rpcTracePropagationBindings: ['RECEIVER'],
    transport: () => ({
      send: async (envelope) => {
        for (const [header, event] of envelope[1]) {
          if (header.type === 'event' || header.type === 'transaction')
            events.push(event as Sentry.Event);
        }
        return { statusCode: 200 };
      },
      flush: async () => true,
    }),
  };
}

class Receiver extends WorkerEntrypoint<AgentConsumerEnv> {
  inspect(...args: unknown[]) {
    const span = Sentry.getActiveSpan();
    return { args, context: span?.spanContext() };
  }
  fail() {
    throw new Error('rpc failure');
  }
}

describe('named RPC instrumentation in workerd', () => {
  afterEach(() => vi.restoreAllMocks());
  it('strips trailing metadata and preserves caller trace and parent for spans and errors', async () => {
    const events: Sentry.Event[] = [];
    const TracedReceiver = Sentry.withSentry(() => options(events), Receiver);
    const ctx = createExecutionContext();
    const receiver = new TracedReceiver(ctx, runtimeEnv);
    const result = Reflect.apply(receiver.inspect, receiver, ['org', undefined, metadata]);
    expect(result.args).toEqual(['org', undefined]);
    expect(result.context?.traceId).toBe(TRACE_ID);
    expect(() => Reflect.apply(receiver.fail, receiver, [metadata])).toThrow('rpc failure');
    await waitOnExecutionContext(ctx);
    const transaction = events.find((event) => event.transaction === 'inspect');
    expect(transaction?.contexts?.trace).toMatchObject({
      trace_id: TRACE_ID,
      parent_span_id: PARENT_ID,
      span_id: result.context?.spanId,
    });
    const error = events.find((event) => event.exception);
    expect(error?.contexts?.trace).toMatchObject({ trace_id: TRACE_ID, parent_span_id: PARENT_ID });
    expect(events.find((event) => event.transaction === 'fail')?.contexts?.trace?.span_id).toBe(
      error?.contexts?.trace?.span_id,
    );
  });

  it('keeps all legacy business arguments when callers supply no metadata', async () => {
    const events: Sentry.Event[] = [];
    const TracedReceiver = Sentry.withSentry(() => options(events), Receiver);
    const ctx = createExecutionContext();
    const receiver = new TracedReceiver(ctx, runtimeEnv);
    const result = receiver.inspect('org', { afterId: 17 });
    expect(result.args).toEqual(['org', { afterId: 17 }]);
    await waitOnExecutionContext(ctx);
  });

  it('instruments the production AgentIngestion and TraceRecovery exports before DO handoff', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));
    const seen: { args: unknown[]; traceId: string }[] = [];
    const record = (...args: unknown[]) => {
      seen.push({ args, traceId: Sentry.getActiveSpan()!.spanContext().traceId });
      return { gatePhase: 'open', erasureStarted: false, activeDeliveries: 0 };
    };
    const coordinator = {
      getStats: record,
      getOutstandingSnapshotCopyIntents: (...args: unknown[]) => {
        record(...args);
        return [];
      },
      getSnapshotSchedule: record,
    };
    const env = {
      SENTRY_DSN: 'https://public@example.test/1',
      AGENT_DELIVERY_COORDINATOR: {
        idFromName: (name: string) => name,
        getByName: () => coordinator,
      },
    } as unknown as AgentConsumerEnv;
    const ctx = createExecutionContext();
    const admission = new AgentIngestion(ctx, env);
    expect(await Reflect.apply(admission.canAcceptDeliveries, admission, ['org', metadata])).toBe(
      true,
    );
    const recovery = new TraceRecovery(ctx, env);
    await Reflect.apply(recovery.inspectDeliveryStatus, recovery, ['org', {}, metadata]);
    expect(seen).toHaveLength(4);
    expect(seen.every((entry) => entry.traceId === TRACE_ID)).toBe(true);
    for (const entry of seen) {
      expect(entry.args.at(-1)).toMatchObject({
        __sentry_rpc_meta__: { 'sentry-trace': expect.stringMatching(new RegExp(`^${TRACE_ID}-`)) },
      });
    }
    expect(seen[1]?.args[0]).toEqual({});
    await waitOnExecutionContext(ctx);
  });

  it('passes traced recovery calls to the real shared dead-letter DO', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));
    const ctx = createExecutionContext();
    const service = new TraceRecovery(ctx, {
      ...runtimeEnv,
      SENTRY_DSN: 'https://public@example.test/1',
    });
    const store = runtimeEnv.AGENT_DEAD_LETTERS.getByName(AGENT_DEAD_LETTERS_INSTANCE_NAME);
    const record = await store.preserveDlq('{"complete":true}', '{}', crypto.randomUUID());
    const page = await Reflect.apply(service.listRecovery, service, [
      AGENT_DEAD_LETTERS_INSTANCE_NAME,
      { afterId: record.id - 1 },
      metadata,
    ]);
    expect(page.records).toEqual([record]);
    const resolved = await Reflect.apply(service.reconcileRecovery, service, [
      AGENT_DEAD_LETTERS_INSTANCE_NAME,
      { recoveryId: record.id, action: 'retire-dead-letter', reason: 'operator decision' },
      metadata,
    ]);
    expect(resolved).toMatchObject({ state: 'resolved', payload: record.payload });
    await waitOnExecutionContext(ctx);
  });

  it('calls a real coordinator DO with traced and legacy named entrypoint callers', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));
    const ctx = createExecutionContext();
    const service = new AgentIngestion(ctx, {
      ...runtimeEnv,
      SENTRY_DSN: 'https://public@example.test/1',
    });
    expect(
      await Reflect.apply(service.canAcceptDeliveries, service, [
        `rpc-${crypto.randomUUID()}`,
        metadata,
      ]),
    ).toBe(true);
    expect(await service.canAcceptDeliveries(`legacy-${crypto.randomUUID()}`)).toBe(true);
    await waitOnExecutionContext(ctx);
  });
});
