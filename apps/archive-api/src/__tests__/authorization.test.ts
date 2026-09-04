import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { sha256Hex } from '@trace-flow/utils';
import { app } from '../index';
import type { ArchiveApiEnv } from '../context';
import { __resetArchivePolicyCache } from '../enrollment';

const CONVEX = 'https://convex.test';
const SECRET = 'valid-collector-secret';
const SHARED = 'archive-shared-secret';

function makeKv(entries: Record<string, string>): KVNamespace {
  return {
    get: async (key: string) => entries[key] ?? null,
  } as unknown as KVNamespace;
}

async function validCredEntries(
  over: Record<string, unknown> = {},
): Promise<Record<string, string>> {
  return {
    [`collector:${await sha256Hex(SECRET)}`]: JSON.stringify({
      orgId: 'k57axc8sefsfp6k28nx6c481js806pwv',
      userId: 'j57axc8sefsfp6k28nx6c481js806pwv',
      collectorId: 'collector-1',
      expiresAt: Date.now() + 3_600_000,
      status: 'active',
      createdAt: Date.now(),
      ...over,
    }),
  };
}

function makeEnv(creds: Record<string, string> = {}): ArchiveApiEnv {
  return {
    COLLECTOR_CREDS: makeKv(creds),
    CONVEX_SITE_URL: CONVEX,
    ARCHIVE_API_SHARED_SECRET: SHARED,
  };
}

let authorizeResponder: ((req: Request, body: string) => Response | Promise<Response>) | null =
  null;

function interceptAuthorize(body: unknown, status = 200): void {
  authorizeResponder = () =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
}

function installFetchMock(): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    if (
      req.method === 'POST' &&
      url.origin === CONVEX &&
      url.pathname === '/archive-api/authorize-write'
    ) {
      if (!authorizeResponder) throw new Error(`unexpected fetch (no authorize stub): ${req.url}`);
      return authorizeResponder(req, await req.text());
    }
    throw new Error(`unexpected fetch: ${req.method} ${req.url}`);
  });
}

