import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  exchangeAuth0Code,
  refreshAuth0Token,
  getAuth0UserInfo,
  signArchiveSession,
  signConsent,
  signState,
  verifyArchiveSession,
  verifyConsent,
  verifyState,
  buildAuth0AuthorizeUrl,
  type StatePayload,
} from '../oauth';

describe('exchangeAuth0Code', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.stubEnv('AUTH0_DOMAIN', 'test.auth0.com');
    vi.stubEnv('AUTH0_CLIENT_ID', 'test-client-id');
    vi.stubEnv('AUTH0_CLIENT_SECRET', 'test-client-secret');
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.unstubAllEnvs();
  });

  it('returns tokens on successful exchange', async () => {
    const mockTokens = {
      access_token: 'access-token-123',
      token_type: 'Bearer',
      expires_in: 3600,
      refresh_token: 'refresh-token-456',
    };

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockTokens),
    });

    const result = await exchangeAuth0Code('auth-code', 'https://example.com/callback');

    expect(result).toEqual(mockTokens);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://test.auth0.com/oauth/token',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      }),
    );
  });

  it('throws when AUTH0_DOMAIN is missing', async () => {
    vi.stubEnv('AUTH0_DOMAIN', '');

    await expect(exchangeAuth0Code('code', 'https://example.com/callback')).rejects.toThrow(
      'Auth0 configuration missing',
    );
  });

  it('throws when AUTH0_CLIENT_ID is missing', async () => {
    vi.stubEnv('AUTH0_CLIENT_ID', '');

    await expect(exchangeAuth0Code('code', 'https://example.com/callback')).rejects.toThrow(
      'Auth0 configuration missing',
    );
  });

  it('throws when AUTH0_CLIENT_SECRET is missing', async () => {
    vi.stubEnv('AUTH0_CLIENT_SECRET', '');

    await expect(exchangeAuth0Code('code', 'https://example.com/callback')).rejects.toThrow(
      'Auth0 configuration missing',
    );
  });

  it('throws on non-200 response with error details', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: () => Promise.resolve('Invalid authorization code'),
    });

    await expect(exchangeAuth0Code('invalid-code', 'https://example.com/callback')).rejects.toThrow(
      'Auth0 token exchange failed: 401 - Invalid authorization code',
    );
  });
});

describe('refreshAuth0Token', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.stubEnv('AUTH0_DOMAIN', 'test.auth0.com');
    vi.stubEnv('AUTH0_CLIENT_ID', 'test-client-id');
    vi.stubEnv('AUTH0_CLIENT_SECRET', 'test-client-secret');
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.unstubAllEnvs();
  });

  it('returns new tokens on successful refresh', async () => {
    const mockTokens = {
      access_token: 'new-access-token',
      token_type: 'Bearer',
      expires_in: 3600,
    };

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockTokens),
    });

    const result = await refreshAuth0Token('refresh-token');

    expect(result).toEqual(mockTokens);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://test.auth0.com/oauth/token',
      expect.objectContaining({
        method: 'POST',
      }),
    );
  });

  it('throws when Auth0 config missing', async () => {
    vi.stubEnv('AUTH0_DOMAIN', '');

    await expect(refreshAuth0Token('refresh-token')).rejects.toThrow('Auth0 configuration missing');
  });

  it('throws on non-200 response', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: () => Promise.resolve('Invalid refresh token'),
    });

    await expect(refreshAuth0Token('invalid-refresh-token')).rejects.toThrow(
      'Auth0 token refresh failed: 400 - Invalid refresh token',
    );
  });
});

describe('getAuth0UserInfo', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.stubEnv('AUTH0_DOMAIN', 'test.auth0.com');
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.unstubAllEnvs();
  });

  it('returns user info on success', async () => {
    const mockUserInfo = {
      sub: 'auth0|123456',
      name: 'Test User',
      email: 'test@example.com',
      email_verified: true,
    };

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockUserInfo),
    });

    const result = await getAuth0UserInfo('access-token');

    expect(result).toEqual(mockUserInfo);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://test.auth0.com/userinfo',
      expect.objectContaining({
        headers: { Authorization: 'Bearer access-token' },
      }),
    );
  });

  it('throws when AUTH0_DOMAIN missing', async () => {
    vi.stubEnv('AUTH0_DOMAIN', '');

    await expect(getAuth0UserInfo('access-token')).rejects.toThrow('AUTH0_DOMAIN not configured');
  });

  it('throws on non-200 response', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: () => Promise.resolve('Unauthorized'),
    });

    await expect(getAuth0UserInfo('invalid-token')).rejects.toThrow(
      'Auth0 userinfo failed: 401 - Unauthorized',
    );
  });
});

