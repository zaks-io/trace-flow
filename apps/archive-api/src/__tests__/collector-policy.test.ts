import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { sha256Hex } from '@trace-flow/utils';
import { app } from '../index';
import type { ArchiveApiEnv } from '../context';
import type { ArchiveSessionLedger } from '../archive-ledger';
import type { StorageBudget } from '../archive-storage-budget';
import { __resetArchivePolicyCache } from '../enrollment';

const CONVEX = 'https://convex.test';
const SECRET = 'valid-collector-secret';
const SHARED = 'archive-shared-secret';
const ORG_ID = 'k57axc8sefsfp6k28nx6c481js806pwv';
const USER_ID = 'j57axc8sefsfp6k28nx6c481js806pwv';

function makeKv(entries: Record<string, string>): KVNamespace {
  return { get: async (key: string) => entries[key] ?? null } as unknown as KVNamespace;
}

async function validCredEntries(
  override: Record<string, unknown> = {},
): Promise<Record<string, string>> {
  return {
    [`collector:${await sha256Hex(SECRET)}`]: JSON.stringify({
      orgId: ORG_ID,
      userId: USER_ID,
      collectorId: 'collector-1',
      expiresAt: Date.now() + 3_600_000,
      status: 'active',
      createdAt: Date.now(),
      ...override,
    }),
  };
}

function makeEnv(creds: Record<string, string> = {}): ArchiveApiEnv {
  return {
    COLLECTOR_CREDS: makeKv(creds),
    CONVEX_SITE_URL: CONVEX,
    ARCHIVE_API_SHARED_SECRET: SHARED,
    ARCHIVE_STORAGE: {} as R2Bucket,
    ARCHIVE_SESSION_LEDGER: {} as DurableObjectNamespace<ArchiveSessionLedger>,
    STORAGE_BUDGET: {} as DurableObjectNamespace<StorageBudget>,
    ARCHIVE_KEY_VERSION: '1',
    ARCHIVE_KEY_WRAPPING_SECRET: 'unused-by-policy',
  };
}

