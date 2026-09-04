import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { createApp, type HttpDeps } from '../http';
import { acceptedConsent, createMockCtx, createMockDeps, type MockCtx } from './httpTest.setup';

describe('convex/http.ts OAuth routes', () => {
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
    it('returns an HTML redirect to Auth0 with signed state', async () => {
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

      // Must be a 200, not a 302: the consent form's CSP (`form-action 'self'`) blocks
      // cross-origin redirects on the form-submission chain in Chrome.
      expect(res.status).toBe(200);
      expect(res.headers.get('Location')).toBeNull();
      const html = await res.text();
      expect(html).toContain('https://test.auth0.com/authorize?state=signed-state-token');
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
});