describe('signState', () => {
  beforeEach(() => {
    vi.stubEnv('MCP_JWT_SECRET', 'test-secret-key-for-signing');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('generates valid JWT string', async () => {
    const payload: StatePayload = {
      clientState: 'client-state-123',
      redirectUri: 'https://example.com/callback',
    };

    const token = await signState(payload);

    expect(typeof token).toBe('string');
    expect(token.split('.')).toHaveLength(3);
  });

  it('includes PKCE params in JWT', async () => {
    const payload: StatePayload = {
      clientState: 'state',
      redirectUri: 'https://example.com/callback',
      codeChallenge: 'challenge-123',
      codeChallengeMethod: 'S256',
    };

    const token = await signState(payload);
    expect(typeof token).toBe('string');
  });

  it('throws when MCP_JWT_SECRET missing', async () => {
    vi.stubEnv('MCP_JWT_SECRET', '');

    const payload: StatePayload = {
      clientState: 'state',
      redirectUri: 'https://example.com/callback',
    };

    await expect(signState(payload)).rejects.toThrow('MCP_JWT_SECRET not configured');
  });
});

describe('verifyState', () => {
  beforeEach(() => {
    vi.stubEnv('MCP_JWT_SECRET', 'test-secret-key-for-signing');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns payload for valid token', async () => {
    const payload: StatePayload = {
      clientState: 'client-state-123',
      redirectUri: 'https://example.com/callback',
    };

    const token = await signState(payload);
    const result = await verifyState(token);

    expect(result).toMatchObject({
      tokenUse: 'mcp_state',
      clientState: 'client-state-123',
      redirectUri: 'https://example.com/callback',
    });
  });

  it('returns null for invalid token', async () => {
    const result = await verifyState('invalid-token');
    expect(result).toBeNull();
  });

  it('returns null for tampered token', async () => {
    const payload: StatePayload = {
      clientState: 'state',
      redirectUri: 'https://example.com/callback',
    };

    const token = await signState(payload);
    const tamperedToken = `${token.slice(0, -5)}XXXXX`;

    const result = await verifyState(tamperedToken);
    expect(result).toBeNull();
  });

  it('rejects consent tokens as state tokens', async () => {
    const token = await signConsent({
      clientState: 'client-state',
      clientId: 'client-1',
      redirectUri: 'https://example.com/callback',
      resource: 'https://mcp.example.com/mcp',
      codeChallenge: 'challenge-123',
      codeChallengeMethod: 'S256',
    });

    await expect(verifyState(token)).resolves.toBeNull();
  });

  it('throws when MCP_JWT_SECRET missing', async () => {
    vi.stubEnv('MCP_JWT_SECRET', '');

    await expect(verifyState('some-token')).rejects.toThrow('MCP_JWT_SECRET not configured');
  });
});

describe('MCP consent tokens', () => {
  beforeEach(() => {
    vi.stubEnv('MCP_JWT_SECRET', 'test-secret-key-for-signing');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('signs and verifies consent payloads', async () => {
    const token = await signConsent({
      clientState: 'client-state',
      clientId: 'client-1',
      redirectUri: 'https://example.com/callback',
      resource: 'https://mcp.example.com/mcp',
      codeChallenge: 'challenge-123',
      codeChallengeMethod: 'S256',
      responseType: 'code',
    });

    await expect(verifyConsent(token)).resolves.toEqual({
      tokenUse: 'mcp_consent',
      clientState: 'client-state',
      clientId: 'client-1',
      redirectUri: 'https://example.com/callback',
      resource: 'https://mcp.example.com/mcp',
      codeChallenge: 'challenge-123',
      codeChallengeMethod: 'S256',
      responseType: 'code',
    });
  });

  it('rejects state tokens as consent tokens', async () => {
    const token = await signState({
      clientState: 'client-state',
      redirectUri: 'https://example.com/callback',
    });

    await expect(verifyConsent(token)).resolves.toBeNull();
  });

  it('returns null for tampered consent tokens', async () => {
    const token = await signConsent({
      clientState: 'client-state',
      clientId: 'client-1',
      redirectUri: 'https://example.com/callback',
      resource: 'https://mcp.example.com/mcp',
      codeChallenge: 'challenge-123',
      codeChallengeMethod: 'S256',
    });

    await expect(verifyConsent(`${token.slice(0, -5)}XXXXX`)).resolves.toBeNull();
  });
});

describe('buildAuth0AuthorizeUrl', () => {
  beforeEach(() => {
    vi.stubEnv('AUTH0_DOMAIN', 'test.auth0.com');
    vi.stubEnv('AUTH0_CLIENT_ID', 'test-client-id');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('builds correct URL with all params', () => {
    const url = buildAuth0AuthorizeUrl('state-token', 'https://example.com/callback');

    expect(url).toContain('https://test.auth0.com/authorize?');
    expect(url).toContain('response_type=code');
    expect(url).toContain('client_id=test-client-id');
    expect(url).toContain('redirect_uri=https%3A%2F%2Fexample.com%2Fcallback');
    expect(url).toContain('state=state-token');
    expect(url).toContain('scope=openid+profile+email+offline_access');
  });

  it('throws when AUTH0_DOMAIN missing', () => {
    vi.stubEnv('AUTH0_DOMAIN', '');

    expect(() => buildAuth0AuthorizeUrl('state', 'https://example.com/callback')).toThrow(
      'Auth0 configuration missing',
    );
  });

  it('throws when AUTH0_CLIENT_ID missing', () => {
    vi.stubEnv('AUTH0_CLIENT_ID', '');

    expect(() => buildAuth0AuthorizeUrl('state', 'https://example.com/callback')).toThrow(
      'Auth0 configuration missing',
    );
  });
});

describe('archive session tokens', () => {
  beforeEach(() => {
    vi.stubEnv('MCP_JWT_SECRET', 'test-secret-key-for-signing');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('round-trips a short-lived archive session that is not an MCP state token', async () => {
    const token = await signArchiveSession({
      userId: 'k57axc8sefsfp6k28nx6c481js806pwv',
      orgId: 'k57axc8sefsfp6k28nx6c481js806pww',
    });
    const session = await verifyArchiveSession(token);
    expect(session).toEqual({
      tokenUse: 'archive_session',
      userId: 'k57axc8sefsfp6k28nx6c481js806pwv',
      orgId: 'k57axc8sefsfp6k28nx6c481js806pww',
    });
    await expect(verifyState(token)).resolves.toBeNull();
    await expect(verifyConsent(token)).resolves.toBeNull();
  });
});