async function fetchRoute(env: ArchiveApiEnv, path?: string, init: RequestInit = {}) {
  const request = new Request(`https://archive.test${path ?? '/v1/archive/policy'}`, {
    method: 'GET',
    ...init,
  });
  const ctx = createExecutionContext();
  const response = await app.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

function sourceFromRequest(request: Request): Promise<'claude' | 'codex'> {
  return request
    .clone()
    .json<{ source: 'claude' | 'codex' }>()
    .then((body) => body.source);
}

describe('GET /v1/archive/policy', () => {
  beforeEach(() => {
    __resetArchivePolicyCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ['missing', {}, undefined, 'missing'],
    ['unknown', {}, SECRET, 'invalid'],
    ['revoked', { status: 'revoked' }, SECRET, 'revoked'],
    ['expired', { expiresAt: Date.now() - 1 }, SECRET, 'expired'],
  ])('rejects a %s Collector Credential', async (_case, override, secret, reason) => {
    const entries = _case === 'unknown' ? {} : await validCredEntries(override);
    const response = await fetchRoute(makeEnv(entries), undefined, {
      headers: secret ? { 'X-Trace-Flow-Collector-Secret': secret } : {},
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ reason });
  });

  it('rejects user, API, Pipe, and browser credential classes before policy lookup', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const env = makeEnv(await validCredEntries());
    const foreignHeaders: Record<string, string>[] = [
      { Authorization: 'Bearer user-token' },
      { Authorization: 'Bearer tf_live_api_key' },
      { Authorization: 'Bearer pipe-token' },
      { Cookie: 'appSession=browser-session' },
    ];
    for (const headers of foreignHeaders) {
      const response = await fetchRoute(env, undefined, {
        headers: { 'X-Trace-Flow-Collector-Secret': SECRET, ...headers },
      });
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ reason: 'invalid_credential_class' });
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns stable full source authorization records for an enrolled collector', async () => {
    const authorizedSources = [
      { source: 'codex', historyChoice: 'new_only', authorizedAt: 1_770_000_000_002 },
      { source: 'claude', historyChoice: 'all_history', authorizedAt: 1_770_000_000_001 },
    ];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      const source = await sourceFromRequest(request);
      return new Response(
        JSON.stringify({
          allowed: true,
          enrollmentId: 'enrollment-1',
          contributionId: 'contribution-1',
          orgId: ORG_ID,
          userId: USER_ID,
          collectorId: 'collector-1',
          collectorCredentialId: 'credential-1',
          authorizedSources,
          requestedSource: source,
        }),
      );
    });

    const response = await fetchRoute(makeEnv(await validCredEntries()), undefined, {
      headers: { 'X-Trace-Flow-Collector-Secret': SECRET },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      enrolled: true,
      authorizedSources: [authorizedSources[1], authorizedSources[0]],
      reason: null,
    });
  });

  it('returns one allowed source with its history choice and authorization time', async () => {
    const authorizedSources = [
      { source: 'claude', historyChoice: 'all_history', authorizedAt: 1_770_000_000_001 },
    ];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const source = await sourceFromRequest(new Request(input, init));
      return new Response(
        JSON.stringify(
          source === 'claude'
            ? {
                allowed: true,
                enrollmentId: 'enrollment-1',
                contributionId: 'contribution-1',
                orgId: ORG_ID,
                userId: USER_ID,
                collectorId: 'collector-1',
                collectorCredentialId: 'credential-1',
                authorizedSources,
              }
            : { allowed: false, reason: 'source_unauthorized' },
        ),
      );
    });

    const response = await fetchRoute(makeEnv(await validCredEntries()), undefined, {
      headers: { 'X-Trace-Flow-Collector-Secret': SECRET },
    });
    expect(await response.json()).toEqual({ enrolled: true, authorizedSources, reason: null });
  });

  it('rejects inconsistent enrollment identity across allowed source decisions', async () => {
    const authorizedSources = [
      { source: 'claude', historyChoice: 'all_history', authorizedAt: 1_770_000_000_001 },
      { source: 'codex', historyChoice: 'new_only', authorizedAt: 1_770_000_000_002 },
    ];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const source = await sourceFromRequest(new Request(input, init));
      return new Response(
        JSON.stringify({
          allowed: true,
          enrollmentId: 'enrollment-1',
          contributionId: source === 'claude' ? 'contribution-1' : 'contribution-2',
          orgId: ORG_ID,
          userId: USER_ID,
          collectorId: 'collector-1',
          collectorCredentialId: 'credential-1',
          authorizedSources,
        }),
      );
    });

    const response = await fetchRoute(makeEnv(await validCredEntries()), undefined, {
      headers: { 'X-Trace-Flow-Collector-Secret': SECRET },
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: 'archive_unavailable',
      reason: 'policy_unavailable',
    });
  });

  it('returns the current denial when neither source is allowed', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () => new Response(JSON.stringify({ allowed: false, reason: 'not_enrolled' })),
    );
    const response = await fetchRoute(makeEnv(await validCredEntries()), undefined, {
      headers: { 'X-Trace-Flow-Collector-Secret': SECRET },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      enrolled: false,
      authorizedSources: [],
      reason: 'not_enrolled',
    });
  });

  it.each([
    ['Convex outage', () => Promise.reject(new Error('offline'))],
    ['malformed response', () => Promise.resolve(new Response('{not-json'))],
    [
      'mismatched identity',
      () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              allowed: true,
              enrollmentId: 'enrollment-1',
              contributionId: 'contribution-1',
              orgId: USER_ID,
              userId: USER_ID,
              collectorId: 'collector-1',
              collectorCredentialId: 'credential-1',
              authorizedSources: [
                {
                  source: 'claude',
                  historyChoice: 'all_history',
                  authorizedAt: 1_770_000_000_001,
                },
              ],
            }),
          ),
        ),
    ],
  ])('returns policy_unavailable on %s without synthesizing a policy', async (_case, responder) => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(responder);
    const response = await fetchRoute(makeEnv(await validCredEntries()), undefined, {
      headers: { 'X-Trace-Flow-Collector-Secret': SECRET },
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: 'archive_unavailable',
      reason: 'policy_unavailable',
    });
  });

  it('does not seed the upload deny cache', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(
        async () => new Response(JSON.stringify({ allowed: false, reason: 'not_enrolled' })),
      );
    const env = makeEnv(await validCredEntries());
    const policy = await fetchRoute(env, undefined, {
      headers: { 'X-Trace-Flow-Collector-Secret': SECRET },
    });
    expect(policy.status).toBe(200);

    fetchMock.mockRejectedValue(new Error('offline'));
    const upload = await fetchRoute(env, '/v1/archive/uploads', {
      method: 'POST',
      headers: {
        'X-Trace-Flow-Collector-Secret': SECRET,
        'X-Trace-Flow-Archive-Source': 'claude',
      },
    });
    expect(upload.status).toBe(503);
    expect(await upload.json()).toMatchObject({ reason: 'policy_unavailable' });
  });
});
