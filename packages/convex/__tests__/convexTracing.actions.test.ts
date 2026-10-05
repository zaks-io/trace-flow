import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initConvexTest } from './convexTest.setup';
import { signPipesAccessGrant } from '../pipesAccessGrant';
import { createMcpBackend } from '../mcp/backend';
import { withTinybirdTracing } from '../tinybirdTracing';
import { internal } from '../_generated/api';
import type { ActionCtx } from '../_generated/server';

interface TraceEvent {
  type?: string;
  transaction?: string;
  exception?: unknown;
  contexts: { trace: { trace_id: string; span_id: string; parent_span_id?: string } };
}

const TRACE = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const PARENT = 'bbbbbbbbbbbbbbbb';
const SHARED_SECRET = 'test-shared-secret';
const events: TraceEvent[] = [];

async function seedMember(t: ReturnType<typeof initConvexTest>) {
  return t.run(async (ctx) => {
    const userId = await ctx.db.insert('users', {
      tokenIdentifier: 'https://test.example/|trace-user',
      email: 'trace@example.com',
      enabled: true,
    });
    const orgId = await ctx.db.insert('organizations', { name: 'Trace test', ownerId: userId });
    await ctx.db.patch(userId, { orgId });
    await ctx.db.insert('organizationMembers', {
      orgId,
      userId,
      role: 'owner',
      status: 'active',
      joinedAt: 1,
    });
    return { userId, orgId };
  });
}

function request(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SHARED_SECRET}`,
      'Content-Type': 'application/json',
      'sentry-trace': `${TRACE}-${PARENT}-1`,
      baggage: 'customer-secret=must-not-be-exported',
    },
    body: JSON.stringify(body),
  };
}

function assertActionParent(httpName: string, actionName: string) {
  const http = events.find((event) => event.transaction === httpName)!;
  const action = events.find((event) => event.transaction === actionName)!;
  expect(http.contexts.trace.trace_id).toBe(TRACE);
  expect(http.contexts.trace.parent_span_id).toBe(PARENT);
  expect(action.contexts.trace.trace_id).toBe(TRACE);
  expect(action.contexts.trace.parent_span_id).toBe(http.contexts.trace.span_id);
  expect(JSON.stringify(events)).not.toContain('must-not-be-exported');
}

describe('Convex HTTP to internal action trace continuity', () => {
  beforeEach(() => {
    events.length = 0;
    vi.stubEnv('AXIOM_TOKEN', '');
    vi.stubEnv('SENTRY_DSN', 'https://public@sentry.test/1');
    vi.stubEnv('SENTRY_ENVIRONMENT', 'test');
    vi.stubEnv('MCP_BACKEND_SHARED_SECRET', SHARED_SECRET);
    vi.stubEnv('PIPES_API_SHARED_SECRET', SHARED_SECRET);
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

  it('keeps the authenticated MCP mint and receiving internal action in one trace', async () => {
    const t = initConvexTest();
    const { userId } = await seedMember(t);
    const response = await t.fetch(
      '/mcp-backend/mint',
      request({
        userId,
        apiKeyIds: [],
        scopes: [{ type: 'PIPES:READ', resource: 'llm_usage_summary' }],
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ token: expect.any(String) });
    assertActionParent('POST /mcp-backend/mint', 'convex.generateTokenInternal');
  });

  it('keeps pipes grant authorization and internal mint in one trace', async () => {
    const t = initConvexTest();
    const { userId, orgId } = await seedMember(t);
    const grant = await signPipesAccessGrant(
      { userId, orgId, pipe: 'llm_usage_summary' },
      SHARED_SECRET,
      60,
    );
    const response = await t.fetch(
      '/worker/authorize-pipes-query',
      request({ grant: grant.token, pipe: 'llm_usage_summary' }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ authorized: true, token: expect.any(String) });
    assertActionParent('POST /worker/authorize-pipes-query', 'convex.authorizePipesQuery');
  });

  it('preserves the Analyst explicit action scope when the backend mints a token', async () => {
    const t = initConvexTest();
    const { userId } = await seedMember(t);
    const ctx = {
      runQuery: (query: unknown, args: unknown) =>
        (t.query as (query: unknown, args: unknown) => Promise<unknown>)(query, args),
      runAction: (action: unknown, args: unknown) =>
        (t.action as (action: unknown, args: unknown) => Promise<unknown>)(action, args),
    } as unknown as ActionCtx;
    await withTinybirdTracing(async (scope) => {
      const backend = createMcpBackend(ctx, userId, scope);
      await backend.mintToken([{ type: 'PIPES:READ', resource: 'llm_usage_summary' }], [], 7);
    });
    const analyst = events.find((event) => event.transaction === 'convex.tinybird')!;
    const mint = events.find((event) => event.transaction === 'convex.generateTokenInternal')!;
    expect(mint.contexts.trace.trace_id).toBe(analyst.contexts.trace.trace_id);
    expect(mint.contexts.trace.parent_span_id).toBe(analyst.contexts.trace.span_id);
  });

  it('rejects invalid serialized IDs before running the internal action', async () => {
    const t = initConvexTest();
    await expect(
      t.action(internal.integrations.tinybird.generateTokenInternal, {
        analyticsKeyIds: [],
        scopes: [{ type: 'PIPES:READ', resource: 'llm_usage_summary' }],
        traceContext: { traceId: 'invalid', spanId: PARENT, sampled: true },
      }),
    ).rejects.toThrow('Invalid Convex trace context');
    expect(events).toEqual([]);
  });

  it('bounds both nested HTTP mint exports while preserving the successful token response', async () => {
    const t = initConvexTest();
    const { userId } = await seedMember(t);
    vi.useFakeTimers();
    const exporter = vi.fn(() => new Promise<Response>(() => undefined));
    vi.stubGlobal('fetch', exporter);
    const warning = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let completed = false;
    const response = t
      .fetch(
        '/mcp-backend/mint',
        request({
          userId,
          apiKeyIds: [],
          scopes: [{ type: 'PIPES:READ', resource: 'llm_usage_summary' }],
        }),
      )
      .then((result) => {
        completed = true;
        return result;
      });
    await vi.waitFor(() => expect(exporter).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(260);
    expect(exporter).toHaveBeenCalledTimes(2);
    expect(completed).toBe(false);
    await vi.advanceTimersByTimeAsync(260);
    const result = await response;
    expect(result.status).toBe(200);
    await expect(result.json()).resolves.toEqual({ token: expect.any(String) });
    expect(warning).toHaveBeenCalledTimes(2);
  });
});
