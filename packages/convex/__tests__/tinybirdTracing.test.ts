import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startInactiveSpan } from '@sentry/core';
import { withTinybirdTracing } from '../tinybirdTracing';

describe('Convex Tinybird tracing', () => {
  beforeEach(() => {
    vi.stubEnv('SENTRY_DSN', 'https://public@sentry.test/1');
    vi.stubEnv('SENTRY_ENVIRONMENT', 'test');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('requires explicit telemetry configuration before executing a query', async () => {
    vi.stubEnv('SENTRY_DSN', '');
    const query = vi.fn();
    await expect(withTinybirdTracing(query)).rejects.toThrow('SENTRY_DSN');
    expect(query).not.toHaveBeenCalled();
  });

  it('flushes isolated transactions for concurrent actions before returning', async () => {
    const envelopes: string[] = [];
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      envelopes.push(String(init.body));
      return new Response('{}');
    });
    vi.stubGlobal('fetch', fetchMock);

    const results = await Promise.all(
      ['first', 'second'].map((name) =>
        withTinybirdTracing(async (scope) => {
          const span = startInactiveSpan({ name, op: 'db.query', scope });
          await Promise.resolve();
          span.end();
          return name;
        }),
      ),
    );

    expect(results).toEqual(['first', 'second']);
    expect(envelopes).toHaveLength(2);
    const transactions = envelopes.map((envelope) => JSON.parse(envelope.split('\n')[2]!));
    expect(transactions.map((event) => event.transaction).sort()).toEqual(['first', 'second']);
    expect(new Set(transactions.map((event) => event.contexts.trace.trace_id)).size).toBe(2);
    for (const event of transactions) {
      expect(event.environment).toBe('test');
      expect(event.tags.service).toBe('convex');
    }
  });

  it('flushes failed queries and preserves their original error', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}'));
    vi.stubGlobal('fetch', fetchMock);
    const failure = new Error('query failed');
    await expect(
      withTinybirdTracing(async (scope) => {
        const span = startInactiveSpan({ name: 'tinybird.sql', op: 'db.query', scope });
        span.setStatus({ code: 2 });
        span.end();
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
