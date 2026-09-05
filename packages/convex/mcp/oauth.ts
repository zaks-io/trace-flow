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
  tokenUse?: 'mcp_state';
  clientState: string;
  clientId?: string;
  redirectUri: string;
  resource?: string;
  codeChallenge?: string;
  codeChallengeMethod?: string;
}

export interface ConsentPayload {
  tokenUse: 'mcp_consent';
  clientState: string;
  clientId: string;
  redirectUri: string;
  resource: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  responseType?: string;
}

export interface ArchiveSessionPayload {
  tokenUse: 'archive_session';
  userId: string;
  orgId: string;
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

interface Auth0ClientConfig {
  domain: string;
  clientId: string;
  clientSecret: string;
}

function getAuth0ClientConfig(): Auth0ClientConfig {
  const domain = process.env.AUTH0_DOMAIN;
  const clientId = process.env.AUTH0_CLIENT_ID;
  const clientSecret = process.env.AUTH0_CLIENT_SECRET;

  if (!domain || !clientId || !clientSecret) {
    throw new Error('Auth0 configuration missing');
  }

  return { domain, clientId, clientSecret };
}

async function requestAuth0Token(
  params: Record<string, string>,
  failureLabel: string,
): Promise<Auth0TokenResponse> {
  const { domain, clientId, clientSecret } = getAuth0ClientConfig();
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    ...params,
  });

  const response = await fetchWithTimeout(`https://${domain}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Auth0 token ${failureLabel} failed: ${response.status} - ${text}`);
  }

  return response.json();
}

export async function exchangeAuth0Code(
  code: string,
  redirectUri: string,
): Promise<Auth0TokenResponse> {
  return requestAuth0Token(
    {
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
    },
    'exchange',
  );
}

export async function refreshAuth0Token(refreshToken: string): Promise<Auth0TokenResponse> {
  return requestAuth0Token(
    {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    },
    'refresh',
  );
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

  return new SignJWT({ ...payload, tokenUse: 'mcp_state' })
    .setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('5m')
    .setIssuedAt()
    .sign(secretKey);
}

export async function signConsent(payload: Omit<ConsentPayload, 'tokenUse'>): Promise<string> {
  const secret = process.env.MCP_JWT_SECRET;

  if (!secret) {
    throw new Error('MCP_JWT_SECRET not configured');
  }

  const secretKey = new TextEncoder().encode(secret);

  return new SignJWT({ ...payload, tokenUse: 'mcp_consent' })
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
    if (!isStatePayload(payload)) return null;
    return {
      ...(payload.tokenUse === undefined ? {} : { tokenUse: payload.tokenUse }),
      clientState: payload.clientState,
      ...(payload.clientId === undefined ? {} : { clientId: payload.clientId }),
      redirectUri: payload.redirectUri,
      ...(payload.resource === undefined ? {} : { resource: payload.resource }),
      ...(payload.codeChallenge === undefined ? {} : { codeChallenge: payload.codeChallenge }),
      ...(payload.codeChallengeMethod === undefined
        ? {}
        : { codeChallengeMethod: payload.codeChallengeMethod }),
    };
  } catch {
    return null;
  }
}

function isStatePayload(payload: unknown): payload is StatePayload {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return false;
  const value = payload as Partial<StatePayload>;
  return (
    (value.tokenUse === undefined || value.tokenUse === 'mcp_state') &&
    typeof value.clientState === 'string' &&
    (value.clientId === undefined || typeof value.clientId === 'string') &&
    typeof value.redirectUri === 'string' &&
    (value.resource === undefined || typeof value.resource === 'string') &&
    (value.codeChallenge === undefined || typeof value.codeChallenge === 'string') &&
    (value.codeChallengeMethod === undefined || typeof value.codeChallengeMethod === 'string')
  );
}

function isConsentPayload(payload: unknown): payload is ConsentPayload {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return false;
  const value = payload as Partial<ConsentPayload>;
  return (
    value.tokenUse === 'mcp_consent' &&
    typeof value.clientState === 'string' &&
    typeof value.clientId === 'string' &&
    typeof value.redirectUri === 'string' &&
    typeof value.resource === 'string' &&
    typeof value.codeChallenge === 'string' &&
    typeof value.codeChallengeMethod === 'string' &&
    (value.responseType === undefined || typeof value.responseType === 'string')
  );
}

export async function signArchiveSession(
  payload: Omit<ArchiveSessionPayload, 'tokenUse'>,
): Promise<string> {
  const secret = process.env.MCP_JWT_SECRET;

  if (!secret) {
    throw new Error('MCP_JWT_SECRET not configured');
  }

  const secretKey = new TextEncoder().encode(secret);

  return new SignJWT({ ...payload, tokenUse: 'archive_session' })
    .setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('10m')
    .setIssuedAt()
    .sign(secretKey);
}

function isArchiveSessionPayload(payload: unknown): payload is ArchiveSessionPayload {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return false;
  const value = payload as Partial<ArchiveSessionPayload>;
  return (
    value.tokenUse === 'archive_session' &&
    typeof value.userId === 'string' &&
    typeof value.orgId === 'string'
  );
}

export async function verifyArchiveSession(token: string): Promise<ArchiveSessionPayload | null> {
  const secret = process.env.MCP_JWT_SECRET;

  if (!secret) {
    throw new Error('MCP_JWT_SECRET not configured');
  }

  const secretKey = new TextEncoder().encode(secret);

  try {
    const { payload } = await jwtVerify(token, secretKey);
    if (!isArchiveSessionPayload(payload)) return null;
    return {
      tokenUse: payload.tokenUse,
      userId: payload.userId,
      orgId: payload.orgId,
    };
  } catch {
    return null;
  }
}

export async function verifyConsent(token: string): Promise<ConsentPayload | null> {
  const secret = process.env.MCP_JWT_SECRET;

  if (!secret) {
    throw new Error('MCP_JWT_SECRET not configured');
  }

  const secretKey = new TextEncoder().encode(secret);

  try {
    const { payload } = await jwtVerify(token, secretKey);
    if (!isConsentPayload(payload)) return null;
    return {
      tokenUse: payload.tokenUse,
      clientState: payload.clientState,
      clientId: payload.clientId,
      redirectUri: payload.redirectUri,
      resource: payload.resource,
      codeChallenge: payload.codeChallenge,
      codeChallengeMethod: payload.codeChallengeMethod,
      ...(payload.responseType === undefined ? {} : { responseType: payload.responseType }),
    };
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
