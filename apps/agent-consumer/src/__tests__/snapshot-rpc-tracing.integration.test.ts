import * as Sentry from '@sentry/cloudflare';
import { afterEach, expect, it, vi } from 'vitest';
import type * as SnapshotTinybird from '../snapshot-tinybird';
import {
  publishSnapshotManifest,
  snapshotJobStatus,
  startSnapshotCopy,
} from '../snapshot-tinybird';
import { processSnapshotQueue } from '../snapshot-queue';
import { makeSnapshotRunner } from './snapshot-runner-fixture';

vi.mock('../snapshot-tinybird', async (importOriginal) => ({
  ...(await importOriginal<typeof SnapshotTinybird>()),
  startSnapshotCopy: vi.fn(),
  snapshotJobStatus: vi.fn(),
  publishSnapshotManifest: vi.fn(),
}));

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it('exports coordinator RPCs beneath snapshot queue transactions and accounts for continuation messages', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-26T12:00:00Z'));
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.mocked(startSnapshotCopy).mockImplementation(
    async (_env, target) => `job-${target.replaceAll('_', '-')}`,
  );
  vi.mocked(snapshotJobStatus).mockResolvedValue('done');
  vi.mocked(publishSnapshotManifest).mockResolvedValue(undefined);
  const f = await makeSnapshotRunner();
  await f.coordinator.scheduleSnapshot({ orgId: f.orgId });
  const events: Sentry.Event[] = [];
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
  async function dispatch(failure = false) {
    const ack = vi.fn();
    const retry = vi.fn();
    await Sentry.withScope(async (scope) => {
      scope.setClient(client);
      await processSnapshotQueue(
        {
          queue: 'agent-snapshot-prod',
          messages: [
            {
              id: crypto.randomUUID(),
              timestamp: new Date(),
              attempts: failure ? 3 : 1,
              body: { type: 'agent-snapshot', org_id: f.orgId },
              ack,
              retry,
            },
          ],
          ackAll: vi.fn(),
          retryAll: vi.fn(),
          metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
        },
        f.env,
      );
    });
    if (failure) {
      expect(ack).not.toHaveBeenCalled();
      expect(retry).toHaveBeenCalledExactlyOnceWith({ delaySeconds: 60 });
    } else {
      expect(ack).toHaveBeenCalledOnce();
      expect(retry).not.toHaveBeenCalled();
    }
  }
  await dispatch(); // Initial debounce wake arrives before its due time.
  for (let invocation = 0; invocation < 10; invocation++) {
    const schedule = await f.coordinator.getSnapshotSchedule({});
    if (schedule.wakeAtMs === null) throw new Error('Expected scheduled continuation');
    vi.setSystemTime(schedule.wakeAtMs);
    await dispatch();
  }
  await dispatch(); // A duplicate can arrive before the last persisted wake time.
  vi.setSystemTime(Date.now() + 60_000);
  await dispatch(); // A later duplicate observes no remaining dirty days.
  await client.flush(1000);
  const transactions = events.filter(
    (event) => event.transaction === 'process agent-snapshot-prod',
  );
  expect(transactions).toHaveLength(13);
  expect(
    transactions.map((event) => event.contexts?.trace?.data?.['trace_flow.snapshot.result']),
  ).toEqual(['scheduled', ...Array(9).fill('continued'), 'complete', 'scheduled', 'idle']);
  for (const event of transactions) {
    const root = event.contexts!.trace!;
    const rpcSpans = event.spans!.filter((span) => span.op === 'rpc.client');
    expect(rpcSpans.length).toBeGreaterThan(0);
    expect(
      rpcSpans.every(
        (span) => span.trace_id === root.trace_id && span.parent_span_id === root.span_id,
      ),
    ).toBe(true);
    expect(rpcSpans.some((span) => span.description === 'AgentDeliveryCoordinator.getStats')).toBe(
      true,
    );
  }
  const spans = transactions.flatMap((event) => event.spans ?? []);
  expect(spans.filter((span) => span.description === 'SnapshotCapacity.acquire')).toHaveLength(10);
  expect(spans.filter((span) => span.description === 'SnapshotCapacity.release')).toHaveLength(1);
  expect(startSnapshotCopy).toHaveBeenCalledTimes(9);
  expect(snapshotJobStatus).toHaveBeenCalledTimes(9);
  expect(publishSnapshotManifest).toHaveBeenCalledOnce();
  expect(await f.coordinator.getStats({})).toMatchObject({ gatePhase: 'open', dirtyDays: 0 });
  f.env.AGENT_DELIVERY_COORDINATOR = {
    getByName: () => ({
      getStats: async () => {
        throw new Error('coordinator unavailable');
      },
    }),
  } as unknown as typeof f.env.AGENT_DELIVERY_COORDINATOR;
  await dispatch(true);
  await client.flush(1000);
  expect(events.at(-1)?.contexts?.trace?.data).toMatchObject({
    'trace_flow.snapshot.result': 'error',
    'messaging.message.retry.count': 2,
  });
  expect(JSON.stringify(events)).not.toMatch(/snapshot-token|read-token|tb-token/);
});
