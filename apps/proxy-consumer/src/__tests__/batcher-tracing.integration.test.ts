import * as Sentry from '@sentry/cloudflare';
import { env, evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import type { TraceBatcherInstance } from '../batcher';
import { createMockTrace } from './fixtures';

vi.mock('../tinybird', () => ({
  insertIntoTinybirdWithRetry: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@sentry/cloudflare', async (importOriginal) => ({
  ...(await importOriginal<typeof Sentry>()),
  instrumentDurableObjectWithSentry: <T>(_options: unknown, constructor: T): T => constructor,
}));

function recorder(events: Sentry.Event[]) {
  const client = new Sentry.CloudflareClient({
    dsn: 'https://public@example.test/1',
    integrations: [],
    stackParser: () => [],
    tracesSampleRate: 1,
    transport: () => ({
      send: async (envelope) => {
        for (const [header, payload] of envelope[1])
          if (header.type === 'transaction') events.push(payload as Sentry.Event);
        return { statusCode: 200 };
      },
      flush: async () => true,
    }),
  });
  client.init();
  return client;
}

function host() {
  const namespace = env.TRACE_BATCHER;
  return namespace.get(namespace.newUniqueId());
}

async function flush(batcher: ReturnType<typeof host>, events: Sentry.Event[]) {
  await runInDurableObject(batcher, async (instance: TraceBatcherInstance, state) => {
    const client = recorder(events);
    await Sentry.withScope(async (scope) => {
      scope.setClient(client);
      await Sentry.startSpan({ name: 'test alarm', forceTransaction: true }, () =>
        instance.forceFlush(),
      );
    });
    await client.flush(1000);
    await state.storage.deleteAlarm();
  });
}

describe('durable batch producer links', () => {
  it('retains bounded links after eviction and clears them with the selected rows', async () => {
    const batcher = host();
    const traceIds = Array.from({ length: 35 }, (_, i) => (i + 1).toString(16).padStart(32, '0'));
    const items = traceIds.map((id, i) => ({
      messageId: `message-${i}`,
      traces: [createMockTrace(id)],
    }));
    const sentryTraceHeaders = Object.fromEntries(
      items.map((item, i) => [item.messageId, `${traceIds[i]}-1111111111111111-1`]),
    );
    await runInDurableObject(batcher, async (instance: TraceBatcherInstance, state) => {
      await instance.addMessageTraces(items, { sentryTraceHeaders });
      await instance.addMessageTraces(items, { sentryTraceHeaders });
      expect(state.storage.sql.exec('SELECT * FROM traces').toArray()).toHaveLength(35);
      await state.storage.deleteAlarm();
    });
    await evictDurableObject(batcher);
    const events: Sentry.Event[] = [];
    await flush(batcher, events);
    const span = events
      .flatMap((event) => event.spans ?? [])
      .find((span) => span.op === 'queue.flush');
    expect(span?.links).toHaveLength(32);
    expect(span?.links?.map((link) => link.trace_id)).toEqual(traceIds.slice(0, 32));
    expect(span?.data).toMatchObject({ 'trace_flow.producer_links_omitted': 3 });
    expect(span?.trace_id).not.toBe(traceIds[0]);
    await runInDurableObject(batcher, async (instance: TraceBatcherInstance, state) => {
      expect(state.storage.sql.exec('SELECT * FROM traces').toArray()).toHaveLength(0);
      await instance.addMessageTraces([
        { messageId: 'legacy', traces: [createMockTrace('legacy')] },
      ]);
      await state.storage.deleteAlarm();
    });
    events.length = 0;
    await flush(batcher, events);
    const later = events
      .flatMap((event) => event.spans ?? [])
      .find((span) => span.op === 'queue.flush');
    expect(later?.links ?? []).toHaveLength(0);
  });

  it('rejects invalid or unrelated tracing metadata before storing business rows', async () => {
    const batcher = host();
    await runInDurableObject(batcher, async (instance: TraceBatcherInstance, state) => {
      const items = [{ messageId: 'message', traces: [createMockTrace('trace')] }];
      await expect(
        instance.addMessageTraces(items, { sentryTraceHeaders: { message: 'invalid' } }),
      ).rejects.toThrow('Invalid trace batch producer context');
      await expect(
        instance.addMessageTraces(items, {
          sentryTraceHeaders: { other: '11111111111111111111111111111111-2222222222222222-1' },
        }),
      ).rejects.toThrow('Invalid trace batch producer context');
      expect(state.storage.sql.exec('SELECT * FROM traces').toArray()).toHaveLength(0);
      expect(state.storage.sql.exec('SELECT * FROM processed_messages').toArray()).toHaveLength(0);
    });
  });
});
