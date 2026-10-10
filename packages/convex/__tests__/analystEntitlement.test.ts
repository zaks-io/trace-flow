import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { ANALYST_PRO_REQUIRED_MESSAGE } from '../analyst';
import { buildAnalystTools } from '../analystTools';
import { dispatchToolCall, LATEST_PROTOCOL_VERSION } from '@trace-flow/mcp-core';
import { createMcpBackend } from '../mcp/backend';
import { decodeJwt } from 'jose';
import { getFunctionName } from 'convex/server';
import { analyticsKeyId } from '@trace-flow/utils';
import type { ActionCtx } from '../_generated/server';
import { initConvexTest, type ConvexTest } from './convexTest.setup';

interface AnalystWorld {
  t: ConvexTest;
  userId: Id<'users'>;
  orgId: Id<'organizations'>;
  threadId: Id<'analystThreads'>;
  tokenIdentifier: string;
}

async function seedAnalystWorld(subscription?: {
  tier: 'hobby' | 'pro';
  status: 'active' | 'grace' | 'suspended' | 'canceled';
}): Promise<AnalystWorld> {
  const t = initConvexTest();
  const tokenIdentifier = 'https://auth.example/|auth0|analyst-entitlement';
  const { userId, orgId } = await t.run(async (ctx) => {
    const userId = await ctx.db.insert('users', {
      tokenIdentifier,
      email: 'analyst@example.com',
      enabled: true,
      isAdmin: true,
    });
    const orgId = await ctx.db.insert('organizations', { name: 'Analyst org', ownerId: userId });
    await ctx.db.patch(userId, { orgId });
    await ctx.db.insert('organizationMembers', {
      orgId,
      userId,
      role: 'owner',
      status: 'active',
      joinedAt: 1,
    });

    if (subscription) {
      await ctx.db.insert('subscriptions', {
        orgId,
        tier: subscription.tier,
        status: subscription.status,
        monthlyUnits: 1_000,
        addonUnits: 0,
        currentPeriodStart: 1,
        currentPeriodEnd: 2,
        currentPeriodOverageSpentCents: 0,
        addonPurchaseCount: 0,
      });
    }

    return { userId, orgId };
  });
  const world = { t, userId, orgId, tokenIdentifier };
  const threadId = await insertAnalystThread(world);
  return { ...world, threadId };
}

async function insertAnalystThread(world: Omit<AnalystWorld, 'threadId'>) {
  return world.t.run((ctx) =>
    ctx.db.insert('analystThreads', {
      creatorUserId: world.userId,
      orgId: world.orgId,
      agentThreadId: 'agent-thread',
      title: 'Entitlement test',
      status: 'active',
      updatedAt: 1,
      lastMessageAt: 1,
    }),
  );
}

