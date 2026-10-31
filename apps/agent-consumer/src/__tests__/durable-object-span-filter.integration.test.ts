import type * as Sentry from '@sentry/cloudflare';
import { env, runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentDeliveryCoordinator } from '../agent-delivery-coordinator';

const SENTRY_DSN = 'https://public@example.test/1';
// Instrumented Durable Objects trace an RPC method only when the caller appends this metadata.
const RPC_METADATA = {
  __sentry_rpc_meta__: {
    'sentry-trace': '11111111111111111111111111111111-2222222222222222-1',
  },
};

function captureSentryTransactions(): { events: Sentry.Event[]; exported: Promise<void> } {
  const events: Sentry.Event[] = [];
  let resolve!: () => void;
  const exported = new Promise<void>((done) => (resolve = done));
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    if (new URL(String(input)).hostname !== 'example.test')
      throw new Error(`unexpected fetch ${String(input)}`);
    const lines = String(init?.body).split('\n');
    for (let i = 1; i < lines.length - 1; i += 2) {
      if (JSON.parse(lines[i]!).type === 'transaction') events.push(JSON.parse(lines[i + 1]!));
    }
    resolve();
    return new Response('{}');
  });
  return { events, exported };
}

afterEach(() => vi.restoreAllMocks());

describe('Durable Object Sentry span filter', () => {
  it('exports the coordinator RPC transaction without its per-statement SQL spans', async () => {
    const { events, exported } = captureSentryTransactions();
    const coordinator = env.AGENT_DELIVERY_COORDINATOR.getByName(
      `org:span-filter-${crypto.randomUUID()}`,
    );
    await runInDurableObject(coordinator, async (_instance, state) => {
      const instance = new AgentDeliveryCoordinator(state, { ...env, SENTRY_DSN });
      const stats = Reflect.apply(instance.getStats, instance, [{}, RPC_METADATA]);
      expect(stats.activeDeliveries).toBe(0);
    });
    await exported;

    const transaction = events.find((event) => event.transaction === 'getStats');
    expect(transaction).toBeDefined();
    expect(transaction?.spans?.filter((span) => span.op === 'db.query')).toEqual([]);
  });
});
