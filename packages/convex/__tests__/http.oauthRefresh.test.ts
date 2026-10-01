import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { createApp, type HttpDeps } from '../http';
import { createMockCtx, createMockDeps, type MockCtx } from './httpTest.setup';

describe('convex/http.ts OAuth refresh_token grant', () => {
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

  describe('POST /mcp/token - refresh_token grant', () => {
    it('returns new tokens on successful refresh', async () => {
      const app = createApp(deps);
      ctx.runQuery.mockResolvedValue({
        userId: 'user123',
        clientId: 'client-1',
        resource: 'https://mcp.trace-flow.dev/mcp',
        auth0RefreshToken: 'auth0-refresh',
      });
      ctx.runMutation.mockResolvedValue({
        userId: 'user123',
        tokenId: 'rotated-token-id',
        resource: 'https://mcp.trace-flow.dev/mcp',
      });
      (deps.tokens.createAccessToken as Mock).mockResolvedValue('new-access-token');

      const res = await app.request(
        'http://localhost/mcp/token',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'grant_type=refresh_token&refresh_token=token-id&client_id=client-1&resource=https://mcp.trace-flow.dev/mcp',
        },
        ctx,
      );

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.access_token).toBe('new-access-token');
      expect(json.token_type).toBe('Bearer');
      expect(json.refresh_token).toBe('rotated-token-id');
      expect(ctx.runMutation).toHaveBeenCalledTimes(1);
      expect(ctx.runMutation).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          tokenId: 'token-id',
          clientId: 'client-1',
          resource: 'https://mcp.trace-flow.dev/mcp',
        }),
      );
      expect(deps.tokens.createAccessToken).toHaveBeenCalledWith(
        'user123',
        'rotated-token-id',
        'http://localhost',
        'https://mcp.trace-flow.dev/mcp',
      );
    });

    it('returns 400 for missing refresh_token', async () => {
      const app = createApp(deps);

      const res = await app.request(
        'http://localhost/mcp/token',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'grant_type=refresh_token',
        },
        ctx,
      );

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBe('invalid_request');
      expect(json.error_description).toBe('refresh_token is required');
    });

    it('returns 400 invalid_grant for an invalid refresh token', async () => {
      const app = createApp(deps);
      ctx.runQuery.mockResolvedValue(null);

      const res = await app.request(
        'http://localhost/mcp/token',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'grant_type=refresh_token&refresh_token=invalid-token&client_id=client-1&resource=https://mcp.trace-flow.dev/mcp',
        },
        ctx,
      );

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBe('invalid_grant');
    });

    it('rotates without calling Auth0, whose refresh token nothing consumes', async () => {
      const app = createApp(deps);
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      ctx.runQuery.mockResolvedValue({
        userId: 'user123',
        clientId: 'client-1',
        resource: 'https://mcp.trace-flow.dev/mcp',
        auth0RefreshToken: 'auth0-refresh',
      });
      ctx.runMutation.mockResolvedValue({
        userId: 'user123',
        tokenId: 'sibling-token-id',
        resource: 'https://mcp.trace-flow.dev/mcp',
        reusedRotatedAt: Date.now() - 5_000,
      });
      (deps.tokens.createAccessToken as Mock).mockResolvedValue('new-access-token');

      const res = await app.request(
        'http://localhost/mcp/token',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'grant_type=refresh_token&refresh_token=token-id&client_id=client-1&resource=https://mcp.trace-flow.dev/mcp',
        },
        ctx,
      );

      expect(res.status).toBe(200);
      expect((await res.json()).refresh_token).toBe('sibling-token-id');
      expect(fetchSpy).not.toHaveBeenCalled();
      fetchSpy.mockRestore();
    });

    it('returns a JSON OAuth error when refreshed access-token signing fails', async () => {
      const app = createApp(deps);
      ctx.runQuery.mockResolvedValue({
        userId: 'user123',
        clientId: 'client-1',
        resource: 'https://mcp.trace-flow.dev/mcp',
        auth0RefreshToken: '',
      });
      ctx.runMutation.mockResolvedValue({
        userId: 'user123',
        tokenId: 'rotated-token-id',
        resource: 'https://mcp.trace-flow.dev/mcp',
      });
      (deps.tokens.createAccessToken as Mock).mockRejectedValue(new Error('missing key'));

      const res = await app.request(
        'http://localhost/mcp/token',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'grant_type=refresh_token&refresh_token=token-id&client_id=client-1&resource=https://mcp.trace-flow.dev/mcp',
        },
        ctx,
      );

      expect(res.status).toBe(500);
      expect(res.headers.get('Content-Type')).toContain('application/json');
      await expect(res.json()).resolves.toEqual({
        error: 'server_error',
        error_description: 'Internal server error',
      });
    });
  });
});
