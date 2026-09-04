import { captureMessage } from '@sentry/cloudflare';
import { env } from 'cloudflare:test';
import type * as SentryCloudflare from '@sentry/cloudflare';
import { describe, expect, it, vi } from 'vitest';
import worker from '../index';

vi.mock('@sentry/cloudflare', async (importOriginal) => ({
  ...(await importOriginal<typeof SentryCloudflare>()),
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
});

describe('DLQ preservation failure', () => {
  it('retries without acknowledging and emits an actionable failure event', async () => {
    const ack = vi.fn();
    const retry = vi.fn();
    const message = {
      id: 'preservation-failure',
      timestamp: new Date(),
      body: { malformed: true },
      attempts: 1,
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
    const unavailable = () => {
      throw new Error('durable storage unavailable');
    };
    const failingEnv = {
      ...env,
      AGENT_FACT_BATCHER: { getByName: unavailable, idFromName: unavailable, get: unavailable },
    } as unknown as typeof env;
    await worker.queue(batch, failingEnv);
    expect(ack).not.toHaveBeenCalled();
    expect(retry).toHaveBeenCalledOnce();
    expect(captureMessage).toHaveBeenCalledWith(
      'agent_consumer.dead_letter_preservation_failed',
      expect.objectContaining({ level: 'fatal' }),
    );
  });
});
