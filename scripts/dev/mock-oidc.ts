/**
 * Local OIDC issuer that stands in for Auth0 in the disposable local stack (local-stack.sh).
 *
 * Web's Auth0 SDK and the local Convex backend both trust this issuer, so a
 * local sign-in produces a real ID token without any Auth0 tenant. It signs any
 * email the user types; `/auth/login?login_hint=<email>` skips the form, which
 * lets agents and browser automation sign in without clicking.
 *
 * Never point a deployed environment at this server: it authenticates anyone.
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const issuer = withTrailingSlash(requireEnv('MOCK_OIDC_ISSUER'));
const clientId = requireEnv('MOCK_OIDC_CLIENT_ID');
const keyPath = requireEnv('MOCK_OIDC_KEY_PATH');
const port = Number(process.env.MOCK_OIDC_PORT ?? new URL(issuer).port);
const defaultEmail = process.env.MOCK_OIDC_DEFAULT_EMAIL ?? 'dev@trace-flow.local';

const ID_TOKEN_TTL_SECONDS = 60 * 60;
const REFRESH_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30;
const CODE_TTL_MS = 2 * 60 * 1000;
const KEY_ID = 'trace-flow-mock-oidc';

interface MockUser {
  sub: string;
  email: string;
  name: string;
}

interface PendingCode {
  user: MockUser;
  redirectUri: string;
  nonce: string | null;
  codeChallenge: string | null;
  scope: string;
  audience: string | null;
  expiresAt: number;
}

const codes = new Map<string, PendingCode>();
const { privateKey, publicJwk } = await loadSigningKey(keyPath);

const discovery = {
  issuer,
  authorization_endpoint: `${issuer}authorize`,
  token_endpoint: `${issuer}oauth/token`,
  userinfo_endpoint: `${issuer}userinfo`,
  jwks_uri: `${issuer}.well-known/jwks.json`,
  end_session_endpoint: `${issuer}oidc/logout`,
  response_types_supported: ['code'],
  grant_types_supported: ['authorization_code', 'refresh_token'],
  subject_types_supported: ['public'],
  id_token_signing_alg_values_supported: ['RS256'],
  token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
  code_challenge_methods_supported: ['S256'],
  scopes_supported: ['openid', 'profile', 'email', 'offline_access'],
  claims_supported: ['sub', 'email', 'email_verified', 'name', 'nickname'],
};

Bun.serve({
  port,
  hostname: '0.0.0.0',
  async fetch(request) {
    const url = new URL(request.url);
    // Convex joins `domain + "/.well-known/..."`, which doubles the slash after the issuer.
    const path = url.pathname.replace(/\/{2,}/g, '/');
    try {
      if (path === '/.well-known/openid-configuration') return Response.json(discovery);
      if (path === '/.well-known/jwks.json') return Response.json({ keys: [publicJwk] });
      if (path === '/authorize' && request.method === 'GET') return authorize(url);
      if (path === '/authorize' && request.method === 'POST') return approve(request);
      if (path === '/oauth/token' && request.method === 'POST') return token(request);
      if (path === '/userinfo') return userinfo(request);
      if (path === '/v2/logout' || path === '/oidc/logout') return logout(url);
      if (path === '/') return new Response(`Trace Flow mock OIDC issuer: ${issuer}\n`);
      return new Response('Not found', { status: 404 });
    } catch (error) {
      console.error('[mock-oidc]', error);
      return Response.json({ error: 'server_error' }, { status: 500 });
    }
  },
});

console.log(`[mock-oidc] issuing for ${clientId} at ${issuer} (listening on :${port})`);

function authorize(url: URL): Response {
  const params = url.searchParams;
  const error = validateAuthorizeParams(params);
  if (error) return new Response(error, { status: 400 });

  const loginHint = params.get('login_hint');
  if (loginHint) return issueCode(params, userFor(loginHint, null));

  return new Response(loginPage(params), {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

async function approve(request: Request): Promise<Response> {
  const form = await request.formData();
  const params = new URLSearchParams(String(form.get('authorize') ?? ''));
  const error = validateAuthorizeParams(params);
  if (error) return new Response(error, { status: 400 });

  const email = String(form.get('email') ?? '').trim();
  if (!email.includes('@')) return new Response('A valid email is required', { status: 400 });
  return issueCode(params, userFor(email, String(form.get('name') ?? '').trim() || null));
}

function validateAuthorizeParams(params: URLSearchParams): string | null {
  if (params.get('client_id') !== clientId) return 'Unknown client_id';
  if (params.get('response_type') !== 'code') return 'Only response_type=code is supported';
  if (!params.get('redirect_uri')) return 'redirect_uri is required';
  return null;
}

function issueCode(params: URLSearchParams, user: MockUser): Response {
  const code = randomBytes(24).toString('base64url');
  codes.set(code, {
    user,
    redirectUri: params.get('redirect_uri')!,
    nonce: params.get('nonce'),
    codeChallenge: params.get('code_challenge'),
    scope: params.get('scope') ?? 'openid',
    audience: params.get('audience'),
    expiresAt: Date.now() + CODE_TTL_MS,
  });

  const redirect = new URL(params.get('redirect_uri')!);
  redirect.searchParams.set('code', code);
  const state = params.get('state');
  if (state) redirect.searchParams.set('state', state);
  return Response.redirect(redirect.toString(), 302);
}

async function token(request: Request): Promise<Response> {
  const form = new URLSearchParams(await request.text());
  const basicClientId = readBasicClientId(request.headers.get('authorization'));
  if ((form.get('client_id') ?? basicClientId) !== clientId) {
    return tokenError('invalid_client', 401);
  }

  const grantType = form.get('grant_type');
  if (grantType === 'authorization_code') {
    const code = form.get('code') ?? '';
    const pending = codes.get(code);
    codes.delete(code);
    if (!pending || pending.expiresAt < Date.now()) return tokenError('invalid_grant');
    if (pending.redirectUri !== form.get('redirect_uri')) return tokenError('invalid_grant');
    if (pending.codeChallenge) {
      const verifier = form.get('code_verifier') ?? '';
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      if (challenge !== pending.codeChallenge) return tokenError('invalid_grant');
    }
    return tokenResponse(pending.user, pending.nonce, pending.scope, pending.audience);
  }

  if (grantType === 'refresh_token') {
    const claims = await verifyJwt(form.get('refresh_token') ?? '');
    if (!claims || claims.typ !== 'refresh') return tokenError('invalid_grant');
    const user = claims.user as MockUser;
    return tokenResponse(user, null, String(claims.scope), (claims.audience as string) ?? null);
  }

  return tokenError('unsupported_grant_type');
}

async function tokenResponse(
  user: MockUser,
  nonce: string | null,
  scope: string,
  audience: string | null,
): Promise<Response> {
  const now = Math.floor(Date.now() / 1000);
  const idToken = await signJwt({
    iss: issuer,
    sub: user.sub,
    aud: clientId,
    iat: now,
    exp: now + ID_TOKEN_TTL_SECONDS,
    auth_time: now,
    ...(nonce ? { nonce } : {}),
    email: user.email,
    email_verified: true,
    name: user.name,
    nickname: user.email.split('@')[0],
  });
  const accessToken = await signJwt({
    iss: issuer,
    sub: user.sub,
    aud: audience ?? clientId,
    azp: clientId,
    iat: now,
    exp: now + ID_TOKEN_TTL_SECONDS,
    scope,
  });
  const body: Record<string, unknown> = {
    access_token: accessToken,
    id_token: idToken,
    token_type: 'Bearer',
    expires_in: ID_TOKEN_TTL_SECONDS,
    scope,
  };
  if (scope.split(' ').includes('offline_access')) {
    body.refresh_token = await signJwt({
      iss: issuer,
      typ: 'refresh',
      user,
      scope,
      audience,
      iat: now,
      exp: now + REFRESH_TOKEN_TTL_SECONDS,
    });
  }
  return Response.json(body, { headers: { 'Cache-Control': 'no-store' } });
}

async function userinfo(request: Request): Promise<Response> {
  const bearer = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
  const claims = await verifyJwt(bearer);
  if (!claims) return new Response('Unauthorized', { status: 401 });
  return Response.json({ sub: claims.sub });
}

function logout(url: URL): Response {
  const target =
    url.searchParams.get('returnTo') ?? url.searchParams.get('post_logout_redirect_uri');
  return target ? Response.redirect(target, 302) : new Response('Signed out\n');
}

function userFor(email: string, name: string | null): MockUser {
  const normalized = email.trim().toLowerCase();
  // Stable per email so a user keeps their Convex identity across sign-ins and restarts.
  const id = createHash('sha256').update(normalized).digest('hex').slice(0, 24);
  return { sub: `mock|${id}`, email: normalized, name: name ?? normalized.split('@')[0]! };
}

function readBasicClientId(header: string | null): string | null {
  if (!header?.startsWith('Basic ')) return null;
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  return decodeURIComponent(decoded.split(':')[0] ?? '');
}

function tokenError(error: string, status = 400): Response {
  return Response.json({ error }, { status });
}

async function signJwt(payload: Record<string, unknown>): Promise<string> {
  const header = { alg: 'RS256', typ: 'JWT', kid: KEY_ID };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    privateKey,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${Buffer.from(signature).toString('base64url')}`;
}

async function verifyJwt(token: string): Promise<Record<string, unknown> | null> {
  const [header, payload, signature] = token.split('.');
  if (!header || !payload || !signature) return null;
  const publicKey = await crypto.subtle.importKey(
    'jwk',
    publicJwk,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const valid = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    publicKey,
    Buffer.from(signature, 'base64url'),
    new TextEncoder().encode(`${header}.${payload}`),
  );
  if (!valid) return null;
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  if (typeof claims.exp !== 'number' || claims.exp < Date.now() / 1000) return null;
  return claims;
}

// The key persists so existing Web sessions and Convex identities survive issuer restarts.
async function loadSigningKey(
  path: string,
): Promise<{ privateKey: CryptoKey; publicJwk: JsonWebKey }> {
  const algorithm = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' };
  let privateJwk: JsonWebKey;
  if (existsSync(path)) {
    privateJwk = JSON.parse(readFileSync(path, 'utf8'));
  } else {
    const pair = await crypto.subtle.generateKey(
      { ...algorithm, modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) },
      true,
      ['sign', 'verify'],
    );
    privateJwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(privateJwk), { mode: 0o600 });
  }
  const key = await crypto.subtle.importKey('jwk', privateJwk, algorithm, false, ['sign']);
  const { kty, n, e } = privateJwk;
  return { privateKey: key, publicJwk: { kty, n, e, alg: 'RS256', use: 'sig', kid: KEY_ID } };
}

function loginPage(params: URLSearchParams): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Sign in · Trace Flow local stack</title>
  <style>
    body { font-family: system-ui, sans-serif; background: #0b0d10; color: #e6e8eb;
      display: grid; place-items: center; min-height: 100vh; margin: 0; }
    form { background: #15181d; padding: 2rem; border-radius: 12px; width: min(360px, 90vw);
      display: grid; gap: 0.75rem; border: 1px solid #262a31; }
    h1 { font-size: 1.1rem; margin: 0 0 0.25rem; }
    p { margin: 0 0 0.5rem; color: #9aa3ad; font-size: 0.85rem; }
    label { font-size: 0.8rem; color: #9aa3ad; }
    input { padding: 0.6rem; border-radius: 6px; border: 1px solid #333943; background: #0b0d10;
      color: inherit; font-size: 0.95rem; }
    button { padding: 0.65rem; border-radius: 6px; border: 0; background: #e6e8eb; color: #0b0d10;
      font-weight: 600; cursor: pointer; }
  </style>
</head>
<body>
  <form method="post" action="${issuer}authorize">
    <h1>Trace Flow local stack</h1>
    <p>Mock sign-in. Any email works; the same email returns the same user.</p>
    <label for="email">Email</label>
    <input id="email" name="email" type="email" value="${escapeHtml(defaultEmail)}" required autofocus>
    <label for="name">Name (optional)</label>
    <input id="name" name="name" type="text">
    <input type="hidden" name="authorize" value="${escapeHtml(params.toString())}">
    <button type="submit">Sign in</button>
  </form>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function base64url(value: string): string {
  return Buffer.from(value).toString('base64url');
}

function withTrailingSlash(value: string): string {
  return value.endsWith('/') ? value : `${value}/`;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
