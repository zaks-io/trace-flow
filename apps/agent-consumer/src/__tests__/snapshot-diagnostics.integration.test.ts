import * as Sentry from '@sentry/cloudflare';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import { makeSnapshotRunner } from './snapshot-runner-fixture';
import { processSnapshotQueue } from '../snapshot-queue';

afterEach(() => vi.unstubAllGlobals());

it('exports one diagnostic event through the real snapshot runner and queue failure flow', async () => {
  const f = await makeSnapshotRunner();
  const provider = vi
    .fn()
    .mockResolvedValue(new Response('private provider response', { status: 400 }));
  vi.stubGlobal('fetch', provider);
  const events: Sentry.Event[] = [];
  const message = {
    id: crypto.randomUUID(),
    timestamp: new Date(),
    attempts: 1,
    body: {
      type: 'agent-snapshot',
      org_id: f.orgId,
      sentry_trace_context: { 'sentry-trace': `${'1'.repeat(32)}-${'2'.repeat(16)}-1` },
    },
    ack: vi.fn(),
    retry: vi.fn(),
  };
  const worker = Sentry.withSentry(
    () => ({
      dsn: 'https://public@example.test/1',
      tracesSampleRate: 1,
      skipOpenTelemetrySetup: true,
      transport: () => ({
        send: async (envelope) => {
          for (const [header, payload] of envelope[1])
            if (header.type === 'event') events.push(payload as Sentry.Event);
          return { statusCode: 200 };
        },
        flush: async () => true,
      }),
    }),
    {
      async fetch(_request: Request, _env: object, _ctx: ExecutionContext) {
        await processSnapshotQueue(
          {
            queue: 'agent-snapshot-dev',
            messages: [message],
            metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
            ackAll: vi.fn(),
            retryAll: vi.fn(),
          },
          f.env,
        );
        return new Response('ok');
      },
    },
  );
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request('https://snapshot.test'), {}, ctx);
  expect(await response.text()).toBe('ok');
  await waitOnExecutionContext(ctx);
  expect(events).toHaveLength(1);
  expect(events[0]?.exception?.values).toMatchObject([
    { type: 'SnapshotCopyStartRejectedError', value: 'Snapshot Copy start rejected' },
  ]);
  expect(events[0]?.extra).toMatchObject({
    stage: 'start-copy',
    orgId: f.orgId,
    generation: 1,
    copyIndex: 0,
    copyAttempt: 1,
    httpStatus: 400,
  });
  expect(events[0]?.contexts?.trace?.trace_id).toBe('1'.repeat(32));
  expect(JSON.stringify(events)).not.toContain('private');
  expect(message.retry).toHaveBeenCalledExactlyOnceWith({ delaySeconds: 60 });
  expect(message.ack).not.toHaveBeenCalled();
  expect(provider).toHaveBeenCalledOnce();
  expect(await f.coordinator.getSnapshotSchedule({})).toMatchObject({ failure: { generation: 1 } });
  expect(await f.coordinator.getOutstandingSnapshotCopyIntents({})).toEqual([]);
});
