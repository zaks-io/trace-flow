import { createTransport, Scope, ServerRuntimeClient, type TransactionEvent } from '@sentry/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchPipe } from '../fetchPipe';
import { TinybirdQueryError } from '../errors';
import { runAdminSql } from '../runAdminSql';
import {
  finishTinybirdQuerySpan,
  recordTinybirdResponse,
  recordTinybirdStatistics,
  startTinybirdQuerySpan,
} from '../tracing';

const clients: ServerRuntimeClient[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const client of clients.splice(0)) {
    client.dispose();
  }
});

describe('Tinybird query tracing', () => {
  it('ends after parsing and records safe response statistics', async () => {
    const { events, scope, flush } = createSentryTestScope();
    let resolveBody!: (value: unknown) => void;
    const body = new Promise<unknown>((resolve) => {
      resolveBody = resolve;
    });
    const json = vi.fn(() => body);
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers({
        'x-request-id': 'request-safe-id',
        'x-cache': 'MISS',
      }),
      json,
    } as unknown as Response);

    const query = fetchPipe({
      baseUrl: 'https://api.tinybird.co',
      token: 'secret-token',
      pipe: 'trace_detail',
      params: { trace_id: 'secret-param' },
      sentryScope: scope,
      schema: {
        parse: (value) => ({ id: (value as { private_id: string }).private_id.length }),
      },
    });

    await vi.waitFor(() => expect(json).toHaveBeenCalledOnce());
    await flush();
    expect(events).toHaveLength(0);

    resolveBody({
      data: [{ private_id: 'secret-row' }],
      statistics: { elapsed: 0.125, rows_read: 12, bytes_read: 345 },
    });

    await expect(query).resolves.toEqual([{ id: 10 }]);
    await flush();

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      transaction: 'tinybird.pipe trace_detail',
      contexts: {
        trace: {
          op: 'db.query',
          status: 'ok',
          data: {
            'db.system': 'clickhouse',
            'server.address': 'api.tinybird.co',
            'tinybird.pipe': 'trace_detail',
            'http.response.status_code': 200,
            'tinybird.request_id': 'request-safe-id',
            'tinybird.cache_status': 'MISS',
            'db.response.returned_rows': 1,
            'tinybird.elapsed_ms': 125,
            'tinybird.rows_read': 12,
            'tinybird.bytes_read': 345,
          },
        },
      },
    });
    expect(JSON.stringify(events[0])).not.toMatch(
      /secret-token|secret-param|secret-row|private_id/,
    );
  });

  it('marks HTTP failures as errors without recording the provider message', async () => {
    const { events, scope, flush } = createSentryTestScope();
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('secret provider error', {
        status: 500,
        headers: { 'x-request-id': 'failed-request-id' },
      }),
    );

    await expect(
      fetchPipe({
        baseUrl: 'https://api.tinybird.co',
        token: 'secret-token',
        pipe: 'trace_detail',
        sentryScope: scope,
      }),
    ).rejects.toBeInstanceOf(TinybirdQueryError);
    await flush();

    expect(events).toHaveLength(1);
    expect(events[0]?.contexts?.trace).toMatchObject({
      op: 'db.query',
      status: 'internal_error',
      data: {
        'http.response.status_code': 500,
        'tinybird.request_id': 'failed-request-id',
      },
    });
    expect(JSON.stringify(events[0])).not.toMatch(/secret provider error|secret-token/);
  });

  it('marks schema failures as errors after recording the row count', async () => {
    const { events, scope, flush } = createSentryTestScope();
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ data: [{ invalid: true }] }), { status: 200 }),
    );

    await expect(
      fetchPipe({
        baseUrl: 'https://api.tinybird.co',
        token: 'secret-token',
        pipe: 'trace_detail',
        sentryScope: scope,
        schema: {
          parse: () => {
            throw new Error('secret schema value');
          },
        },
      }),
    ).rejects.toThrow('secret schema value');
    await flush();

    expect(events[0]?.contexts?.trace).toMatchObject({
      status: 'internal_error',
      data: { 'db.response.returned_rows': 1 },
    });
    expect(JSON.stringify(events[0])).not.toContain('secret schema value');
  });

  it.each(['network', 'json'] as const)('marks %s failures as errors', async (failure) => {
    const { events, scope, flush } = createSentryTestScope();
    const error = new Error(`secret ${failure} failure`);
    if (failure === 'network') {
      vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(error);
    } else {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: () => Promise.reject(error),
      } as unknown as Response);
    }

    await expect(
      fetchPipe({
        baseUrl: 'https://api.tinybird.co',
        token: 'secret-token',
        pipe: 'trace_detail',
        sentryScope: scope,
      }),
    ).rejects.toThrow(error.message);
    await flush();

    expect(events[0]?.contexts?.trace?.status).toBe('internal_error');
    expect(JSON.stringify(events[0])).not.toContain(error.message);
  });

  it('traces admin SQL without recording the statement or rows', async () => {
    const { events, scope, flush } = createSentryTestScope();
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ data: [{ private_value: 'secret-row' }] }), { status: 200 }),
    );

    await runAdminSql({
      baseUrl: 'https://api.tinybird.co',
      adminToken: 'secret-admin-token',
      sql: 'SELECT secret_column FROM secret_table',
      sentryScope: scope,
    });
    await flush();

    expect(events[0]).toMatchObject({
      transaction: 'tinybird.sql',
      contexts: {
        trace: {
          op: 'db.query',
          status: 'ok',
          data: {
            'db.system': 'clickhouse',
            'server.address': 'api.tinybird.co',
            'db.response.returned_rows': 1,
          },
        },
      },
    });
    expect(JSON.stringify(events[0])).not.toMatch(
      /secret-admin-token|secret_column|secret_table|private_value|secret-row/,
    );
  });

  it('omits Tinybird statistics for cache hits and invalid values', async () => {
    const { events, scope, flush } = createSentryTestScope();
    const span = startTinybirdQuerySpan({
      baseUrl: 'https://api.tinybird.co',
      pipe: 'cached_pipe',
      sentryScope: scope,
    });
    recordTinybirdResponse(
      span,
      new Response(null, { status: 200, headers: { 'x-cache': 'HIT' } }),
    );
    recordTinybirdStatistics(span, {
      data: [{ id: 1 }, { id: 2 }],
      statistics: {
        elapsed: Number.MAX_VALUE,
        rows_read: -1,
        bytes_read: Number.NaN,
      },
    });
    finishTinybirdQuerySpan(span, true);
    await flush();

    const data = events[0]?.contexts?.trace?.data;
    expect(data).toMatchObject({
      'tinybird.cache_status': 'HIT',
      'db.response.returned_rows': 2,
    });
    expect(data).not.toHaveProperty('tinybird.elapsed_ms');
    expect(data).not.toHaveProperty('tinybird.rows_read');
    expect(data).not.toHaveProperty('tinybird.bytes_read');
  });

  it('omits non-finite and negative statistics on uncached responses', async () => {
    const { events, scope, flush } = createSentryTestScope();
    const span = startTinybirdQuerySpan({
      baseUrl: 'https://api.tinybird.co',
      sentryScope: scope,
    });
    recordTinybirdStatistics(span, {
      statistics: {
        elapsed: Number.MAX_VALUE,
        rows_read: -1,
        bytes_read: Number.NaN,
      },
    });
    finishTinybirdQuerySpan(span, true);
    await flush();

    const data = events[0]?.contexts?.trace?.data;
    expect(data).not.toHaveProperty('tinybird.elapsed_ms');
    expect(data).not.toHaveProperty('tinybird.rows_read');
    expect(data).not.toHaveProperty('tinybird.bytes_read');
  });
});

function createSentryTestScope(): {
  events: TransactionEvent[];
  scope: Scope;
  flush: () => PromiseLike<boolean>;
} {
  const events: TransactionEvent[] = [];
  const client = new ServerRuntimeClient({
    dsn: 'https://public@example.com/1',
    integrations: [],
    stackParser: () => [],
    tracesSampleRate: 1,
    beforeSendTransaction(event) {
      events.push(event);
      return event;
    },
    transport: (options) => createTransport(options, () => Promise.resolve({ statusCode: 200 })),
  });
  client.init();
  clients.push(client);

  const scope = new Scope();
  scope.setClient(client);
  return { events, scope, flush: () => client.flush(1_000) };
}