describe('Analyst Pro entitlement', () => {
  beforeEach(() => {
    vi.stubEnv('SENTRY_DSN', 'https://public@example.invalid/1');
    vi.stubEnv('SENTRY_ENVIRONMENT', 'test');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
  it.each([
    ['a missing subscription', undefined],
    ['Hobby', { tier: 'hobby' as const, status: 'active' as const }],
    ['inactive Pro', { tier: 'pro' as const, status: 'grace' as const }],
  ])('denies sendMessage before creating work for %s', async (_label, subscription) => {
    const world = await seedAnalystWorld(subscription);
    const asUser = world.t.withIdentity({ tokenIdentifier: world.tokenIdentifier });

    await expect(
      asUser.action(api.analyst.sendMessage, { prompt: 'Analyze my usage' }),
    ).rejects.toThrow(ANALYST_PRO_REQUIRED_MESSAGE);

    const threadCount = await world.t.run(
      async (ctx) => (await ctx.db.query('analystThreads').collect()).length,
    );
    expect(threadCount).toBe(1);
  });

  it('allows active Pro to create and schedule an Analyst conversation', async () => {
    vi.useFakeTimers();
    try {
      const world = await seedAnalystWorld({ tier: 'pro', status: 'active' });
      const asUser = world.t.withIdentity({ tokenIdentifier: world.tokenIdentifier });
      const result = await asUser.action(api.analyst.sendMessage, { prompt: 'Analyze my usage' });

      expect(result.threadId).toBeDefined();
      const thread = await world.t.run((ctx) => ctx.db.get(result.threadId));
      expect(thread).toMatchObject({ creatorUserId: world.userId, orgId: world.orgId });
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('blocks a scheduled Analyst inference after the organization downgrades', async () => {
    const world = await seedAnalystWorld({ tier: 'hobby', status: 'active' });
    const threadId = world.threadId;

    await expect(
      world.t.action(internal.analyst.streamMessage, {
        threadId,
        userId: world.userId,
        prompt: 'Scheduled before downgrade',
      }),
    ).rejects.toThrow(ANALYST_PRO_REQUIRED_MESSAGE);

    const thread = await world.t.run((ctx) => ctx.db.get(threadId));
    expect(thread?.lastMessageAt).toBe(1);
  });

  async function executeTool(
    world: AnalystWorld,
    name = 'describe_agent_analytics',
    input: Record<string, unknown> = { include_values: false },
    threadId: string | undefined = 'agent-thread',
  ) {
    return world.t.action(async (ctx) => {
      const tool = buildAnalystTools()[name];
      return tool.execute!.call(
        Object.assign(tool, {
          ctx: { ...ctx, userId: String(world.userId), threadId },
        }),
        input,
        {
          toolCallId: 'test-call',
          messages: [],
        },
      );
    });
  }

  it('returns the unchanged MCP result through the real dispatcher and backend', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_791_589_690_000);
    const world = await seedAnalystWorld({ tier: 'pro', status: 'active' });
    const expiresAt = Date.now() + 60_000;
    await world.t.run(async (ctx) => {
      const keyId = await ctx.db.insert('apiKeys', {
        key: '11111111-1111-1111-1111-111111111111',
        userId: world.userId,
        orgId: world.orgId,
        name: 'Current',
        expiresAt,
      });
      await ctx.db.insert('apiKeys', {
        key: '22222222-2222-2222-2222-222222222222',
        userId: world.userId,
        orgId: world.orgId,
        name: 'Expired',
        expiresAt: 1,
      });
      return keyId;
    });
    const result = await executeTool(world);
    const expected = await world.t.action(async (ctx) => {
      const response = await dispatchToolCall(
        createMcpBackend(ctx as ActionCtx, world.userId),
        'https://api.us-west-2.aws.tinybird.co',
        1,
        { name: 'describe_agent_analytics', arguments: { include_values: false } },
        LATEST_PROTOCOL_VERSION,
        'analyst',
      );
      return response.result;
    });
    expect(result).toEqual(expected);
    expect(result).toMatchObject({ content: [{ type: 'text' }] });
    expect(JSON.stringify(result)).not.toContain('11111111-1111-1111-1111-111111111111');
  });

  it('mints query access only for current ingest keys in the active organization', async () => {
    const world = await seedAnalystWorld({ tier: 'pro', status: 'active' });
    const activeKey = '33333333-3333-3333-3333-333333333333';
    const legacyUserKey = '88888888-8888-8888-8888-888888888888';
    await world.t.run(async (ctx) => {
      for (const [key, expiresAt, permissions] of [
        [activeKey, Date.now() + 60_000, ['ingest']],
        [legacyUserKey, Date.now() + 60_000, ['ingest']],
        ['44444444-4444-4444-4444-444444444444', 1, ['ingest']],
        ['55555555-5555-5555-5555-555555555555', Date.now() + 60_000, ['mcp:read']],
      ] as const) {
        await ctx.db.insert('apiKeys', {
          key,
          expiresAt,
          permissions: [...permissions],
          userId: world.userId,
          ...(key === legacyUserKey ? {} : { orgId: world.orgId }),
        });
      }
    });
    const queryScopes: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: unknown, init?: RequestInit) => {
        const authorization = new Headers(init?.headers).get('Authorization');
        if (authorization?.startsWith('Bearer ')) {
          queryScopes.push(decodeJwt(authorization.slice(7)).scopes);
        }
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }),
    );
    await executeTool(world, 'get_usage_summary', {});
    expect(queryScopes).toEqual([
      [
        {
          type: 'PIPES:READ',
          resource: 'llm_usage_summary',
          fixed_params: {
            api_keys: [await analyticsKeyId(activeKey), await analyticsKeyId(legacyUserKey)].join(
              ',',
            ),
            retention_days: 30,
            org_id: world.orgId,
          },
        },
      ],
    ]);
  });

  it.each([
    ['a missing subscription', undefined],
    ['Hobby', { tier: 'hobby' as const, status: 'active' as const }],
    ['inactive Pro', { tier: 'pro' as const, status: 'grace' as const }],
  ])('denies a direct tool call for %s', async (_label, subscription) => {
    await expect(executeTool(await seedAnalystWorld(subscription))).rejects.toThrow(
      ANALYST_PRO_REQUIRED_MESSAGE,
    );
  });

  it('denies direct tools when membership is removed even if stale org routing remains', async () => {
    const world = await seedAnalystWorld({ tier: 'pro', status: 'active' });
    await world.t.run(async (ctx) => {
      const member = await ctx.db
        .query('organizationMembers')
        .withIndex('by_user_id', (q) => q.eq('userId', world.userId))
        .first();
      await ctx.db.patch(member!._id, { status: 'removed' });
    });
    await expect(executeTool(world)).rejects.toThrow('Conversation not found');
  });

  async function moveCreatorToAnotherProOrg(world: AnalystWorld) {
    await world.t.run(async (ctx) => {
      const member = await ctx.db
        .query('organizationMembers')
        .withIndex('by_user_id', (q) => q.eq('userId', world.userId))
        .first();
      await ctx.db.patch(member!._id, { status: 'removed' });
      const orgId = await ctx.db.insert('organizations', {
        name: 'New Pro org',
        ownerId: world.userId,
      });
      await ctx.db.patch(world.userId, { orgId });
      await ctx.db.insert('organizationMembers', {
        orgId,
        userId: world.userId,
        role: 'owner',
        status: 'active',
        joinedAt: 2,
      });
      await ctx.db.insert('subscriptions', {
        orgId,
        tier: 'pro',
        status: 'active',
        monthlyUnits: 1_000,
        addonUnits: 0,
        currentPeriodStart: 1,
        currentPeriodEnd: 2,
        currentPeriodOverageSpentCents: 0,
        addonPurchaseCount: 0,
      });
      await ctx.db.insert('apiKeys', {
        key: '66666666-6666-6666-6666-666666666666',
        userId: world.userId,
        orgId,
        name: 'New org data',
        expiresAt: Date.now() + 60_000,
      });
    });
  }

  it('denies tools in the original thread after its creator moves to another Pro org', async () => {
    const world = await seedAnalystWorld({ tier: 'pro', status: 'active' });
    await moveCreatorToAnotherProOrg(world);
    const fetchData = vi.fn(async () => new Response(JSON.stringify({ data: [{ org: 'B' }] })));
    vi.stubGlobal('fetch', fetchData);
    await expect(executeTool(world, 'get_usage_summary', {})).rejects.toThrow(
      'Conversation not found',
    );
    expect(fetchData).not.toHaveBeenCalled();
  });

  it('denies query access if the creator moves orgs after tool authorization', async () => {
    const world = await seedAnalystWorld({ tier: 'pro', status: 'active' });
    await world.t.run((ctx) =>
      ctx.db.insert('apiKeys', {
        key: '77777777-7777-7777-7777-777777777777',
        userId: world.userId,
        orgId: world.orgId,
        expiresAt: Date.now() + 60_000,
      }),
    );
    const fetchData = vi.fn();
    let moved = false;
    vi.stubGlobal('fetch', async (input: string) => {
      if (input.includes('tinybird.co')) fetchData(input);
      return new Response(JSON.stringify({ data: [] }));
    });
    await expect(
      world.t.action(async (ctx) => {
        const toolCtx = {
          ...ctx,
          userId: String(world.userId),
          threadId: 'agent-thread',
          runQuery: async (
            query: Parameters<typeof ctx.runQuery>[0],
            queryArgs: Parameters<typeof ctx.runQuery>[1],
          ) => {
            const result = await ctx.runQuery(query, queryArgs);
            if (!moved && getFunctionName(query) === 'apiKeys:listForUser') {
              moved = true;
              await moveCreatorToAnotherProOrg(world);
            }
            return result;
          },
        };
        const tool = buildAnalystTools().get_usage_summary;
        return tool.execute!.call(
          Object.assign(tool, { ctx: toolCtx }),
          {},
          {
            toolCallId: 'mid-call-move',
            messages: [],
          },
        );
      }),
    ).rejects.toThrow('Internal tool error');
    expect(moved).toBe(true);
    expect(fetchData).not.toHaveBeenCalled();
  });

  it('denies tools without an agent thread id', async () => {
    const world = await seedAnalystWorld({ tier: 'pro', status: 'active' });
    await expect(executeTool(world, 'describe_agent_analytics', {}, '')).rejects.toThrow(
      'Conversation not found',
    );
  });

  it.each(['missing', 'another creator', 'archived'])(
    'denies tools for a %s thread',
    async (state) => {
      const world = await seedAnalystWorld({ tier: 'pro', status: 'active' });
      await world.t.run(async (ctx) => {
        if (state === 'missing') await ctx.db.delete(world.threadId);
        if (state === 'archived') await ctx.db.patch(world.threadId, { status: 'archived' });
        if (state === 'another creator') {
          const creatorUserId = await ctx.db.insert('users', {
            tokenIdentifier: 'other-creator',
            email: 'other@example.com',
            enabled: true,
            isAdmin: false,
          });
          await ctx.db.patch(world.threadId, { creatorUserId });
        }
      });
      await expect(executeTool(world)).rejects.toThrow('Conversation not found');
    },
  );
});
