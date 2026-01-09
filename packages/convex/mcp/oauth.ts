import { SignJWT, jwtVerify } from 'jose';

const FETCH_TIMEOUT_MS = 30000;

export interface Auth0TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token?: string;
  id_token?: string;
  scope?: string;
}

export interface Auth0UserInfo {
  sub: string;
  name?: string;
  email?: string;
  picture?: string;
  email_verified?: boolean;
}

export interface StatePayload {
  clientState: string;
  redirectUri: string;
  codeChallenge?: string;
  codeChallengeMethod?: string;
}

async function fetchWithTimeout(url: string, options: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

export async function exchangeAuth0Code(
  code: string,
  redirectUri: string,
): Promise<Auth0TokenResponse> {
  const domain = process.env.AUTH0_DOMAIN;
  const clientId = process.env.AUTH0_CLIENT_ID;
  const clientSecret = process.env.AUTH0_CLIENT_SECRET;

  if (!domain || !clientId || !clientSecret) {
    throw new Error('Auth0 configuration missing');
  }

  const tokenUrl = `https://${domain}/oauth/token`;

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: clientId,
    client_secret: clientSecret,
    code,
    redirect_uri: redirectUri,
  });

  const response = await fetchWithTimeout(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Auth0 token exchange failed: ${response.status} - ${text}`);
  }

  return response.json();
}

export async function refreshAuth0Token(refreshToken: string): Promise<Auth0TokenResponse> {
  const domain = process.env.AUTH0_DOMAIN;
  const clientId = process.env.AUTH0_CLIENT_ID;
  const clientSecret = process.env.AUTH0_CLIENT_SECRET;

  if (!domain || !clientId || !clientSecret) {
    throw new Error('Auth0 configuration missing');
  }

  const tokenUrl = `https://${domain}/oauth/token`;

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
  });

  const response = await fetchWithTimeout(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Auth0 token refresh failed: ${response.status} - ${text}`);
  }

  return response.json();
}

export async function getAuth0UserInfo(accessToken: string): Promise<Auth0UserInfo> {
  const domain = process.env.AUTH0_DOMAIN;

  if (!domain) {
    throw new Error('AUTH0_DOMAIN not configured');
  }

  const userInfoUrl = `https://${domain}/userinfo`;

  const response = await fetchWithTimeout(userInfoUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Auth0 userinfo failed: ${response.status} - ${text}`);
  }

  return response.json();
}

export async function signState(payload: StatePayload): Promise<string> {
  const secret = process.env.MCP_JWT_SECRET;

  if (!secret) {
    throw new Error('MCP_JWT_SECRET not configured');
  }

  const secretKey = new TextEncoder().encode(secret);

  return new SignJWT(payload as unknown as Record<string, unknown>)
    .setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('5m')
    .setIssuedAt()
    .sign(secretKey);
}

export async function verifyState(token: string): Promise<StatePayload | null> {
  const secret = process.env.MCP_JWT_SECRET;

  if (!secret) {
    throw new Error('MCP_JWT_SECRET not configured');
  }

  const secretKey = new TextEncoder().encode(secret);

  try {
    const { payload } = await jwtVerify(token, secretKey);
    return payload as unknown as StatePayload;
  } catch {
    return null;
  }
}

export function buildAuth0AuthorizeUrl(state: string, redirectUri: string): string {
  const domain = process.env.AUTH0_DOMAIN;
  const clientId = process.env.AUTH0_CLIENT_ID;

  if (!domain || !clientId) {
    throw new Error('Auth0 configuration missing');
  }

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: 'openid profile email offline_access',
    state,
  });

  return `https://${domain}/authorize?${params.toString()}`;
}
