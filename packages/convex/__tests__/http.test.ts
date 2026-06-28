import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';

vi.mock('../rateLimits', () => ({
  rateLimiter: {
    limit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
  },
}));

import { createApp, type HttpDeps } from '../http';

// Type for mock Convex ActionCtx
interface MockCtx {
  runMutation: Mock;
  runQuery: Mock;
  runAction: Mock;
}

// Factory for creating mock Convex context
function createMockCtx(): MockCtx {
  return {
    runMutation: vi.fn(),
    runQuery: vi.fn(),
    runAction: vi.fn(),
  };
}

// Factory for creating mock dependencies
function createMockDeps(): HttpDeps {
  return {
    oauth: {
      signState: vi.fn(),
      verifyState: vi.fn(),
      signConsent: vi.fn(),
      verifyConsent: vi.fn(),
      buildAuth0AuthorizeUrl: vi.fn(),
      exchangeAuth0Code: vi.fn(),
      getAuth0UserInfo: vi.fn(),
      refreshAuth0Token: vi.fn(),
    },
    tokens: {
      createAccessToken: vi.fn(),
      validateAccessToken: vi.fn(),
      ACCESS_TOKEN_TTL_SECONDS: 3600,
    } as unknown as HttpDeps['tokens'],
  };
}

describe('convex/http.ts', () => {
  let ctx: MockCtx;
  let deps: HttpDeps;

  const acceptedConsent = {
    tokenUse: 'mcp_consent' as const,
    clientState: 'client-state',
    clientId: 'client-1',
    redirectUri: 'https://example.com/callback',
    resource: 'https://mcp.example.com/mcp',
    codeChallenge: 'challenge123',
    codeChallengeMethod: 'S256',
    responseType: 'code',
  };

  beforeEach(() => {
    vi.stubEnv('AUTH0_DOMAIN', 'test.auth0.com');
    ctx = createMockCtx();
    deps = createMockDeps();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  describe('GET /.well-known/oauth-authorization-server', () => {
    it('returns correct OAuth discovery metadata', async () => {
      const app = createApp(deps);
      const res = await app.request(
        'http://localhost/.well-known/oauth-authorization-server',
        {},
        ctx,
      );

      expect(res.status).toBe(200);
      expect(res.headers.get('Cache-Control')).toBe(
        'public, max-age=3600, stale-while-revalidate=86400',
      );
      const json = await res.json();
      expect(json).toEqual({
        issuer: 'http://localhost',
        authorization_endpoint: 'http://localhost/mcp/authorize',
        token_endpoint: 'http://localhost/mcp/token',
        registration_endpoint: 'http://localhost/mcp/register',
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_methods_supported: ['none'],
        code_challenge_methods_supported: ['S256'],
        scopes_supported: ['openid', 'profile', 'email'],
      });
    });

    it('uses request origin for endpoint URLs', async () => {
      const app = createApp(deps);
      const res = await app.request(
        'https://api.example.com/.well-known/oauth-authorization-server',
        {},
        ctx,
      );

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.issuer).toBe('https://api.example.com');
      expect(json.authorization_endpoint).toBe('https://api.example.com/mcp/authorize');
    });
  });

  describe('POST /mcp/register', () => {
    it('registers client with valid redirect_uris', async () => {
      const app = createApp(deps);
      ctx.runMutation.mockResolvedValue(undefined);

      const res = await app.request(
        'http://localhost/mcp/register',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            redirect_uris: ['https://example.com/callback'],
            client_name: 'Test Client',
          }),
        },
        ctx,
      );

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.client_id).toBeDefined();
      expect(json.redirect_uris).toEqual(['https://example.com/callback']);
      expect(json.client_name).toBe('Test Client');
      expect(json.token_endpoint_auth_method).toBe('none');
      expect(ctx.runMutation).toHaveBeenCalledOnce();
    });

    it('returns 400 for missing redirect_uris', async () => {
      const app = createApp(deps);

      const res = await app.request(
        'http://localhost/mcp/register',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ client_name: 'Test Client' }),
        },
        ctx,
      );

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBe('invalid_redirect_uri');
    });

    it('returns 400 for empty redirect_uris array', async () => {
      const app = createApp(deps);

      const res = await app.request(
        'http://localhost/mcp/register',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ redirect_uris: [] }),
        },
        ctx,
      );

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBe('invalid_redirect_uri');
    });

    it('returns 400 for non-loopback http redirect_uris', async () => {
      const app = createApp(deps);

      const res = await app.request(
        'http://localhost/mcp/register',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ redirect_uris: ['http://example.com/callback'] }),
        },
        ctx,
      );

      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe('invalid_redirect_uri');
    });

    it('returns 400 for invalid JSON', async () => {
      const app = createApp(deps);

      const res = await app.request(
        'http://localhost/mcp/register',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: 'not valid json',
        },
        ctx,
      );

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBe('invalid_client_metadata');
    });
  });

  describe('GET /mcp/authorize', () => {
    it('redirects to Auth0 with signed state', async () => {
      const app = createApp(deps);
      ctx.runQuery.mockResolvedValue({
        clientId: 'client-1',
        redirectUris: ['https://example.com/callback'],
      });
      (deps.oauth.signState as Mock).mockResolvedValue('signed-state-token');
      (deps.oauth.verifyConsent as Mock).mockResolvedValue(acceptedConsent);
      (deps.oauth.buildAuth0AuthorizeUrl as Mock).mockReturnValue(
        'https://test.auth0.com/authorize?state=signed-state-token',
      );

      const res = await app.request(
        'http://localhost/mcp/authorize?response_type=code&client_id=client-1&redirect_uri=https://example.com/callback&resource=https://mcp.example.com/mcp&state=client-state&code_challenge=challenge123&code_challenge_method=S256&consent_token=signed-consent',
        {},
        ctx,
      );

      expect(res.status).toBe(302);
      expect(res.headers.get('Location')).toBe(
        'https://test.auth0.com/authorize?state=signed-state-token',
      );
      expect(deps.oauth.signState).toHaveBeenCalledWith({
        clientState: 'client-state',
        clientId: 'client-1',
        redirectUri: 'https://example.com/callback',
        resource: 'https://mcp.example.com/mcp',
        codeChallenge: 'challenge123',
        codeChallengeMethod: 'S256',
      });
    });

    it('passes PKCE parameters through state', async () => {
      const app = createApp(deps);
      ctx.runQuery.mockResolvedValue({
        clientId: 'client-1',
        redirectUris: ['https://example.com/callback'],
      });
      (deps.oauth.signState as Mock).mockResolvedValue('signed-state');
      (deps.oauth.verifyConsent as Mock).mockResolvedValue({
        ...acceptedConsent,
        clientState: '',
        responseType: undefined,
      });
      (deps.oauth.buildAuth0AuthorizeUrl as Mock).mockReturnValue('https://auth0.com/auth');

      await app.request(
        'http://localhost/mcp/authorize?client_id=client-1&redirect_uri=https://example.com/callback&resource=https://mcp.example.com/mcp&code_challenge=challenge123&code_challenge_method=S256&consent_token=signed-consent',
        {},
        ctx,
      );

      expect(deps.oauth.signState).toHaveBeenCalledWith({
        clientState: '',
        clientId: 'client-1',
        redirectUri: 'https://example.com/callback',
        resource: 'https://mcp.example.com/mcp',
        codeChallenge: 'challenge123',
        codeChallengeMethod: 'S256',
      });
    });

    it('shows explicit consent before redirecting to Auth0', async () => {
      const app = createApp(deps);
      ctx.runQuery.mockResolvedValue({
        clientId: 'client-1',
        clientName: 'Local MCP Client',
        redirectUris: ['https://example.com/callback'],
      });
      (deps.oauth.signConsent as Mock).mockResolvedValue('signed-consent');

      const res = await app.request(
        'http://localhost/mcp/authorize?response_type=code&client_id=client-1&redirect_uri=https://example.com/callback&resource=https://mcp.example.com/mcp&state=client-state&code_challenge=challenge123&code_challenge_method=S256',
        {},
        ctx,
      );

      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toContain('text/html');
      expect(res.headers.get('Cache-Control')).toContain('no-store');
      const html = await res.text();
      expect(html).toContain('Local MCP Client');
      expect(html).toContain('https://example.com/callback');
      expect(html).toContain('https://mcp.example.com/mcp');
      expect(html).toContain('name="consent_token" value="signed-consent"');
      expect(deps.oauth.signConsent).toHaveBeenCalledWith({
        clientState: 'client-state',
        clientId: 'client-1',
        redirectUri: 'https://example.com/callback',
        resource: 'https://mcp.example.com/mcp',
        codeChallenge: 'challenge123',
        codeChallengeMethod: 'S256',
        responseType: 'code',
      });
      expect(deps.oauth.signState).not.toHaveBeenCalled();
      expect(deps.oauth.buildAuth0AuthorizeUrl).not.toHaveBeenCalled();
    });

    it('does not let a client-controlled consent flag skip consent', async () => {
      const app = createApp(deps);
      ctx.runQuery.mockResolvedValue({
        clientId: 'client-1',
        redirectUris: ['https://example.com/callback'],
      });
      (deps.oauth.signConsent as Mock).mockResolvedValue('signed-consent');

      const res = await app.request(
        'http://localhost/mcp/authorize?response_type=code&client_id=client-1&redirect_uri=https://example.com/callback&resource=https://mcp.example.com/mcp&state=client-state&code_challenge=challenge123&code_challenge_method=S256&consent=accepted',
        {},
        ctx,
      );

      expect(res.status).toBe(200);
      expect(await res.text()).toContain('name="consent_token" value="signed-consent"');
      expect(deps.oauth.signState).not.toHaveBeenCalled();
      expect(deps.oauth.buildAuth0AuthorizeUrl).not.toHaveBeenCalled();
    });

    it('rejects unregistered redirect_uri', async () => {
      const app = createApp(deps);
      ctx.runQuery.mockResolvedValue({
        clientId: 'client-1',
        redirectUris: ['https://example.com/callback'],
      });

      const res = await app.request(
        'http://localhost/mcp/authorize?client_id=client-1&redirect_uri=https://evil.example/callback&resource=https://mcp.example.com/mcp&code_challenge=challenge123&code_challenge_method=S256',
        {},
        ctx,
      );

      expect(res.status).toBe(400);
      expect((await res.json()).error_description).toBe('redirect_uri is not registered');
    });

    it('requires S256 PKCE', async () => {
      const app = createApp(deps);
      ctx.runQuery.mockResolvedValue({
        clientId: 'client-1',
        redirectUris: ['https://example.com/callback'],
      });

      const res = await app.request(
        'http://localhost/mcp/authorize?client_id=client-1&redirect_uri=https://example.com/callback&resource=https://mcp.example.com/mcp',
        {},
        ctx,
      );

      expect(res.status).toBe(400);
      expect((await res.json()).error_description).toBe('PKCE code_challenge_method must be S256');
    });

    it('returns 400 for missing redirect_uri', async () => {
      const app = createApp(deps);

      const res = await app.request('http://localhost/mcp/authorize?client_id=client-1', {}, ctx);

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBe('invalid_request');
      expect(json.error_description).toBe('redirect_uri is required');
    });
  });

  describe('GET /mcp/callback', () => {
    it('successfully exchanges code and redirects with auth code', async () => {
      const app = createApp(deps);
      (deps.oauth.verifyState as Mock).mockResolvedValue({
        clientState: 'original-state',
        clientId: 'client-1',
        redirectUri: 'https://example.com/callback',
        resource: 'https://mcp.example.com/mcp',
        codeChallenge: 'challenge123',
        codeChallengeMethod: 'S256',
      });
      (deps.oauth.exchangeAuth0Code as Mock).mockResolvedValue({
        access_token: 'auth0-access-token',
        refresh_token: 'auth0-refresh-token',
      });
      (deps.oauth.getAuth0UserInfo as Mock).mockResolvedValue({
        sub: 'auth0|123',
        email: 'test@example.com',
        name: 'Test User',
      });
      ctx.runMutation
        .mockResolvedValueOnce('user-id-123') // findOrCreateUser
        .mockResolvedValueOnce('auth-code-456'); // createAuthCode

      const res = await app.request(
        'http://localhost/mcp/callback?code=auth0-code&state=state-token',
        {},
        ctx,
      );

      expect(res.status).toBe(302);
      const location = res.headers.get('Location');
      expect(location).toContain('https://example.com/callback');
      expect(location).toContain('code=auth-code-456');
      expect(location).toContain('state=original-state');
    });

    it('returns 400 when Auth0 returns error', async () => {
      const app = createApp(deps);

      const res = await app.request(
        'http://localhost/mcp/callback?error=access_denied&error_description=User%20denied%20access',
        {},
        ctx,
      );

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBe('User denied access');
    });

    it('returns 400 for missing code or state', async () => {
      const app = createApp(deps);

      const res = await app.request('http://localhost/mcp/callback?code=only-code', {}, ctx);

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBe('Missing code or state');
    });

    it('returns 400 for invalid state', async () => {
      const app = createApp(deps);
      (deps.oauth.verifyState as Mock).mockResolvedValue(null);

      const res = await app.request(
        'http://localhost/mcp/callback?code=code&state=invalid-state',
        {},
        ctx,
      );

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBe('Invalid or expired state');
    });

    it('returns 500 when Auth0 token exchange fails', async () => {
      const app = createApp(deps);
      (deps.oauth.verifyState as Mock).mockResolvedValue({
        clientState: '',
        redirectUri: 'https://example.com/callback',
      });
      (deps.oauth.exchangeAuth0Code as Mock).mockRejectedValue(new Error('Auth0 error'));

      const res = await app.request('http://localhost/mcp/callback?code=code&state=state', {}, ctx);

      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.error).toBe('Auth0 token exchange failed');
    });

    it('returns 400 when user email is missing', async () => {
      const app = createApp(deps);
      (deps.oauth.verifyState as Mock).mockResolvedValue({
        clientState: '',
        redirectUri: 'https://example.com/callback',
      });
      (deps.oauth.exchangeAuth0Code as Mock).mockResolvedValue({
        access_token: 'token',
      });
      (deps.oauth.getAuth0UserInfo as Mock).mockResolvedValue({
        sub: 'auth0|123',
        // No email
      });

      const res = await app.request('http://localhost/mcp/callback?code=code&state=state', {}, ctx);

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBe('Email is required');
    });
  });

  describe('POST /mcp/token - authorization_code grant', () => {
    it('returns tokens on successful code exchange', async () => {
      const app = createApp(deps);
      ctx.runMutation.mockResolvedValue({
        userId: 'user123',
        tokenId: 'token456',
        resource: 'https://mcp.example.com/mcp',
      });
      (deps.tokens.createAccessToken as Mock).mockResolvedValue('jwt-access-token');

      const res = await app.request(
        'http://localhost/mcp/token',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'grant_type=authorization_code&code=auth-code&client_id=client-1&redirect_uri=https://example.com/callback&resource=https://mcp.example.com/mcp&code_verifier=verifier',
        },
        ctx,
      );

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.access_token).toBe('jwt-access-token');
      expect(json.token_type).toBe('Bearer');
      expect(json.expires_in).toBe(3600);
      expect(json.refresh_token).toBe('token456');
      expect(deps.tokens.createAccessToken).toHaveBeenCalledWith(
        'user123',
        'token456',
        'http://localhost',
        'https://mcp.example.com/mcp',
      );
    });

    it('returns a JSON OAuth error when access-token signing fails', async () => {
      const app = createApp(deps);
      ctx.runMutation.mockResolvedValue({
        userId: 'user123',
        tokenId: 'token456',
        resource: 'https://mcp.example.com/mcp',
      });
      (deps.tokens.createAccessToken as Mock).mockRejectedValue(new Error('missing key'));

      const res = await app.request(
        'http://localhost/mcp/token',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'grant_type=authorization_code&code=auth-code&client_id=client-1&redirect_uri=https://example.com/callback&resource=https://mcp.example.com/mcp&code_verifier=verifier',
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

    it('returns 400 for missing code', async () => {
      const app = createApp(deps);

      const res = await app.request(
        'http://localhost/mcp/token',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'grant_type=authorization_code&redirect_uri=https://example.com/callback',
        },
        ctx,
      );

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBe('invalid_request');
      expect(json.error_description).toBe('code is required');
    });

    it('returns 400 for missing redirect_uri', async () => {
      const app = createApp(deps);

      const res = await app.request(
        'http://localhost/mcp/token',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'grant_type=authorization_code&code=auth-code&client_id=client-1&resource=https://mcp.example.com/mcp&code_verifier=verifier',
        },
        ctx,
      );

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBe('invalid_request');
      expect(json.error_description).toBe('redirect_uri is required');
    });

    it('returns 400 when code exchange returns error', async () => {
      const app = createApp(deps);
      ctx.runMutation.mockResolvedValue({
        error: 'invalid_grant',
        error_description: 'Code already used',
      });

      const res = await app.request(
        'http://localhost/mcp/token',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'grant_type=authorization_code&code=used-code&client_id=client-1&redirect_uri=https://example.com/callback&resource=https://mcp.example.com/mcp&code_verifier=verifier',
        },
        ctx,
      );

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBe('invalid_grant');
    });
  });

  describe('POST /mcp/token - refresh_token grant', () => {
    it('returns new tokens on successful refresh', async () => {
      const app = createApp(deps);
      ctx.runQuery.mockResolvedValue({
        userId: 'user123',
        clientId: 'client-1',
        resource: 'https://mcp.example.com/mcp',
        auth0RefreshToken: 'auth0-refresh',
      });
      (deps.oauth.refreshAuth0Token as Mock).mockResolvedValue({
        refresh_token: 'new-auth0-refresh',
      });
      ctx.runMutation.mockResolvedValue({
        userId: 'user123',
        tokenId: 'rotated-token-id',
        resource: 'https://mcp.example.com/mcp',
      });
      (deps.tokens.createAccessToken as Mock).mockResolvedValue('new-access-token');

      const res = await app.request(
        'http://localhost/mcp/token',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'grant_type=refresh_token&refresh_token=token-id&client_id=client-1&resource=https://mcp.example.com/mcp',
        },
        ctx,
      );

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.access_token).toBe('new-access-token');
      expect(json.token_type).toBe('Bearer');
      expect(json.refresh_token).toBe('rotated-token-id');
      expect(ctx.runMutation).toHaveBeenNthCalledWith(
        1,
        expect.anything(),
        expect.objectContaining({
          tokenId: 'token-id',
          clientId: 'client-1',
          resource: 'https://mcp.example.com/mcp',
          auth0RefreshToken: 'auth0-refresh',
        }),
      );
      expect(ctx.runMutation).toHaveBeenNthCalledWith(
        2,
        expect.anything(),
        expect.objectContaining({
          tokenId: 'rotated-token-id',
          auth0RefreshToken: 'new-auth0-refresh',
        }),
      );
      expect(deps.tokens.createAccessToken).toHaveBeenCalledWith(
        'user123',
        'rotated-token-id',
        'http://localhost',
        'https://mcp.example.com/mcp',
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

    it('returns 401 for invalid refresh token', async () => {
      const app = createApp(deps);
      ctx.runQuery.mockResolvedValue(null);

      const res = await app.request(
        'http://localhost/mcp/token',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'grant_type=refresh_token&refresh_token=invalid-token&client_id=client-1&resource=https://mcp.example.com/mcp',
        },
        ctx,
      );

      expect(res.status).toBe(401);
      const json = await res.json();
      expect(json.error).toBe('invalid_grant');
    });

    it('handles Auth0 refresh failure gracefully', async () => {
      const app = createApp(deps);
      ctx.runQuery.mockResolvedValue({
        userId: 'user123',
        clientId: 'client-1',
        resource: 'https://mcp.example.com/mcp',
        auth0RefreshToken: 'auth0-refresh',
      });
      (deps.oauth.refreshAuth0Token as Mock).mockRejectedValue(new Error('Auth0 error'));
      ctx.runMutation.mockResolvedValue({
        userId: 'user123',
        tokenId: 'rotated-token-id',
        resource: 'https://mcp.example.com/mcp',
      });
      (deps.tokens.createAccessToken as Mock).mockResolvedValue('new-access-token');

      const res = await app.request(
        'http://localhost/mcp/token',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'grant_type=refresh_token&refresh_token=token-id&client_id=client-1&resource=https://mcp.example.com/mcp',
        },
        ctx,
      );

      // Should still succeed - Auth0 refresh failure is non-fatal
      expect(res.status).toBe(200);
    });

    it('returns a JSON OAuth error when refreshed access-token signing fails', async () => {
      const app = createApp(deps);
      ctx.runQuery.mockResolvedValue({
        userId: 'user123',
        clientId: 'client-1',
        resource: 'https://mcp.example.com/mcp',
        auth0RefreshToken: '',
      });
      ctx.runMutation.mockResolvedValue({
        userId: 'user123',
        tokenId: 'rotated-token-id',
        resource: 'https://mcp.example.com/mcp',
      });
      (deps.tokens.createAccessToken as Mock).mockRejectedValue(new Error('missing key'));

      const res = await app.request(
        'http://localhost/mcp/token',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'grant_type=refresh_token&refresh_token=token-id&client_id=client-1&resource=https://mcp.example.com/mcp',
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

  describe('POST /mcp/token - unsupported grant', () => {
    it('returns 400 for unsupported grant_type', async () => {
      const app = createApp(deps);

      const res = await app.request(
        'http://localhost/mcp/token',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'grant_type=client_credentials',
        },
        ctx,
      );

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBe('unsupported_grant_type');
    });
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
      // raw key resolved server-side and passed to the mint action
      expect(ctx.runAction.mock.calls[0]?.[1]).toMatchObject({
        apiKeys: ['raw-secret-1'],
        orgId: 'org_1',
      });
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
