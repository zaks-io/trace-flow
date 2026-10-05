import * as Sentry from '@sentry/cloudflare';
import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentDeliveryReference } from '@trace-flow/types';
import type { AgentConsumerEnv } from '../context';
import { processDeliveryReferences } from '../delivery-queue';

const TRACE = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const PARENT = 'bbbbbbbbbbbbbbbb';
const events: Sentry.Event[] = [];

function reference(): AgentDeliveryReference {
  const orgId = `queue-${crypto.randomUUID()}`;
  return {
    type: 'agent-delivery',
    version: 1,
    key: `agent-deliveries/${orgId}/${crypto.randomUUID()}`,
    org_id: orgId,
    sha256: 'a'.repeat(64),
    created_at: Date.now(),
    expires_at: Date.now() + 60_000,
    delivery_revision: 1,
  };
}

function message(body: unknown): Message<unknown> {
  return {
    id: crypto.randomUUID(),
    body,
    timestamp: new Date(),
    attempts: 1,
    ack: vi.fn(),
    retry: vi.fn(),
  };
}

async function inCaller(callback: () => Promise<void>) {
  const client = new Sentry.CloudflareClient({
    dsn: 'https://public@example.test/1',
    integrations: [],
    stackParser: () => [],
    tracesSampleRate: 1,
    transport: () => ({
      send: async (envelope) => {
        for (const [header, payload] of envelope[1])
          if (header.type === 'event') events.push(payload as Sentry.Event);
        return { statusCode: 200 };
      },
      flush: async () => true,
    }),
  });
  client.init();
  await Sentry.withScope(async (scope) => {
    scope.setClient(client);
    await Sentry.continueTrace({ sentryTrace: `${TRACE}-${PARENT}-1`, baggage: undefined }, () =>
      Sentry.startSpan({ name: 'delivery queue caller', forceTransaction: true }, callback),
    );
  });
  await client.flush(1000);
}

afterEach(() => {
  events.length = 0;
  vi.restoreAllMocks();
});

describe('delivery queue error correlation', () => {
  it('captures reconstructed workerd remote errors even when a cold receiver has no telemetry', async () => {
    const body = reference();
    let thrown: unknown;
    const observedEnv = {
      ...env,
      AGENT_DELIVERY: {
        getByName: (key: string) => ({
          async process(input: AgentDeliveryReference) {
            try {
              return await env.AGENT_DELIVERY.getByName(key).process(input);
            } catch (error) {
              thrown = error;
              throw error;
            }
          },
        }),
      },
    } as unknown as AgentConsumerEnv;
    const queued = message(body);
    await inCaller(() => processDeliveryReferences([queued], observedEnv));
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).toMatchObject({ remote: true });
    expect(queued.retry).toHaveBeenCalledExactlyOnceWith({ delaySeconds: 60 });
    expect(queued.ack).not.toHaveBeenCalled();
    expect(events).toHaveLength(1);
    expect(events[0]?.tags?.operation).toBe('agent_delivery.dispatch');
    expect(events[0]?.contexts?.trace?.trace_id).toBe(TRACE);
  });

  it('captures local reference validation failures under the queue caller identity', async () => {
    const queued = message({ type: 'agent-delivery', version: 1 });
    await inCaller(() => processDeliveryReferences([queued], env));
    expect(queued.retry).toHaveBeenCalledOnce();
    expect(queued.ack).not.toHaveBeenCalled();
    expect(events).toHaveLength(1);
    expect(events[0]?.tags?.operation).toBe('agent_delivery.dispatch');
    expect(events[0]?.contexts?.trace?.trace_id).toBe(TRACE);
  });

  it('captures local binding failures while stripping sensitive messages', async () => {
    const queued = message(reference());
    const localEnv = {
      ...env,
      AGENT_DELIVERY: {
        getByName: () => {
          throw new Error('private platform message');
        },
      },
    } as unknown as AgentConsumerEnv;
    await inCaller(() => processDeliveryReferences([queued], localEnv));
    expect(events).toHaveLength(1);
    expect(events[0]?.contexts?.trace?.trace_id).toBe(TRACE);
    expect(JSON.stringify(events)).not.toContain('private platform message');
    expect(queued.retry).toHaveBeenCalledOnce();
  });
});
