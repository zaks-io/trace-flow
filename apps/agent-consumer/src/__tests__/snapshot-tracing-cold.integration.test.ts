import * as Sentry from '@sentry/cloudflare';
import { env as workerEnv } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentConsumerEnv } from '../context';
import type * as SnapshotTinybird from '../snapshot-tinybird';
import { startSnapshotCopy } from '../snapshot-tinybird';
import { processSnapshotQueue } from '../snapshot-queue';

vi.mock('../snapshot-tinybird', async (importOriginal) => ({
  ...(await importOriginal<typeof SnapshotTinybird>()),
  startSnapshotCopy: vi.fn(),
}));

afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
});

describe('cold snapshot Durable Objects', () => {
  it('keeps overlapping requests isolated when one constructs an unrelated cold DO', async () => {
    const env = workerEnv as unknown as AgentConsumerEnv;
    const coldCoordinator = env.AGENT_DELIVERY_COORDINATOR.getByName(`org:${crypto.randomUUID()}`);
    const traceIds = ['1'.repeat(32), '2'.repeat(32)];
    let arrivals = 0;
    let releaseRequests!: () => void;
    let releaseColdConstructor!: () => void;
    const requestsReady = new Promise<void>((resolve) => {
      releaseRequests = resolve;
    });
    const constructorFinished = new Promise<void>((resolve) => {
      releaseColdConstructor = resolve;
    });
    const events: Sentry.Event[] = [];
    const worker = Sentry.withSentry(
      () => ({
        dsn: 'https://public@example.test/1',
        tracesSampleRate: 1,
        skipOpenTelemetrySetup: true,
        transport: () => ({
          send: async (envelope) => {
            for (const [header, payload] of envelope[1]) {
              if (header.type === 'event') events.push(payload as Sentry.Event);
            }
            return { statusCode: 200 };
          },
          flush: async () => true,
        }),
      }),
      {
        async fetch(request: Request, _env: object, _ctx: ExecutionContext) {
          const original = Sentry.getActiveSpan()!.spanContext();
          arrivals += 1;
          if (arrivals === 2) releaseRequests();
          await requestsReady;
          if (new URL(request.url).pathname === '/cold') {
            await coldCoordinator.getStats({});
            releaseColdConstructor();
          } else await constructorFinished;
          const current = Sentry.getActiveSpan()!.spanContext();
          Sentry.captureException(new Error('concurrent request failed'));
          return Response.json({ original, current });
        },
      },
    );
    const responses = await Promise.all(
      traceIds.map(async (traceId, index) => {
        const ctx = createExecutionContext();
        const response = await worker.fetch(
          new Request(`https://snapshot.test/${index === 0 ? 'cold' : 'overlap'}`, {
            headers: { 'sentry-trace': `${traceId}-${'3'.repeat(16)}-1` },
          }),
          {},
          ctx,
        );
        const contexts = await response.json<{
          original: { traceId: string; spanId: string };
          current: { traceId: string; spanId: string };
        }>();
        await waitOnExecutionContext(ctx);
        return contexts;
      }),
    );
    for (const [index, contexts] of responses.entries()) {
      expect(contexts.current).toEqual(contexts.original);
      expect(contexts.current.traceId).toBe(traceIds[index]);
      expect(
        events.find((event) => event.contexts?.trace?.trace_id === traceIds[index])?.contexts?.trace
          ?.span_id,
      ).toBe(contexts.current.spanId);
    }
    expect(events).toHaveLength(2);
  });

  it.each(['copy', 'coordinator'])(
    'retains dispatcher trace through cold DO %s failures',
    async (failureStage) => {
      vi.useFakeTimers({ toFake: ['Date'] });
      const now = Date.now();
      vi.setSystemTime(now);
      const env = workerEnv as unknown as AgentConsumerEnv;
      const orgId = `cold-snapshot-${crypto.randomUUID()}`;
      const realCoordinator = env.AGENT_DELIVERY_COORDINATOR.getByName(`org:${orgId}`);
      const realCapacity = env.AGENT_SNAPSHOT_CAPACITY.getByName(crypto.randomUUID());
      let seeded = false;
      const coordinator = {
        async getStats(input: Record<string, never>) {
          await realCoordinator.getStats(input);
          if (failureStage === 'coordinator') throw new Error('private coordinator response');
          if (!seeded) {
            seeded = true;
            const delivery = { deliveryId: 'cold-delivery', payloadSha256: 'a'.repeat(64) };
            await realCoordinator.reserve({
              ...delivery,
              dirtyDays: [new Date(now).toISOString().slice(0, 10)],
              createdAtMs: now,
              expiresAtMs: now + 60 * 60_000,
            });
            await realCoordinator.complete(delivery);
            vi.setSystemTime(now + 60_000);
          }
          return realCoordinator.getStats(input);
        },
        getSnapshotSchedule: (...args: Parameters<typeof realCoordinator.getSnapshotSchedule>) =>
          realCoordinator.getSnapshotSchedule(...args),
        releaseSnapshotClaim: (...args: Parameters<typeof realCoordinator.releaseSnapshotClaim>) =>
          realCoordinator.releaseSnapshotClaim(...args),
        requestSnapshot: (...args: Parameters<typeof realCoordinator.requestSnapshot>) =>
          realCoordinator.requestSnapshot(...args),
        beginSnapshot: (...args: Parameters<typeof realCoordinator.beginSnapshot>) =>
          realCoordinator.beginSnapshot(...args),
        getSnapshotProgress: (...args: Parameters<typeof realCoordinator.getSnapshotProgress>) =>
          realCoordinator.getSnapshotProgress(...args),
        scheduleSnapshotContinuation: (
          ...args: Parameters<typeof realCoordinator.scheduleSnapshotContinuation>
        ) => realCoordinator.scheduleSnapshotContinuation(...args),
        getOutstandingSnapshotCopyIntents: (
          ...args: Parameters<typeof realCoordinator.getOutstandingSnapshotCopyIntents>
        ) => realCoordinator.getOutstandingSnapshotCopyIntents(...args),
        assertSnapshotActive: (...args: Parameters<typeof realCoordinator.assertSnapshotActive>) =>
          realCoordinator.assertSnapshotActive(...args),
        recordSnapshotCopyIntent: (
          ...args: Parameters<typeof realCoordinator.recordSnapshotCopyIntent>
        ) => realCoordinator.recordSnapshotCopyIntent(...args),
        rejectSnapshotCopyIntent: (
          ...args: Parameters<typeof realCoordinator.rejectSnapshotCopyIntent>
        ) => realCoordinator.rejectSnapshotCopyIntent(...args),
        failSnapshot: (...args: Parameters<typeof realCoordinator.failSnapshot>) =>
          realCoordinator.failSnapshot(...args),
      };
      const queueEnv = {
        ...env,
        AGENT_DELIVERY_COORDINATOR: { getByName: () => coordinator },
        AGENT_SNAPSHOT_CAPACITY: { getByName: () => realCapacity },
      } as unknown as AgentConsumerEnv;
      const traceId = '1'.repeat(32);
      let copyTraceId: string | undefined;
      vi.mocked(startSnapshotCopy).mockImplementation(async () => {
        copyTraceId = Sentry.getActiveSpan()?.spanContext().traceId;
        throw new Error('private upstream response');
      });
      const events: Sentry.Event[] = [];
      const retry = vi.fn();
      const ack = vi.fn();
      const worker = Sentry.withSentry(
        () => ({
          dsn: 'https://public@example.test/1',
          tracesSampleRate: 1,
          skipOpenTelemetrySetup: true,
          transport: () => ({
            send: async (envelope) => {
              for (const [header, payload] of envelope[1]) {
                if (header.type === 'event' || header.type === 'transaction')
                  events.push(payload as Sentry.Event);
              }
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
                messages: [
                  {
                    id: 'snapshot',
                    timestamp: new Date(),
                    attempts: 1,
                    body: {
                      type: 'agent-snapshot',
                      org_id: orgId,
                      sentry_trace_context: { 'sentry-trace': `${traceId}-${'2'.repeat(16)}-1` },
                    },
                    ack,
                    retry,
                  },
                ],
                metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
                ackAll: vi.fn(),
                retryAll: vi.fn(),
              },
              queueEnv,
            );
            return new Response('ok');
          },
        },
      );
      const ctx = createExecutionContext();
      await (await worker.fetch(new Request('https://snapshot.test'), {}, ctx)).text();
      await waitOnExecutionContext(ctx);
      if (failureStage === 'copy') {
        expect(startSnapshotCopy).toHaveBeenCalledOnce();
        expect(copyTraceId).toBe(traceId);
        expect(ack).toHaveBeenCalledOnce();
        expect(retry).not.toHaveBeenCalled();
      } else {
        expect(startSnapshotCopy).not.toHaveBeenCalled();
        expect(ack).not.toHaveBeenCalled();
        expect(retry).toHaveBeenCalledExactlyOnceWith({ delaySeconds: 60 });
      }
      const errors = events.filter((event) => event.exception);
      expect(errors).toHaveLength(1);
      expect(errors[0]?.contexts?.trace?.trace_id).toBe(traceId);
      expect(JSON.stringify(errors)).not.toContain('private upstream response');
      expect(JSON.stringify(errors)).not.toContain('private coordinator response');
    },
  );
});
