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
  consentNonce?: string;
  clientState: string;
  clientId?: string;
  redirectUri: string;
  resource?: string;
  codeChallenge?: string;
  codeChallengeMethod?: string;
}

export interface ConsentPayload {
  tokenUse: 'mcp_consent';
  consentNonce: string;
  clientState: string;
  clientId: string;
  redirectUri: string;
  resource: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  responseType?: string;
}

/** What a user approved on the Collector consent page, bound to that page's browser by a nonce. */
export interface CollectorConsentPayload {
  tokenUse: 'collector_consent';
  consentNonce: string;
  clientState: string;
  redirectUri: string;
  codeChallenge?: string;
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
  issuer: string;
  clientId: string;
  clientSecret: string;
}

/**
 * The Auth0 issuer URL, ending in `/`. Deployments set `AUTH0_DOMAIN` to the tenant's host; the
 * local stack sets its mock issuer's full URL, which Convex auth also accepts.
 */
export function auth0Issuer(): string {
  const domain = process.env.AUTH0_DOMAIN;
  if (!domain) {
    throw new Error('AUTH0_DOMAIN not configured');
  }
  const issuer = /^https?:\/\//.test(domain) ? domain : `https://${domain}`;
  return issuer.endsWith('/') ? issuer : `${issuer}/`;
}

function getAuth0ClientConfig(): Auth0ClientConfig {
  const clientId = process.env.AUTH0_CLIENT_ID;
  const clientSecret = process.env.AUTH0_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error('Auth0 configuration missing');
  }

  return { issuer: auth0Issuer(), clientId, clientSecret };
}

async function requestAuth0Token(
  params: Record<string, string>,
  failureLabel: string,
): Promise<Auth0TokenResponse> {
  const { issuer, clientId, clientSecret } = getAuth0ClientConfig();
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    ...params,
  });

  const response = await fetchWithTimeout(`${issuer}oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!response.ok) {
    throw new Error(`Auth0 token ${failureLabel} failed with status ${response.status}`);
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

export async function getAuth0UserInfo(accessToken: string): Promise<Auth0UserInfo> {
  const response = await fetchWithTimeout(`${auth0Issuer()}userinfo`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok) {
    throw new Error(`Auth0 userinfo failed with status ${response.status}`);
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

export async function signCollectorConsent(
  payload: Omit<CollectorConsentPayload, 'tokenUse'>,
): Promise<string> {
  const secret = process.env.MCP_JWT_SECRET;

  if (!secret) {
    throw new Error('MCP_JWT_SECRET not configured');
  }

  return new SignJWT({ ...payload, tokenUse: 'collector_consent' })
    .setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('5m')
    .setIssuedAt()
    .sign(new TextEncoder().encode(secret));
}

export async function verifyCollectorConsent(
  token: string,
): Promise<CollectorConsentPayload | null> {
  const secret = process.env.MCP_JWT_SECRET;

  if (!secret) {
    throw new Error('MCP_JWT_SECRET not configured');
  }

  try {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(secret), {
      algorithms: ['HS256'],
    });
    const value = payload as Partial<CollectorConsentPayload>;
    if (
      value.tokenUse !== 'collector_consent' ||
      typeof value.consentNonce !== 'string' ||
      typeof value.clientState !== 'string' ||
      typeof value.redirectUri !== 'string' ||
      (value.codeChallenge !== undefined && typeof value.codeChallenge !== 'string')
    ) {
      return null;
    }
    return {
      tokenUse: value.tokenUse,
      consentNonce: value.consentNonce,
      clientState: value.clientState,
      redirectUri: value.redirectUri,
      ...(value.codeChallenge === undefined ? {} : { codeChallenge: value.codeChallenge }),
    };
  } catch {
    return null;
  }
}

export async function verifyState(token: string): Promise<StatePayload | null> {
  const secret = process.env.MCP_JWT_SECRET;

  if (!secret) {
    throw new Error('MCP_JWT_SECRET not configured');
  }

  const secretKey = new TextEncoder().encode(secret);

  try {
    const { payload } = await jwtVerify(token, secretKey, { algorithms: ['HS256'] });
    if (!isStatePayload(payload)) return null;
    return {
      ...(payload.tokenUse === undefined ? {} : { tokenUse: payload.tokenUse }),
      ...(payload.consentNonce === undefined ? {} : { consentNonce: payload.consentNonce }),
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
    (value.consentNonce === undefined || typeof value.consentNonce === 'string') &&
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
    typeof value.consentNonce === 'string' &&
    typeof value.clientState === 'string' &&
    typeof value.clientId === 'string' &&
    typeof value.redirectUri === 'string' &&
    typeof value.resource === 'string' &&
    typeof value.codeChallenge === 'string' &&
    typeof value.codeChallengeMethod === 'string' &&
    (value.responseType === undefined || typeof value.responseType === 'string')
  );
}

export async function verifyConsent(token: string): Promise<ConsentPayload | null> {
  const secret = process.env.MCP_JWT_SECRET;

  if (!secret) {
    throw new Error('MCP_JWT_SECRET not configured');
  }

  const secretKey = new TextEncoder().encode(secret);

  try {
    const { payload } = await jwtVerify(token, secretKey, { algorithms: ['HS256'] });
    if (!isConsentPayload(payload)) return null;
    return {
      tokenUse: payload.tokenUse,
      consentNonce: payload.consentNonce,
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
  const issuer = auth0Issuer();
  const clientId = process.env.AUTH0_CLIENT_ID;

  if (!clientId) {
    throw new Error('Auth0 configuration missing');
  }

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: 'openid profile email offline_access',
    state,
  });

  return `${issuer}authorize?${params.toString()}`;
}
