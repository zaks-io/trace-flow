import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, type HttpDeps } from '../http';
import { createMockCtx, createMockDeps, type MockCtx } from './httpTest.setup';
import { signPipesAccessGrant } from '../pipesAccessGrant';

describe('convex/http.ts internal routes', () => {
  let ctx: MockCtx;
  let deps: HttpDeps;

  beforeEach(() => {
    vi.stubEnv('AUTH0_DOMAIN', 'test.auth0.com');
    ctx = createMockCtx();
    deps = createMockDeps();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  describe('POST /usage/record', () => {
    const ORG_ID = 'k57axc8sefsfp6k28nx6c481js806pwv';

    it('records usage when trace context is provided', async () => {
      vi.stubEnv('USAGE_SYNC_SECRET', 'sync-secret');
      const app = createApp(deps);
      ctx.runQuery.mockResolvedValue({ _id: ORG_ID });
      ctx.runMutation.mockResolvedValue(undefined);

      const res = await app.request(
        'http://localhost/usage/record',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer sync-secret',
            traceparent: '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01',
          },
          body: JSON.stringify({
            orgId: ORG_ID,
            periodStart: 1,
            periodEnd: 2,
            subscriptionUnitsUsed: 3,
            addonUnitsUsed: 4,
            traceContext: {
              traceId: '0123456789abcdef0123456789abcdef',
              requestId: 'req_123',
            },
          }),
        },
        ctx,
      );

      expect(res.status).toBe(200);
      expect(ctx.runQuery).toHaveBeenCalledOnce();
      expect(ctx.runMutation).toHaveBeenCalledTimes(2);
      expect(ctx.runMutation.mock.calls[0]?.[1]).toMatchObject({
        orgId: ORG_ID,
        periodStart: 1,
        periodEnd: 2,
        subscriptionUnitsUsed: 3,
        addonUnitsUsed: 4,
      });
      expect(ctx.runMutation.mock.calls[1]?.[1]).toMatchObject({
        orgId: ORG_ID,
        subscriptionUnitsUsed: 3,
        addonUnitsUsed: 4,
      });
    });

    it('rejects malformed org ids before Convex validators run', async () => {
      vi.stubEnv('USAGE_SYNC_SECRET', 'sync-secret');
      const app = createApp(deps);

      const res = await app.request(
        'http://localhost/usage/record',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer sync-secret',
          },
          body: JSON.stringify({
            orgId: 'org_dev_smoke',
            periodStart: 1,
            periodEnd: 2,
            subscriptionUnitsUsed: 3,
            addonUnitsUsed: 4,
          }),
        },
        ctx,
      );

      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toEqual({ error: 'Invalid organization id' });
      expect(ctx.runQuery).not.toHaveBeenCalled();
      expect(ctx.runMutation).not.toHaveBeenCalled();
    });
  });

  describe('Worker authorization routes', () => {
    const USER_ID = 'j57axc8sefsfp6k28nx6c481js806pwv';
    const ORG_ID = 'k57axc8sefsfp6k28nx6c481js806pwv';

    it('authorizes body access only while the signed subject remains active', async () => {
      vi.stubEnv('BODY_ACCESS_JWT_SECRET', 'body-secret');
      const app = createApp(deps);
      ctx.runQuery.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
      const request = () =>
        app.request(
          'http://localhost/worker/authorize-body-access',
          {
            method: 'POST',
            headers: {
              Authorization: 'Bearer body-secret',
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              sub: 'auth0|user',
              userId: USER_ID,
              orgId: ORG_ID,
            }),
          },
          ctx,
        );

      await expect((await request()).json()).resolves.toEqual({ authorized: true });
      await expect((await request()).json()).resolves.toEqual({ authorized: false });
      expect(ctx.runQuery).toHaveBeenCalledTimes(2);
    });

    it('authorizes API keys from current Convex state and rejects deleted keys', async () => {
      vi.stubEnv('USAGE_SYNC_SECRET', 'sync-secret');
      const app = createApp(deps);
      ctx.runQuery
        .mockResolvedValueOnce({
          _creationTime: 1,
          expiresAt: Date.now() + 60_000,
          orgId: ORG_ID,
        })
        .mockResolvedValueOnce(null);
      const request = () =>
        app.request(
          'http://localhost/worker/authorize-api-key',
          {
            method: 'POST',
            headers: {
              Authorization: 'Bearer sync-secret',
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ key: 'current-key' }),
          },
          ctx,
        );

      await expect((await request()).json()).resolves.toMatchObject({
        authorized: true,
        orgId: ORG_ID,
      });
      await expect((await request()).json()).resolves.toEqual({
        authorized: false,
        reason: 'invalid',
      });
      expect(ctx.runQuery).toHaveBeenCalledTimes(2);
    });

    it('exchanges a scoped query grant only while membership remains active', async () => {
      vi.stubEnv('PIPES_API_SHARED_SECRET', 'pipes-secret');
      const app = createApp(deps);
      const { token } = await signPipesAccessGrant(
        { userId: USER_ID, orgId: ORG_ID, pipe: 'traces_list' },
        'pipes-secret',
        300,
      );
      ctx.runAction
        .mockResolvedValueOnce({ token: 'server-tinybird-token', expiresAt: 500 })
        .mockResolvedValueOnce(null);
      const request = () =>
        app.request(
          'http://localhost/worker/authorize-pipes-query',
          {
            method: 'POST',
            headers: {
              Authorization: 'Bearer pipes-secret',
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ grant: token, pipe: 'traces_list' }),
          },
          ctx,
        );

      const allowed = await request();
      expect(allowed.status).toBe(200);
      await expect(allowed.json()).resolves.toMatchObject({
        authorized: true,
        token: 'server-tinybird-token',
      });
      await expect((await request()).json()).resolves.toEqual({ authorized: false });
      expect(ctx.runAction).toHaveBeenCalledTimes(2);
    });

    it('rejects an expired or wrong-pipe grant before querying current state', async () => {
      vi.stubEnv('PIPES_API_SHARED_SECRET', 'pipes-secret');
      const app = createApp(deps);
      const expired = await signPipesAccessGrant(
        { userId: USER_ID, orgId: ORG_ID, pipe: 'traces_list' },
        'pipes-secret',
        -1,
      );
      const valid = await signPipesAccessGrant(
        { userId: USER_ID, orgId: ORG_ID, pipe: 'trace_detail' },
        'pipes-secret',
        300,
      );
      for (const grant of [expired.token, valid.token]) {
        const response = await app.request(
          'http://localhost/worker/authorize-pipes-query',
          {
            method: 'POST',
            headers: {
              Authorization: 'Bearer pipes-secret',
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ grant, pipe: 'traces_list' }),
          },
          ctx,
        );
        await expect(response.json()).resolves.toEqual({ authorized: false });
      }
      expect(ctx.runAction).not.toHaveBeenCalled();
    });
  });

  describe('POST /agent-ingest/claim-sessions', () => {
    const ORG_ID = 'k57axc8sefsfp6k28nx6c481js806pwv';
    const USER_ID = 'j57axc8sefsfp6k28nx6c481js806pwv';

    beforeEach(() => {
      vi.stubEnv('AGENT_INGEST_SHARED_SECRET', 'agent-secret');
    });

    it('rejects malformed org ids before Convex validators run', async () => {
      const app = createApp(deps);

      const res = await app.request(
        'http://localhost/agent-ingest/claim-sessions',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer agent-secret',
          },
          body: JSON.stringify({
            orgId: 'org_dev_smoke',
            userId: USER_ID,
            collectorId: 'collector-1',
            sessionPks: ['session-1'],
          }),
        },
        ctx,
      );

      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toEqual({ error: 'Invalid organization id' });
      expect(ctx.runQuery).not.toHaveBeenCalled();
      expect(ctx.runMutation).not.toHaveBeenCalled();
    });

    it('rejects malformed user ids before Convex validators run', async () => {
      const app = createApp(deps);
      ctx.runQuery.mockResolvedValueOnce({ _id: ORG_ID });

      const res = await app.request(
        'http://localhost/agent-ingest/claim-sessions',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer agent-secret',
          },
          body: JSON.stringify({
            orgId: ORG_ID,
            userId: 'user_dev_smoke',
            collectorId: 'collector-1',
            sessionPks: ['session-1'],
          }),
        },
        ctx,
      );

      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toEqual({ error: 'Invalid user id' });
      expect(ctx.runQuery).toHaveBeenCalledOnce();
      expect(ctx.runMutation).not.toHaveBeenCalled();
    });

    it('rejects a credential revoked after its KV record was read', async () => {
      const app = createApp(deps);
      ctx.runQuery
        .mockResolvedValueOnce({ _id: ORG_ID })
        .mockResolvedValueOnce({ _id: USER_ID, orgId: ORG_ID })
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(null);

      const res = await app.request(
        'http://localhost/agent-ingest/claim-sessions',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer agent-secret',
          },
          body: JSON.stringify({
            orgId: ORG_ID,
            userId: USER_ID,
            collectorId: 'collector-1',
            hashedSecret: 'a'.repeat(64),
            sessionPks: ['session-1'],
          }),
        },
        ctx,
      );

      expect(res.status).toBe(404);
      await expect(res.json()).resolves.toEqual({ error: 'User not found in organization' });
      expect(ctx.runQuery).toHaveBeenCalledTimes(4);
      expect(ctx.runMutation).not.toHaveBeenCalled();
    });
  });
});
