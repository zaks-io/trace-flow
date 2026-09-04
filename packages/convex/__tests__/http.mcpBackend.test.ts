import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, type HttpDeps } from '../http';
import { createMockCtx, createMockDeps, type MockCtx } from './httpTest.setup';

describe('convex/http.ts MCP backend routes', () => {
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

  describe('MCP backend shared-secret routes', () => {
    const SECRET = 'mcp-backend-secret';
    const USER_ID = 'user_1';

    // createMcpBackend issues several distinct queries; route them by the
    // function ref's path so each returns a believable shape.
    function stubBackendQueries(opts: {
      enabled?: boolean;
      orgId?: string;
      keys?: { _id: string; key: string; name?: string; expiresAt: number }[];
      tier?: string;
      userMissing?: boolean;
    }) {
      const { enabled = true, orgId = 'org_1', keys = [], tier, userMissing = false } = opts;
      // Convex fn refs aren't introspectable in tests, so discriminate on the
      // query args each backend query passes: listForUser → {userId},
      // getUserById → {id}, getByOrgId → {orgId}.
      ctx.runQuery.mockImplementation((_ref: unknown, args: Record<string, unknown>) => {
        if (args && 'userId' in args) return Promise.resolve(keys);
        if (args && 'id' in args)
          return Promise.resolve(userMissing ? null : { _id: USER_ID, enabled, orgId });
        if (args && 'orgId' in args) return Promise.resolve(tier ? { tier } : null);
        return Promise.resolve(null);
      });
    }

    beforeEach(() => {
      vi.stubEnv('MCP_BACKEND_SHARED_SECRET', SECRET);
    });

    it('rejects context without the shared secret', async () => {
      const app = createApp(deps);
      const res = await app.request(
        'http://localhost/mcp-backend/context',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer wrong' },
          body: JSON.stringify({ userId: USER_ID }),
        },
        ctx,
      );
      expect(res.status).toBe(401);
    });

    it('rejects context without JSON content type', async () => {
      const app = createApp(deps);
      const res = await app.request(
        'http://localhost/mcp-backend/context',
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${SECRET}` },
          body: JSON.stringify({ userId: USER_ID }),
        },
        ctx,
      );
      expect(res.status).toBe(415);
      expect(await res.json()).toEqual({ error: 'Content-Type must be application/json' });
    });

    it('returns public key metadata + context, never raw keys', async () => {
      stubBackendQueries({
        keys: [
          { _id: 'k1', key: 'raw-secret-1', name: 'prod', expiresAt: Number.MAX_SAFE_INTEGER },
        ],
        tier: 'pro',
      });
      const app = createApp(deps);
      const res = await app.request(
        'http://localhost/mcp-backend/context',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SECRET}` },
          body: JSON.stringify({ userId: USER_ID }),
        },
        ctx,
      );
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.enabled).toBe(true);
      expect(json.apiKeys).toEqual([
        { id: 'k1', name: 'prod', expiresAt: Number.MAX_SAFE_INTEGER },
      ]);
      expect(JSON.stringify(json)).not.toContain('raw-secret-1');
    });

    it('returns 404 when context user lookup misses', async () => {
      stubBackendQueries({ userMissing: true });
      const app = createApp(deps);
      const res = await app.request(
        'http://localhost/mcp-backend/context',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SECRET}` },
          body: JSON.stringify({ userId: USER_ID }),
        },
        ctx,
      );
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'User not found' });
    });

    it('mints a scoped token for owned key ids', async () => {
      stubBackendQueries({
        keys: [{ _id: 'k1', key: 'raw-secret-1', expiresAt: Number.MAX_SAFE_INTEGER }],
      });
      ctx.runAction.mockResolvedValue('minted-tinybird-jwt');
      const app = createApp(deps);
      const res = await app.request(
        'http://localhost/mcp-backend/mint',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SECRET}` },
          body: JSON.stringify({
            userId: USER_ID,
            scopes: [{ type: 'PIPES:READ', resource: 'mcp_traces_list' }],
            apiKeyIds: ['k1'],
          }),
        },
        ctx,
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ token: 'minted-tinybird-jwt' });
      expect(ctx.runAction.mock.calls[0]?.[1]).toMatchObject({
        analyticsKeyIds: [
          'sha256:f42ffc628be4e7fd158fdea6f57970e4f201f537dcdd5b80e355105fd77648e7',
        ],
        orgId: 'org_1',
      });
      expect(JSON.stringify(ctx.runAction.mock.calls[0]?.[1])).not.toContain('raw-secret-1');
    });

    it('rejects mint for a disabled user with 403', async () => {
      stubBackendQueries({ enabled: false });
      const app = createApp(deps);
      const res = await app.request(
        'http://localhost/mcp-backend/mint',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SECRET}` },
          body: JSON.stringify({ userId: USER_ID, scopes: [], apiKeyIds: [] }),
        },
        ctx,
      );
      expect(res.status).toBe(403);
      expect(ctx.runAction).not.toHaveBeenCalled();
    });

    it('returns 404 when mint user lookup misses', async () => {
      stubBackendQueries({ userMissing: true });
      const app = createApp(deps);
      const res = await app.request(
        'http://localhost/mcp-backend/mint',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SECRET}` },
          body: JSON.stringify({ userId: USER_ID, scopes: [], apiKeyIds: [] }),
        },
        ctx,
      );
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'User not found' });
      expect(ctx.runAction).not.toHaveBeenCalled();
    });

    it('returns 500 when minting fails', async () => {
      stubBackendQueries({
        keys: [{ _id: 'k1', key: 'raw-secret-1', expiresAt: Number.MAX_SAFE_INTEGER }],
      });
      ctx.runAction.mockRejectedValue(new Error('Tinybird down'));
      const app = createApp(deps);
      const res = await app.request(
        'http://localhost/mcp-backend/mint',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SECRET}` },
          body: JSON.stringify({
            userId: USER_ID,
            scopes: [{ type: 'PIPES:READ', resource: 'mcp_traces_list' }],
            apiKeyIds: ['k1'],
          }),
        },
        ctx,
      );
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: 'Failed to mint token' });
    });

    it('rejects mint for unowned key ids with 400', async () => {
      stubBackendQueries({
        keys: [{ _id: 'k1', key: 'raw-secret-1', expiresAt: Number.MAX_SAFE_INTEGER }],
      });
      const app = createApp(deps);
      const res = await app.request(
        'http://localhost/mcp-backend/mint',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SECRET}` },
          body: JSON.stringify({ userId: USER_ID, scopes: [], apiKeyIds: ['k1', 'not-mine'] }),
        },
        ctx,
      );
      expect(res.status).toBe(400);
      expect(ctx.runAction).not.toHaveBeenCalled();
    });
  });
});