async function fetchRoute(env: ArchiveApiEnv, path: string, init: RequestInit): Promise<Response> {
  const req = new Request(`https://archive.test${path}`, init);
  const ctx = createExecutionContext();
  const res = await app.fetch(req, env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

const collectorHeaders = {
  'X-Trace-Flow-Collector-Secret': SECRET,
  'X-Trace-Flow-Archive-Source': 'claude',
};

describe('Archive API authorization', () => {
  beforeEach(() => {
    __resetArchivePolicyCache();
    authorizeResponder = null;
    installFetchMock();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('serves health without credentials', async () => {
    const res = await fetchRoute(makeEnv(), '/healthz', { method: 'GET' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  it('rejects a missing Collector Credential', async () => {
    const res = await fetchRoute(makeEnv(await validCredEntries()), '/v1/archive/uploads', {
      method: 'POST',
      headers: { 'X-Trace-Flow-Archive-Source': 'claude' },
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ reason: 'missing' });
  });

  it('rejects an unknown Collector Credential', async () => {
    const res = await fetchRoute(makeEnv({}), '/v1/archive/uploads', {
      method: 'POST',
      headers: collectorHeaders,
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ reason: 'invalid' });
  });

  it('rejects a revoked Collector Credential', async () => {
    const res = await fetchRoute(
      makeEnv(await validCredEntries({ status: 'revoked' })),
      '/v1/archive/uploads',
      { method: 'POST', headers: collectorHeaders },
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ reason: 'revoked' });
  });

  it('rejects an expired Collector Credential', async () => {
    const res = await fetchRoute(
      makeEnv(await validCredEntries({ expiresAt: Date.now() - 1000 })),
      '/v1/archive/uploads',
      { method: 'POST', headers: collectorHeaders },
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ reason: 'expired' });
  });

  it('rejects Pipe Tokens, Body Access Tokens, API Keys, and browser sessions on upload', async () => {
    const env = makeEnv(await validCredEntries());
    const cases: Record<string, string>[] = [
      { ...collectorHeaders, Authorization: 'Bearer pipe-token' },
      { ...collectorHeaders, Authorization: 'Bearer body-access-token' },
      { ...collectorHeaders, Authorization: 'Bearer tf_live_api_key' },
      { ...collectorHeaders, Cookie: 'appSession=browser-session' },
    ];
    for (const headers of cases) {
      const res = await fetchRoute(env, '/v1/archive/uploads', { method: 'POST', headers });
      expect(res.status).toBe(401);
      expect(await res.json()).toMatchObject({ reason: 'invalid_credential_class' });
    }
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('rejects an unenrolled Collector after credential auth', async () => {
    interceptAuthorize({ allowed: false, reason: 'not_enrolled' });
    const res = await fetchRoute(makeEnv(await validCredEntries()), '/v1/archive/uploads', {
      method: 'POST',
      headers: collectorHeaders,
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ reason: 'not_enrolled' });
  });

  it('rejects a Source that is not on the current enrollment', async () => {
    interceptAuthorize({ allowed: false, reason: 'source_unauthorized' });
    const res = await fetchRoute(makeEnv(await validCredEntries()), '/v1/archive/uploads', {
      method: 'POST',
      headers: { ...collectorHeaders, 'X-Trace-Flow-Archive-Source': 'codex' },
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ reason: 'source_unauthorized' });
  });

  it('rejects cross-Organization and cross-User tenancy mismatches from Convex', async () => {
    interceptAuthorize({ allowed: false, reason: 'not_enrolled' });
    const res = await fetchRoute(
      makeEnv(await validCredEntries({ orgId: 'other-org', userId: 'other-user' })),
      '/v1/archive/uploads',
      { method: 'POST', headers: collectorHeaders },
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ reason: 'not_enrolled' });
  });

  it('lets unenrollment, owner revocation, and member removal win a later upload', async () => {
    const env = makeEnv(await validCredEntries());
    interceptAuthorize({
      allowed: true,
      enrollmentId: 'enr_1',
      contributionId: 'con_1',
      orgId: 'k57axc8sefsfp6k28nx6c481js806pwv',
      userId: 'j57axc8sefsfp6k28nx6c481js806pwv',
      collectorId: 'collector-1',
      collectorCredentialId: 'cred_1',
    });
    const first = await fetchRoute(env, '/v1/archive/uploads', {
      method: 'POST',
      headers: collectorHeaders,
    });
    expect(first.status).toBe(501);

    interceptAuthorize({ allowed: false, reason: 'enrollment_invalid' });
    const afterUnenroll = await fetchRoute(env, '/v1/archive/uploads', {
      method: 'POST',
      headers: collectorHeaders,
    });
    expect(afterUnenroll.status).toBe(403);
    expect(await afterUnenroll.json()).toMatchObject({ reason: 'enrollment_invalid' });
  });

  it('fails closed when Convex is unavailable and no current cache exists', async () => {
    authorizeResponder = () => {
      throw new Error('convex down');
    };
    const res = await fetchRoute(makeEnv(await validCredEntries()), '/v1/archive/uploads', {
      method: 'POST',
      headers: collectorHeaders,
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ reason: 'policy_unavailable' });
  });

  it.each([
    { invalidation: 'self-unenroll', reason: 'enrollment_invalid' as const },
    { invalidation: 'owner revocation', reason: 'enrollment_invalid' as const },
    { invalidation: 'member removal', reason: 'enrollment_invalid' as const },
  ])('denies after $invalidation even when Convex later fails', async ({ reason }) => {
    const env = makeEnv(await validCredEntries());
    interceptAuthorize({
      allowed: true,
      enrollmentId: 'enr_1',
      contributionId: 'con_1',
      orgId: 'k57axc8sefsfp6k28nx6c481js806pwv',
      userId: 'j57axc8sefsfp6k28nx6c481js806pwv',
      collectorId: 'collector-1',
      collectorCredentialId: 'cred_1',
    });
    expect(
      (
        await fetchRoute(env, '/v1/archive/uploads', {
          method: 'POST',
          headers: collectorHeaders,
        })
      ).status,
    ).toBe(501);

    interceptAuthorize({ allowed: false, reason });
    const afterInvalidation = await fetchRoute(env, '/v1/archive/uploads', {
      method: 'POST',
      headers: collectorHeaders,
    });
    expect(afterInvalidation.status).toBe(403);
    expect(await afterInvalidation.json()).toMatchObject({ reason });

    authorizeResponder = () => {
      throw new Error('convex down');
    };
    const afterOutage = await fetchRoute(env, '/v1/archive/uploads', {
      method: 'POST',
      headers: collectorHeaders,
    });
    expect(afterOutage.status).toBe(403);
    expect(await afterOutage.json()).toMatchObject({ reason });
  });

  it('fails closed on a cached allow when Convex is unavailable', async () => {
    interceptAuthorize({
      allowed: true,
      enrollmentId: 'enr_1',
      contributionId: 'con_1',
      orgId: 'k57axc8sefsfp6k28nx6c481js806pwv',
      userId: 'j57axc8sefsfp6k28nx6c481js806pwv',
      collectorId: 'collector-1',
      collectorCredentialId: 'cred_1',
    });
    const env = makeEnv(await validCredEntries());
    expect(
      (
        await fetchRoute(env, '/v1/archive/uploads', {
          method: 'POST',
          headers: collectorHeaders,
        })
      ).status,
    ).toBe(501);

    authorizeResponder = () => {
      throw new Error('convex down');
    };
    const degraded = await fetchRoute(env, '/v1/archive/uploads', {
      method: 'POST',
      headers: collectorHeaders,
    });
    expect(degraded.status).toBe(503);
    expect(await degraded.json()).toMatchObject({ reason: 'policy_unavailable' });
  });

  it('does not let upload authority read, export, or delete another contribution', async () => {
    const env = makeEnv(await validCredEntries());
    const upload = await fetchRoute(env, '/v1/archive/exports', {
      method: 'GET',
      headers: collectorHeaders,
    });
    expect(upload.status).toBe(401);

    const exported = await fetchRoute(env, '/v1/archive/exports', {
      method: 'POST',
      headers: { ...collectorHeaders, 'X-Trace-Flow-Archive-Export-Grant': 'not-a-grant' },
    });
    expect(exported.status).toBe(403);
    expect(await exported.json()).toMatchObject({ reason: 'grant_unavailable' });

    const deleted = await fetchRoute(env, '/v1/archive/contributions/con_other', {
      method: 'DELETE',
      headers: collectorHeaders,
    });
    expect(deleted.status).toBe(401);

    const wiped = await fetchRoute(env, '/v1/archive', {
      method: 'DELETE',
      headers: collectorHeaders,
    });
    expect(wiped.status).toBe(401);
  });

  it('rejects foreign credential classes on export and deletion routes', async () => {
    const env = makeEnv();
    const headersList: Record<string, string>[] = [
      { Authorization: 'Bearer pipe-token' },
      { Authorization: 'Bearer body-access-token' },
      { Cookie: 'appSession=browser-session' },
    ];
    for (const headers of headersList) {
      const exported = await fetchRoute(env, '/v1/archive/exports', { method: 'GET', headers });
      expect(exported.status).toBe(401);
      expect(await exported.json()).toMatchObject({ reason: 'invalid_credential_class' });

      const deleted = await fetchRoute(env, '/v1/archive', { method: 'DELETE', headers });
      expect(deleted.status).toBe(401);
    }
  });

  it('authorizes an enrolled upload without persisting archive data', async () => {
    interceptAuthorize({
      allowed: true,
      enrollmentId: 'enr_1',
      contributionId: 'con_1',
      orgId: 'k57axc8sefsfp6k28nx6c481js806pwv',
      userId: 'j57axc8sefsfp6k28nx6c481js806pwv',
      collectorId: 'collector-1',
      collectorCredentialId: 'cred_1',
    });
    const res = await fetchRoute(makeEnv(await validCredEntries()), '/v1/archive/uploads', {
      method: 'POST',
      headers: collectorHeaders,
      body: '{"payload":"must-not-be-logged-or-stored"}',
    });
    expect(res.status).toBe(501);
    expect(await res.json()).toEqual({ error: 'persistence_not_implemented' });
  });
});
