import { captureException, captureMessage } from '@sentry/cloudflare';
import { env as workerEnv } from 'cloudflare:test';
import type * as SentryCloudflare from '@sentry/cloudflare';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentConsumerEnv } from '../context';
import worker from '../index';
import { AGENT_DEAD_LETTERS_INSTANCE_NAME } from '../dead-letters';
import { queueMessage } from './factories';

const env = workerEnv as unknown as AgentConsumerEnv;

vi.mock('@sentry/cloudflare', async (importOriginal) => ({
  ...(await importOriginal<typeof SentryCloudflare>()),
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  withSentry: <T>(_options: unknown, handler: T): T => handler,
}));

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe('agent consumer delivery contract', () => {
  it.each([
    { description: 'retries an inline message and logs the contract error', mixed: false },
    { description: 'dispatches a reference while retrying an inline message', mixed: true },
  ])('$description', async ({ mixed }) => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const inline = {
      id: 'off-contract-message',
      timestamp: new Date(),
      body: queueMessage(),
      attempts: 1,
      ack: vi.fn(),
      retry: vi.fn(),
    };
    const createdAt = Date.now();
    const reference = {
      type: 'agent-delivery',
      version: 1,
      key: `agent-deliveries/org-1/${crypto.randomUUID()}`,
      org_id: 'org-1',
      sha256: 'a'.repeat(64),
      created_at: createdAt,
      expires_at: createdAt + 60_000,
      delivery_revision: 2,
    };
    const delivery = {
      ...inline,
      id: 'delivery-reference',
      body: reference,
      ack: vi.fn(),
      retry: vi.fn(),
    };
    const process = vi.fn(async () => 'complete');
    const getByName = vi.fn(() => ({ process }));
    const batch = {
      queue: 'agent-ingest-dev',
      messages: mixed ? [delivery, inline] : [inline],
      retryAll: vi.fn(),
      ackAll: vi.fn(),
    } as unknown as MessageBatch<unknown>;
    await worker.queue(batch, {
      ...env,
      AGENT_DELIVERY: { getByName },
    } as unknown as AgentConsumerEnv);

    expect(inline.retry).toHaveBeenCalledExactlyOnceWith();
    expect(inline.ack).not.toHaveBeenCalled();
    expect(captureMessage).toHaveBeenCalledExactlyOnceWith('agent_consumer.message_off_contract', {
      level: 'error',
      tags: { operation: 'guard' },
      extra: { messageId: inline.id, queue: batch.queue },
    });
    expect(logged).toHaveBeenCalledOnce();
    expect(JSON.parse(logged.mock.calls[0]![0] as string)).toMatchObject({
      level: 'error',
      event: 'agent_consumer.message_off_contract',
      service: 'agent-consumer',
      component: 'queue-consumer',
      data: { messageId: inline.id, queue: batch.queue },
    });
    if (mixed) {
      expect(getByName).toHaveBeenCalledExactlyOnceWith(reference.key);
      expect(process).toHaveBeenCalledExactlyOnceWith(reference);
      expect(delivery.ack).toHaveBeenCalledOnce();
      expect(delivery.retry).not.toHaveBeenCalled();
    } else {
      expect(getByName).not.toHaveBeenCalled();
    }
  });
});

describe('agent consumer DLQ', () => {
  it('acknowledges a valid deleted-organization message without preserving another copy', async () => {
    const orgId = `erased-${crypto.randomUUID()}`;
    await env.AGENT_DELIVERY_COORDINATOR.getByName(`org:${orgId}`).beginErasure({});
    const base = queueMessage();
    const ack = vi.fn();
    const retry = vi.fn();
    const message = {
      id: crypto.randomUUID(),
      timestamp: new Date(),
      body: { ...base, tenancy: { ...base.tenancy, org_id: orgId } },
      attempts: 6,
      ack,
      retry,
    };
    const batch = {
      queue: 'agent-ingest-dlq-dev',
      messages: [message],
      retryAll: vi.fn(),
      ackAll: vi.fn(),
    } as unknown as MessageBatch<unknown>;
    const preserve = vi.fn(() => {
      throw new Error('deleted payload must not be preserved');
    });

    await worker.queue(batch, {
      ...env,
      AGENT_DEAD_LETTERS: { getByName: preserve },
    } as unknown as AgentConsumerEnv);

    expect(ack).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
    expect(preserve).not.toHaveBeenCalled();
  });

  it('discards a shared recovery copy when erasure starts during preservation', async () => {
    const body = queueMessage();
    const ack = vi.fn();
    const message = {
      id: crypto.randomUUID(),
      timestamp: new Date(),
      body,
      attempts: 6,
      ack,
      retry: vi.fn(),
    };
    const batch = {
      queue: 'agent-ingest-dlq-dev',
      messages: [message],
      retryAll: vi.fn(),
      ackAll: vi.fn(),
    } as unknown as MessageBatch<unknown>;
    const getErasureState = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ erasureStarted: true });
    const discardDlq = vi.fn(async () => undefined);
    const preserveDlq = vi.fn(async () => ({ id: 17 }));
    const isolatedEnv = {
      ...env,
      AGENT_DELIVERY_COORDINATOR: {
        getByName: vi.fn(() => ({ getErasureState })),
      },
      AGENT_DEAD_LETTERS: {
        getByName: vi.fn(() => ({ preserveDlq, discardDlq })),
      },
    } as unknown as AgentConsumerEnv;

    await worker.queue(batch, isolatedEnv);

    expect(preserveDlq).toHaveBeenCalledOnce();
    expect(discardDlq).toHaveBeenCalledWith(17, expect.stringMatching(/^[0-9a-f]{64}$/));
    expect(ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
  });

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
    const recovery = await env.AGENT_DEAD_LETTERS.getByName(
      AGENT_DEAD_LETTERS_INSTANCE_NAME,
    ).listRecovery();
    expect(recovery.records).toHaveLength(1);
    expect(recovery.records[0]).toMatchObject({
      kind: 'dlq',
      state: 'blocked',
      classification: 'dead_letter',
    });
    expect(JSON.parse(recovery.records[0]?.payload ?? '{}')).toMatchObject({ body: message.body });
  });

  it('preserves valid messages only in the shared dead-letter store before acknowledgement', async () => {
    const messageId = `dead-letter-${crypto.randomUUID()}`;
    const body = queueMessage();
    const sharedSink = env.AGENT_DEAD_LETTERS.getByName(AGENT_DEAD_LETTERS_INSTANCE_NAME);
    let durablyPreserved = false;
    const preserveDlq = vi.fn(async (payload: string, outcome: string, dedupeKey: string) => {
      const record = await sharedSink.preserveDlq(payload, outcome, dedupeKey);
      durablyPreserved = true;
      return record;
    });
    const getByName = vi.fn((name: string) => {
      if (name !== AGENT_DEAD_LETTERS_INSTANCE_NAME) {
        throw new Error('Unexpected dead-letter instance');
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
      AGENT_DEAD_LETTERS: { getByName },
    } as unknown as AgentConsumerEnv;

    await worker.queue(batch, isolatedEnv);
    durablyPreserved = false;
    await worker.queue(batch, isolatedEnv);

    expect(getByName).toHaveBeenCalledTimes(2);
    expect(getByName).toHaveBeenNthCalledWith(1, AGENT_DEAD_LETTERS_INSTANCE_NAME);
    expect(getByName).toHaveBeenNthCalledWith(2, AGENT_DEAD_LETTERS_INSTANCE_NAME);
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
        AGENT_DEAD_LETTERS: { getByName: unavailable, idFromName: unavailable, get: unavailable },
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
