import { captureException } from '@sentry/cloudflare';
import { env } from 'cloudflare:test';
import type * as SentryCloudflare from '@sentry/cloudflare';
import { describe, expect, it, vi } from 'vitest';
import type { AgentConsumerEnv } from '../context';
import worker from '../index';
import { queueMessage } from './factories';

vi.mock('@sentry/cloudflare', async (importOriginal) => ({
  ...(await importOriginal<typeof SentryCloudflare>()),
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  withSentry: <T>(_options: unknown, handler: T): T => handler,
}));

describe('agent consumer DLQ', () => {
  it('preserves the complete message before acknowledgement and dedupes redelivery', async () => {
    let acknowledgements = 0;
    const message = {
      id: 'dead-letter-1',
      timestamp: new Date(),
      body: { malformed: true, nested: { complete: 'payload' } },
      attempts: 6,
      ack: () => acknowledgements++,
      retry: () => undefined,
    };
    const batch = {
      queue: 'agent-ingest-dlq-dev',
      messages: [message],
      metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
      retryAll: () => undefined,
      ackAll: () => undefined,
    } as unknown as MessageBatch<unknown>;

    await worker.queue(batch, env);
    await worker.queue(batch, env);

    expect(acknowledgements).toBe(2);
    const recovery = await env.AGENT_FACT_BATCHER.getByName('org:__dlq__').listRecovery();
    expect(recovery.records).toHaveLength(1);
    expect(recovery.records[0]).toMatchObject({
      kind: 'dlq',
      state: 'blocked',
      classification: 'dead_letter',
    });
    expect(JSON.parse(recovery.records[0]?.payload ?? '{}')).toMatchObject({ body: message.body });
  });

  it('preserves valid messages in the shared recovery sink when the organization sink is full', async () => {
    const messageId = `dead-letter-${crypto.randomUUID()}`;
    const body = queueMessage();
    const sharedSink = env.AGENT_FACT_BATCHER.getByName('org:__dlq__');
    let durablyPreserved = false;
    const preserveDlq = vi.fn(async (payload: string, outcome: string, dedupeKey: string) => {
      const record = await sharedSink.preserveDlq(payload, outcome, dedupeKey);
      durablyPreserved = true;
      return record;
    });
    const getByName = vi.fn((name: string) => {
      if (name !== 'org:__dlq__') {
        throw new Error('Exceeded the maximum database size.');
      }
      return { preserveDlq };
    });
    const ack = vi.fn(() => expect(durablyPreserved).toBe(true));
    const message = {
      id: messageId,
      timestamp: new Date(),
      body,
      attempts: 6,
      ack,
      retry: vi.fn(),
    };
    const batch = {
      queue: 'agent-ingest-dlq-dev',
      messages: [message],
      metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
      retryAll: vi.fn(),
      ackAll: vi.fn(),
    } as unknown as MessageBatch<unknown>;
    const isolatedEnv = {
      ...env,
      AGENT_FACT_BATCHER: { getByName },
    } as unknown as AgentConsumerEnv;

    await worker.queue(batch, isolatedEnv);
    durablyPreserved = false;
    await worker.queue(batch, isolatedEnv);

    expect(getByName).toHaveBeenCalledTimes(2);
    expect(getByName).toHaveBeenNthCalledWith(1, 'org:__dlq__');
    expect(getByName).toHaveBeenNthCalledWith(2, 'org:__dlq__');
    expect(preserveDlq).toHaveBeenCalledTimes(2);
    expect(ack).toHaveBeenCalledTimes(2);
    expect(message.retry).not.toHaveBeenCalled();
    const recovery = await sharedSink.listRecovery();
    const records = recovery.records.filter((record) => record.payload.includes(messageId));
    expect(records).toHaveLength(1);
    expect(records[0]?.payload).toBe(JSON.stringify({ queue: batch.queue, messageId, body }));
  });
});

describe('DLQ preservation failure', () => {
  it.each([
    { attempts: 1, delaySeconds: 60 },
    { attempts: 2, delaySeconds: 120 },
    { attempts: 8, delaySeconds: 7_680 },
    { attempts: 9, delaySeconds: 14_400 },
    { attempts: 100, delaySeconds: 14_400 },
  ])(
    'backs off delivery attempt $attempts and reports the original error',
    async ({ attempts, delaySeconds }) => {
      vi.clearAllMocks();
      const ack = vi.fn();
      const retry = vi.fn();
      const message = {
        id: 'preservation-failure',
        timestamp: new Date(),
        body: { malformed: true },
        attempts,
        ack,
        retry,
      };
      const batch = {
        queue: 'agent-ingest-dlq-dev',
        messages: [message],
        metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
        retryAll: vi.fn(),
        ackAll: vi.fn(),
      } as unknown as MessageBatch<unknown>;
      const preservationError = new Error('durable storage unavailable');
      const unavailable = () => {
        throw preservationError;
      };
      const failingEnv = {
        ...env,
        AGENT_FACT_BATCHER: { getByName: unavailable, idFromName: unavailable, get: unavailable },
      } as unknown as typeof env;
      await worker.queue(batch, failingEnv);
      expect(ack).not.toHaveBeenCalled();
      expect(retry).toHaveBeenCalledOnce();
      expect(retry).toHaveBeenCalledWith({ delaySeconds });
      expect(captureException).toHaveBeenCalledOnce();
      expect(captureException).toHaveBeenCalledWith(preservationError, {
        level: 'fatal',
        tags: { operation: 'dlq_preserve' },
        extra: {
          queue: 'agent-ingest-dlq-dev',
          messageId: 'preservation-failure',
          attempts,
        },
      });
    },
  );
});
