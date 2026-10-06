import * as Sentry from '@sentry/cloudflare';
import { TinybirdQueryError } from '@trace-flow/tinybird-client';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentConsumerEnv } from '../context';
import { processSnapshotQueue } from '../snapshot-queue';
import { runAgentSnapshot } from '../snapshot-runner';

vi.mock('../snapshot-runner', () => ({ runAgentSnapshot: vi.fn() }));

const TRACE_A = '1'.repeat(32);
const TRACE_B = '2'.repeat(32);
const PARENT = '3'.repeat(16);

function message(body: unknown) {
  return {
    id: crypto.randomUUID(),
    timestamp: new Date(),
    attempts: 1,
    body,
    ack: vi.fn(),
    retry: vi.fn(),
  };
}

async function process(messages: ReturnType<typeof message>[]) {
  const events: Sentry.Event[] = [];
  const worker = Sentry.withSentry(
    () => ({
      dsn: 'https://public@example.test/1',
      tracesSampleRate: 1,
      skipOpenTelemetrySetup: true,
      transport: () => ({
        send: async (envelope) => {
          for (const [header, payload] of envelope[1]) {
            if (header.type === 'event' || header.type === 'transaction') {
              events.push(payload as Sentry.Event);
            }
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
            messages,
            metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
            ackAll: vi.fn(),
            retryAll: vi.fn(),
          },
          {} as AgentConsumerEnv,
        );
        return new Response('ok');
      },
    },
  );
  const ctx = createExecutionContext();
  await (await worker.fetch(new Request('https://snapshot.test'), {}, ctx)).text();
  await waitOnExecutionContext(ctx);
  return events;
}

afterEach(() => vi.resetAllMocks());

describe('snapshot queue tracing and settlement', () => {
  it('continues each dispatcher trace and captures sanitized errors before that scope exits', async () => {
    const observed: string[] = [];
    vi.mocked(runAgentSnapshot).mockImplementation(async (_env, orgId) => {
      observed.push(Sentry.getActiveSpan()!.spanContext().traceId);
      if (orgId === 'org-a') throw new Error('private payload and provider response');
      return { status: 'idle' };
    });
    const first = message({
      type: 'agent-snapshot',
      org_id: 'org-a',
      sentry_trace_context: { 'sentry-trace': `${TRACE_A}-${PARENT}-1` },
    });
    const second = message({
      type: 'agent-snapshot',
      org_id: 'org-b',
      sentry_trace_context: { 'sentry-trace': `${TRACE_B}-${PARENT}-1` },
    });
    const events = await process([first, second]);
    expect(observed).toEqual([TRACE_A, TRACE_B]);
    expect(first.retry).toHaveBeenCalledExactlyOnceWith({ delaySeconds: 60 });
    expect(first.ack).not.toHaveBeenCalled();
    expect(second.ack).toHaveBeenCalledOnce();
    expect(second.retry).not.toHaveBeenCalled();
    const errors = events.filter((event) => event.exception);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.contexts?.trace).toMatchObject({ trace_id: TRACE_A, parent_span_id: PARENT });
    expect(errors[0]?.exception?.values).toMatchObject([
      { type: 'Error', value: 'Agent snapshot processing failed' },
    ]);
    expect(JSON.stringify(errors)).not.toContain('private payload');
  });

  it('accepts legacy messages, preserves requested retries and ignores malformed trace metadata', async () => {
    const observed: string[] = [];
    vi.mocked(runAgentSnapshot).mockImplementation(async () => {
      observed.push(Sentry.getActiveSpan()!.spanContext().traceId);
      return { status: 'retry', reason: 'gate-active' };
    });
    const legacy = message({ type: 'agent-snapshot', org_id: 'org-a' });
    const malformed = message({
      type: 'agent-snapshot',
      org_id: 'org-b',
      sentry_trace_context: { 'sentry-trace': `${'0'.repeat(32)}-${PARENT}-1` },
    });
    const events = await process([legacy, malformed]);
    expect(observed).toHaveLength(2);
    expect(observed[0]).not.toBe(observed[1]);
    expect(observed).not.toContain('0'.repeat(32));
    expect(events.filter((event) => event.exception)).toHaveLength(0);
    for (const item of [legacy, malformed]) {
      expect(item.retry).toHaveBeenCalledExactlyOnceWith({ delaySeconds: 60 });
      expect(item.ack).not.toHaveBeenCalled();
    }
  });

  it('exports classified provider failures and safe stack locations without messages or causes', async () => {
    const error = new TinybirdQueryError('private provider response', 503);
    error.stack =
      'TinybirdQueryError: private provider response\n    at privateFunction (https://private.test/index.js?key=private:42:7)';
    error.cause = new Error('private cause');
    vi.mocked(runAgentSnapshot).mockRejectedValue(error);
    const item = message({ type: 'agent-snapshot', org_id: 'org-a' });
    const events = await process([item]);
    const failures = events.filter((event) => event.exception);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.exception?.values).toEqual([
      {
        type: 'TinybirdQueryError',
        value: 'Snapshot provider request failed',
        stacktrace: { frames: [{ filename: 'index.js', lineno: 42, colno: 7 }] },
      },
    ]);
    expect(failures[0]?.extra).toMatchObject({ stage: 'dispatch', httpStatus: 503 });
    expect(JSON.stringify(failures)).not.toContain('private');
    expect(item.retry).toHaveBeenCalledExactlyOnceWith({ delaySeconds: 60 });
    expect(item.ack).not.toHaveBeenCalled();
  });

  it('validates the business payload inside its restored dispatcher context', async () => {
    const invalid = message({
      type: 'agent-snapshot',
      org_id: 'invalid:organization',
      sentry_trace_context: { 'sentry-trace': `${TRACE_A}-${PARENT}-1` },
    });
    const events = await process([invalid]);
    expect(runAgentSnapshot).not.toHaveBeenCalled();
    expect(invalid.retry).toHaveBeenCalledExactlyOnceWith({ delaySeconds: 60 });
    expect(events.find((event) => event.exception)?.contexts?.trace?.trace_id).toBe(TRACE_A);
  });
});
