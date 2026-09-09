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
        authorization_response_iss_parameter_supported: true,
        scopes_supported: ['openid', 'profile', 'email'],
      });
    });

    it('uses request origin for endpoint URLs', async () => {
      const app = createApp(deps);
      const res = await app.request(
        'https://connect.trace-flow.dev/.well-known/oauth-authorization-server',
        {},
        ctx,
      );

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.issuer).toBe('https://connect.trace-flow.dev');
      expect(json.authorization_endpoint).toBe('https://connect.trace-flow.dev/mcp/authorize');
    });

    it('does not advertise the production Convex site as an authorization server', async () => {
      const app = createApp(deps);
      const res = await app.request(
        'https://laudable-bison-427.convex.site/.well-known/oauth-authorization-server',
        {},
        ctx,
      );

      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'forbidden_host' });
    });
  });

  describe('POST /mcp/register', () => {
    it('rejects the production Convex site host that bypasses the Connect edge', async () => {
      const app = createApp(deps);
      const res = await app.request(
        'https://laudable-bison-427.convex.site/mcp/register',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ redirect_uris: ['https://example.com/callback'] }),
        },
        ctx,
      );

      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'forbidden_host' });
      expect(ctx.runMutation).not.toHaveBeenCalled();
    });

    it('registers client with valid redirect_uris', async () => {
      const app = createApp(deps);
      ctx.runMutation.mockResolvedValue({ ok: true });

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

    it('requires JSON content type for registration', async () => {
      const app = createApp(deps);
      const res = await app.request(
        'http://localhost/mcp/register',
        {
          method: 'POST',
          body: JSON.stringify({ redirect_uris: ['https://example.com/callback'] }),
        },
        ctx,
      );

      expect(res.status).toBe(415);
      expect((await res.json()).error_description).toBe('Content-Type must be application/json');
    });

    it('returns 413 for an oversized registration', async () => {
      const app = createApp(deps);
      const res = await app.request(
        'http://localhost/mcp/register',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            redirect_uris: ['https://example.com/callback'],
            client_name: 'x'.repeat(33 * 1024),
          }),
        },
        ctx,
      );

      expect(res.status).toBe(413);
      expect((await res.json()).error).toBe('invalid_client_metadata');
      expect(ctx.runMutation).not.toHaveBeenCalled();
    });

    it('returns 429 when the registration write limit is exhausted', async () => {
      const app = createApp(deps);
      ctx.runMutation.mockResolvedValue({ ok: false, retryAfter: 2500 });

      const res = await app.request(
        'http://localhost/mcp/register',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ redirect_uris: ['https://example.com/callback'] }),
        },
        ctx,
      );

      expect(res.status).toBe(429);
      expect(res.headers.get('Retry-After')).toBe('3');
      expect((await res.json()).error).toBe('temporarily_unavailable');
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
        'http://localhost/mcp/authorize?response_type=code&client_id=client-1&redirect_uri=https://example.com/callback&resource=https://mcp.trace-flow.dev/mcp&state=client-state&code_challenge=0123456789012345678901234567890123456789012&code_challenge_method=S256&consent_token=signed-consent',
        { headers: { Cookie: '__Host-trace-flow-mcp-consent=browser-nonce' } },
        ctx,
      );

      // Must be a 200, not a 302: the consent form's CSP (`form-action 'self'`) blocks
      // cross-origin redirects on the form-submission chain in Chrome.
      expect(res.status).toBe(200);
      expect(res.headers.get('Location')).toBeNull();
      const html = await res.text();
      expect(html).toContain('https://test.auth0.com/authorize?state=signed-state-token');
      expect(deps.oauth.signState).toHaveBeenCalledWith({
        consentNonce: 'browser-nonce',
        clientState: 'client-state',
        clientId: 'client-1',
        redirectUri: 'https://example.com/callback',
        resource: 'https://mcp.trace-flow.dev/mcp',
        codeChallenge: '0123456789012345678901234567890123456789012',
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
        'http://localhost/mcp/authorize?client_id=client-1&redirect_uri=https://example.com/callback&resource=https://mcp.trace-flow.dev/mcp&code_challenge=0123456789012345678901234567890123456789012&code_challenge_method=S256&consent_token=signed-consent',
        { headers: { Cookie: '__Host-trace-flow-mcp-consent=browser-nonce' } },
        ctx,
      );

      expect(deps.oauth.signState).toHaveBeenCalledWith({
        consentNonce: 'browser-nonce',
        clientState: '',
        clientId: 'client-1',
        redirectUri: 'https://example.com/callback',
        resource: 'https://mcp.trace-flow.dev/mcp',
        codeChallenge: '0123456789012345678901234567890123456789012',
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
        'http://localhost/mcp/authorize?response_type=code&client_id=client-1&redirect_uri=https://example.com/callback&resource=https://mcp.trace-flow.dev/mcp&state=client-state&code_challenge=0123456789012345678901234567890123456789012&code_challenge_method=S256',
        {},
        ctx,
      );

      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toContain('text/html');
      expect(res.headers.get('Cache-Control')).toContain('no-store');
      expect(res.headers.get('Set-Cookie')).toContain('__Host-trace-flow-mcp-consent=');
      expect(res.headers.get('Set-Cookie')).toContain('HttpOnly');
      expect(res.headers.get('Set-Cookie')).toContain('Secure');
      expect(res.headers.get('Set-Cookie')).toContain('SameSite=Lax');
      expect(res.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
      expect(res.headers.get('X-Frame-Options')).toBe('DENY');
      const html = await res.text();
      expect(html).toContain('Local MCP Client');
      expect(html).toContain('https://example.com/callback');
      expect(html).toContain('https://mcp.trace-flow.dev/mcp');
      expect(html).toContain('name="consent_token" value="signed-consent"');
      expect(deps.oauth.signConsent).toHaveBeenCalledWith({
        consentNonce: expect.any(String),
        clientState: 'client-state',
        clientId: 'client-1',
        redirectUri: 'https://example.com/callback',
        resource: 'https://mcp.trace-flow.dev/mcp',
        codeChallenge: '0123456789012345678901234567890123456789012',
        codeChallengeMethod: 'S256',
        responseType: 'code',
      });
      expect(deps.oauth.signState).not.toHaveBeenCalled();
      expect(deps.oauth.buildAuth0AuthorizeUrl).not.toHaveBeenCalled();
    });

    it('does not accept a consent token replayed in another browser', async () => {
      const app = createApp(deps);
      ctx.runQuery.mockResolvedValue({
        clientId: 'client-1',
        redirectUris: ['https://example.com/callback'],
      });
      (deps.oauth.verifyConsent as Mock).mockResolvedValue(acceptedConsent);
      (deps.oauth.signConsent as Mock).mockResolvedValue('replacement-consent');

      const res = await app.request(
        'http://localhost/mcp/authorize?response_type=code&client_id=client-1&redirect_uri=https://example.com/callback&resource=https://mcp.trace-flow.dev/mcp&state=client-state&code_challenge=0123456789012345678901234567890123456789012&code_challenge_method=S256&consent_token=stolen-consent',
        {},
        ctx,
      );

      expect(res.status).toBe(200);
      expect(await res.text()).toContain('name="consent_token" value="replacement-consent"');
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
        'http://localhost/mcp/authorize?response_type=code&client_id=client-1&redirect_uri=https://example.com/callback&resource=https://mcp.trace-flow.dev/mcp&state=client-state&code_challenge=0123456789012345678901234567890123456789012&code_challenge_method=S256&consent=accepted',
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
        'http://localhost/mcp/authorize?client_id=client-1&redirect_uri=https://evil.example/callback&resource=https://mcp.trace-flow.dev/mcp&code_challenge=0123456789012345678901234567890123456789012&code_challenge_method=S256',
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
        'http://localhost/mcp/authorize?client_id=client-1&redirect_uri=https://example.com/callback&resource=https://mcp.trace-flow.dev/mcp',
        {},
        ctx,
      );

      expect(res.status).toBe(400);
      expect((await res.json()).error_description).toBe('PKCE code_challenge_method must be S256');
    });

    it('rejects a malformed S256 PKCE challenge', async () => {
      const app = createApp(deps);
      ctx.runQuery.mockResolvedValue({
        clientId: 'client-1',
        redirectUris: ['https://example.com/callback'],
      });

      const res = await app.request(
        'http://localhost/mcp/authorize?client_id=client-1&redirect_uri=https://example.com/callback&resource=https://mcp.trace-flow.dev/mcp&code_challenge=short&code_challenge_method=S256',
        {},
        ctx,
      );

      expect(res.status).toBe(400);
      expect((await res.json()).error_description).toBe(
        'code_challenge must be a valid S256 PKCE challenge',
      );
      expect(deps.oauth.signConsent).not.toHaveBeenCalled();
    });

    it('rejects a resource outside the Trace Flow MCP deployment allowlist', async () => {
      const app = createApp(deps);
      ctx.runQuery.mockResolvedValue({
        clientId: 'client-1',
        redirectUris: ['https://example.com/callback'],
      });

      const res = await app.request(
        'http://localhost/mcp/authorize?client_id=client-1&redirect_uri=https://example.com/callback&resource=https://evil.example/mcp&code_challenge=0123456789012345678901234567890123456789012&code_challenge_method=S256',
        {},
        ctx,
      );

      expect(res.status).toBe(400);
      expect((await res.json()).error_description).toBe(
        'resource must identify a Trace Flow MCP endpoint',
      );
      expect(deps.oauth.signConsent).not.toHaveBeenCalled();
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
        consentNonce: 'browser-nonce',
        clientState: 'original-state',
        clientId: 'client-1',
        redirectUri: 'https://example.com/callback',
        resource: 'https://mcp.trace-flow.dev/mcp',
        codeChallenge: '0123456789012345678901234567890123456789012',
        codeChallengeMethod: 'S256',
      });
      (deps.oauth.exchangeAuth0Code as Mock).mockResolvedValue({
        access_token: 'auth0-access-token',
        refresh_token: 'auth0-refresh-token',
      });
      (deps.oauth.getAuth0UserInfo as Mock).mockResolvedValue({
        sub: 'auth0|123',
        email: 'test@example.com',
        email_verified: true,
        name: 'Test User',
      });
      ctx.runMutation
        .mockResolvedValueOnce('user-id-123') // findOrCreateUser
        .mockResolvedValueOnce('auth-code-456'); // createAuthCode

      const res = await app.request(
        'http://localhost/mcp/callback?code=auth0-code&state=state-token',
        { headers: { Cookie: '__Host-trace-flow-mcp-consent=browser-nonce' } },
        ctx,
      );

      expect(res.status).toBe(302);
      const location = res.headers.get('Location');
      expect(location).toContain('https://example.com/callback');
      expect(location).toContain('code=auth-code-456');
      expect(location).toContain('state=original-state');
      expect(location).toContain('iss=http%3A%2F%2Flocalhost');
      expect(res.headers.get('Set-Cookie')).toContain('Max-Age=0');
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
        consentNonce: 'browser-nonce',
        clientState: '',
        redirectUri: 'https://example.com/callback',
      });
      (deps.oauth.exchangeAuth0Code as Mock).mockRejectedValue(new Error('Auth0 error'));

      const res = await app.request(
        'http://localhost/mcp/callback?code=code&state=state',
        { headers: { Cookie: '__Host-trace-flow-mcp-consent=browser-nonce' } },
        ctx,
      );

      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.error).toBe('Auth0 token exchange failed');
      expect(json).not.toHaveProperty('details');
    });

    it('returns 400 when user email is missing', async () => {
      const app = createApp(deps);
      (deps.oauth.verifyState as Mock).mockResolvedValue({
        consentNonce: 'browser-nonce',
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

      const res = await app.request(
        'http://localhost/mcp/callback?code=code&state=state',
        { headers: { Cookie: '__Host-trace-flow-mcp-consent=browser-nonce' } },
        ctx,
      );

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBe('Email is required');
    });

    it('rejects an unverified Auth0 email before creating an MCP user', async () => {
      const app = createApp(deps);
      (deps.oauth.verifyState as Mock).mockResolvedValue({
        consentNonce: 'browser-nonce',
        clientState: 'original-state',
        clientId: 'client-1',
        redirectUri: 'https://example.com/callback',
        resource: 'https://mcp.trace-flow.dev/mcp',
        codeChallenge: '0123456789012345678901234567890123456789012',
        codeChallengeMethod: 'S256',
      });
      (deps.oauth.exchangeAuth0Code as Mock).mockResolvedValue({ access_token: 'token' });
      (deps.oauth.getAuth0UserInfo as Mock).mockResolvedValue({
        sub: 'auth0|123',
        email: 'test@example.com',
        email_verified: false,
      });

      const res = await app.request(
        'http://localhost/mcp/callback?code=code&state=state',
        { headers: { Cookie: '__Host-trace-flow-mcp-consent=browser-nonce' } },
        ctx,
      );

      expect(res.status).toBe(403);
      await expect(res.json()).resolves.toEqual({
        error: 'A verified email address is required',
      });
      expect(ctx.runMutation).not.toHaveBeenCalled();
    });

    it('rejects an Auth0 callback replayed in another browser', async () => {
      const app = createApp(deps);
      (deps.oauth.verifyState as Mock).mockResolvedValue({
        consentNonce: 'attacker-browser-nonce',
        clientState: 'attacker-state',
        clientId: 'client-1',
        redirectUri: 'https://example.com/callback',
        resource: 'https://mcp.trace-flow.dev/mcp',
        codeChallenge: '0123456789012345678901234567890123456789012',
        codeChallengeMethod: 'S256',
      });

      const res = await app.request(
        'http://localhost/mcp/callback?code=victim-auth0-code&state=attacker-state-token',
        {},
        ctx,
      );

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'Invalid or expired state' });
      expect(deps.oauth.exchangeAuth0Code).not.toHaveBeenCalled();
      expect(ctx.runMutation).not.toHaveBeenCalled();
    });
  });

  describe('POST /mcp/token - authorization_code grant', () => {
    it('returns tokens on successful code exchange', async () => {
      const app = createApp(deps);
      ctx.runMutation.mockResolvedValue({
        userId: 'user123',
        tokenId: 'token456',
        resource: 'https://mcp.trace-flow.dev/mcp',
      });
      (deps.tokens.createAccessToken as Mock).mockResolvedValue('jwt-access-token');

      const res = await app.request(
        'http://localhost/mcp/token',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'grant_type=authorization_code&code=auth-code&client_id=client-1&redirect_uri=https://example.com/callback&resource=https://mcp.trace-flow.dev/mcp&code_verifier=0123456789012345678901234567890123456789012',
        },
        ctx,
      );

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.access_token).toBe('jwt-access-token');
      expect(json.token_type).toBe('Bearer');
      expect(json.expires_in).toBe(3600);
      expect(json.refresh_token).toBe('token456');
      expect(res.headers.get('Cache-Control')).toBe('no-store');
      expect(res.headers.get('Pragma')).toBe('no-cache');
      expect(deps.tokens.createAccessToken).toHaveBeenCalledWith(
        'user123',
        'token456',
        'http://localhost',
        'https://mcp.trace-flow.dev/mcp',
      );
    });

    it('returns a JSON OAuth error when access-token signing fails', async () => {
      const app = createApp(deps);
      ctx.runMutation.mockResolvedValue({
        userId: 'user123',
        tokenId: 'token456',
        resource: 'https://mcp.trace-flow.dev/mcp',
      });
      (deps.tokens.createAccessToken as Mock).mockRejectedValue(new Error('missing key'));

      const res = await app.request(
        'http://localhost/mcp/token',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'grant_type=authorization_code&code=auth-code&client_id=client-1&redirect_uri=https://example.com/callback&resource=https://mcp.trace-flow.dev/mcp&code_verifier=0123456789012345678901234567890123456789012',
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
          body: 'grant_type=authorization_code&code=auth-code&client_id=client-1&resource=https://mcp.trace-flow.dev/mcp&code_verifier=0123456789012345678901234567890123456789012',
        },
        ctx,
      );

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBe('invalid_request');
      expect(json.error_description).toBe('redirect_uri is required');
    });

    it('rejects a malformed PKCE verifier before consuming the code', async () => {
      const app = createApp(deps);

      const res = await app.request(
        'http://localhost/mcp/token',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'grant_type=authorization_code&code=auth-code&client_id=client-1&redirect_uri=https://example.com/callback&resource=https://mcp.trace-flow.dev/mcp&code_verifier=short',
        },
        ctx,
      );

      expect(res.status).toBe(400);
      expect((await res.json()).error_description).toBe(
        'code_verifier must be a valid PKCE verifier',
      );
      expect(ctx.runMutation).not.toHaveBeenCalled();
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
          body: 'grant_type=authorization_code&code=used-code&client_id=client-1&redirect_uri=https://example.com/callback&resource=https://mcp.trace-flow.dev/mcp&code_verifier=0123456789012345678901234567890123456789012',
        },
        ctx,
      );

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBe('invalid_grant');
    });

    it('rejects an authorization-code exchange for an unowned resource audience', async () => {
      const app = createApp(deps);
      const res = await app.request(
        'http://localhost/mcp/token',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'grant_type=authorization_code&code=auth-code&client_id=client-1&redirect_uri=https://example.com/callback&resource=https://evil.example/mcp&code_verifier=0123456789012345678901234567890123456789012',
        },
        ctx,
      );

      expect(res.status).toBe(400);
      expect((await res.json()).error_description).toBe(
        'resource must identify a Trace Flow MCP endpoint',
      );
      expect(ctx.runMutation).not.toHaveBeenCalled();
    });
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
      (deps.oauth.refreshAuth0Token as Mock).mockResolvedValue({
        refresh_token: 'new-auth0-refresh',
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
      expect(ctx.runMutation).toHaveBeenNthCalledWith(
        1,
        expect.anything(),
        expect.objectContaining({
          tokenId: 'token-id',
          clientId: 'client-1',
          resource: 'https://mcp.trace-flow.dev/mcp',
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

    it('returns 401 for invalid refresh token', async () => {
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

      expect(res.status).toBe(401);
      const json = await res.json();
      expect(json.error).toBe('invalid_grant');
    });

    it('handles Auth0 refresh failure gracefully', async () => {
      const app = createApp(deps);
      ctx.runQuery.mockResolvedValue({
        userId: 'user123',
        clientId: 'client-1',
        resource: 'https://mcp.trace-flow.dev/mcp',
        auth0RefreshToken: 'auth0-refresh',
      });
      (deps.oauth.refreshAuth0Token as Mock).mockRejectedValue(new Error('Auth0 error'));
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

      // Should still succeed - Auth0 refresh failure is non-fatal
      expect(res.status).toBe(200);
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

    it('returns 413 for an oversized token request', async () => {
      const app = createApp(deps);
      const res = await app.request(
        'http://localhost/mcp/token',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: `grant_type=client_credentials&padding=${'x'.repeat(16 * 1024)}`,
        },
        ctx,
      );

      expect(res.status).toBe(413);
      expect((await res.json()).error_description).toBe('Request body is too large');
    });
  });
});
