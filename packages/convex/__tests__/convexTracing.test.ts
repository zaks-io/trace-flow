import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { HonoWithConvex } from 'convex-helpers/server/hono';
import type { ActionCtx } from '../_generated/server';
import { startTinybirdQuerySpan } from '@trace-flow/tinybird-client';
import { getRequestSentryScope, withConvexHttpTracing } from '../convexTracing';
import { registerHttpTracing } from '../httpRoutes/tracing';

interface TraceEvent {
  type?: string;
  transaction?: string;
  exception?: { values: { value: string }[] };
  contexts: { trace: { trace_id: string; span_id: string; parent_span_id?: string } };
  spans?: { span_id: string; parent_span_id: string; trace_id: string }[];
}

const TRACE_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const TRACE_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const PARENT = 'cccccccccccccccc';

function headers(trace: string): Headers {
  return new Headers({ 'sentry-trace': `${trace}-${PARENT}-1` });
}

describe('isolated Convex execution tracing', () => {
  const events: TraceEvent[] = [];
  beforeEach(() => {
    events.length = 0;
    vi.stubEnv('SENTRY_DSN', 'https://public@sentry.test/1');
    vi.stubEnv('SENTRY_ENVIRONMENT', 'test');
    vi.stubEnv('MCP_BACKEND_SHARED_SECRET', 'test-shared-secret');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        const lines = String(init.body).split('\n');
        for (let i = 1; i < lines.length - 1; i += 2) events.push(JSON.parse(lines[i + 1]!));
        return new Response('{}');
      }),
    );
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('continues concurrent request IDs with query children and errors in their own request scope', async () => {
    const requests = [TRACE_A, TRACE_B].map(
      (trace) =>
        new Request('https://own.convex.site/mcp-backend/context', { headers: headers(trace) }),
    );
    await Promise.all(
      requests.map((request, index) =>
        withConvexHttpTracing(request, `request-${index}`, async (scope) => {
          expect(getRequestSentryScope(request)).toBe(scope);
          const query = startTinybirdQuerySpan({
            baseUrl: 'https://api.tinybird.co',
            sentryScope: scope,
          });
          await Promise.resolve();
          if (index === 1) scope.captureException(new Error('safe query failure'));
          query.end();
        }),
      ),
    );
    const transactions = events.filter((event) => event.type === 'transaction');
    expect(transactions).toHaveLength(2);
    for (const [index, trace] of [TRACE_A, TRACE_B].entries()) {
      const event = transactions.find((item) => item.transaction === `request-${index}`)!;
      expect(event.contexts.trace.trace_id).toBe(trace);
      expect(event.contexts.trace.parent_span_id).toBe(PARENT);
      expect(event.spans).toHaveLength(1);
      expect(event.spans![0]!.parent_span_id).toBe(event.contexts.trace.span_id);
      expect(event.spans![0]!.trace_id).toBe(trace);
      expect(getRequestSentryScope(requests[index]!)).toBeUndefined();
    }
    const error = events.find((event) => event.exception)!;
    expect(error.contexts.trace.trace_id).toBe(TRACE_B);
    expect(error.contexts.trace.span_id).toBe(
      transactions.find((item) => item.transaction === 'request-1')!.contexts.trace.span_id,
    );
  });

  it('continues W3C-only context and gives valid Sentry context precedence when both differ', async () => {
    const w3c = new Headers({ traceparent: `00-${TRACE_A}-${PARENT}-01` });
    await withConvexHttpTracing(
      new Request('https://own.convex.site/usage/record', { headers: w3c }),
      'w3c',
      async () => undefined,
    );
    w3c.set('sentry-trace', `${TRACE_B}-${PARENT}-1`);
    await withConvexHttpTracing(
      new Request('https://own.convex.site/usage/record', { headers: w3c }),
      'sentry',
      async () => undefined,
    );
    expect(events.find((event) => event.transaction === 'w3c')!.contexts.trace.trace_id).toBe(
      TRACE_A,
    );
    expect(events.find((event) => event.transaction === 'sentry')!.contexts.trace.trace_id).toBe(
      TRACE_B,
    );
  });

  it('traces authenticated backend responses and sanitizes handled server failures', async () => {
    const app: HonoWithConvex<ActionCtx> = new Hono();
    registerHttpTracing(app);
    app.post('/mcp-backend/context', (c) => c.json({ error: 'sensitive response data' }, 500));
    const response = await app.request('/mcp-backend/context', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-shared-secret',
        'sentry-trace': `${TRACE_A}-${PARENT}-1`,
      },
    });
    expect(response.status).toBe(500);
    expect(events.find((event) => event.type === 'transaction')!.contexts.trace.trace_id).toBe(
      TRACE_A,
    );
    expect(events.find((event) => event.exception)!.exception!.values[0]!.value).toBe(
      'Convex HTTP action failed',
    );
    expect(JSON.stringify(events)).not.toContain('sensitive response data');
  });

  it('retains an unsampled parent identity on errors without exporting a transaction', async () => {
    const request = new Request('https://own.convex.site/mcp-backend/context', {
      headers: { 'sentry-trace': `${TRACE_A}-${PARENT}-0` },
    });
    await withConvexHttpTracing(request, 'unsampled', async (scope) => {
      scope.captureException(new Error('safe unsampled failure'));
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.exception).toBeDefined();
    expect(events[0]!.contexts.trace.trace_id).toBe(TRACE_A);
  });

  it('does not adopt unauthenticated context or export on public routes', async () => {
    const app: HonoWithConvex<ActionCtx> = new Hono();
    registerHttpTracing(app);
    app.post('/mcp-backend/context', (c) => c.json({ error: 'Unauthorized' }, 401));
    app.get('/mcp/register', (c) => c.json({ ok: true }));
    await app.request('/mcp-backend/context', { method: 'POST', headers: headers(TRACE_A) });
    await app.request('/mcp/register', { headers: headers(TRACE_A) });
    expect(events).toEqual([]);
  });

  it('returns the business response after a bounded wait when the HTTP exporter stalls', async () => {
    vi.useFakeTimers();
    const exporter = vi.fn(() => new Promise<Response>(() => undefined));
    vi.stubGlobal('fetch', exporter);
    const warning = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const request = new Request('https://own.convex.site/mcp-backend/context', {
      headers: headers(TRACE_A),
    });
    let completed = false;
    const response = withConvexHttpTracing(request, 'bounded http', async () =>
      Response.json({ authorized: true }, { status: 201 }),
    ).then((result) => {
      completed = true;
      return result;
    });
    await vi.advanceTimersByTimeAsync(249);
    expect(exporter).toHaveBeenCalledOnce();
    expect(completed).toBe(false);
    await vi.advanceTimersByTimeAsync(10);
    const result = await response;
    expect(result.status).toBe(201);
    await expect(result.json()).resolves.toEqual({ authorized: true });
    expect(warning).toHaveBeenCalledExactlyOnceWith('convex.sentry_flush_failed');
  });
});
