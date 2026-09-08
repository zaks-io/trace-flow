import { afterEach, describe, expect, it, vi } from 'vitest';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { sha256Hex } from '@trace-flow/utils';
import { app } from '../index';
import type { ArchiveApiEnv } from '../context';
import type { ArchiveSessionLedger } from '../archive-ledger';
import type { StorageBudget } from '../archive-storage-budget';

const CONVEX = 'https://convex.test';
const SECRET = 'valid-collector-secret';
const SHARED = 'archive-shared-secret';
const ORG_ID = 'k57axc8sefsfp6k28nx6c481js806pwv';
const USER_ID = 'j57axc8sefsfp6k28nx6c481js806pwv';
const COLLECTOR_ID = 'collector-1';
const CREDENTIAL_ID = 'm57axc8sefsfp6k28nx6c481js806pwv';

const requestBody = {
  authorizedSources: [{ source: 'claude', historyChoice: 'all_history' }],
  idempotencyKey: 'archive-enroll:fixture-request',
};

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
      collectorId: COLLECTOR_ID,
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
    ARCHIVE_KEY_WRAPPING_SECRET: 'unused-by-enrollment',
  };
}

async function fetchRoute(
  env: ArchiveApiEnv,
  body: unknown,
  init: RequestInit = {},
): Promise<Response> {
  const { headers: extraHeaders, ...requestInit } = init;
  const request = new Request('https://archive.test/v1/archive/enrollments', {
    ...requestInit,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Trace-Flow-Collector-Secret': SECRET,
      ...(extraHeaders ?? {}),
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const ctx = createExecutionContext();
  const response = await app.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

function upstreamSuccess(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    enrolled: true,
    authorizedSources: [
      { source: 'claude', historyChoice: 'all_history', authorizedAt: 1_770_000_000_001 },
    ],
    reason: null,
    orgId: ORG_ID,
    userId: USER_ID,
    collectorId: COLLECTOR_ID,
    collectorCredentialId: CREDENTIAL_ID,
    ...overrides,
  };
}

function mockConvexResponse(body: unknown, status = 200) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
}

describe('POST /v1/archive/enrollments', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects foreign credential classes before the Convex request', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const response = await fetchRoute(makeEnv(await validCredEntries()), requestBody, {
      headers: { Authorization: 'Bearer user-token' },
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: 'unauthorized',
      reason: 'invalid_credential_class',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects a corrupt authenticated identity before the Convex request', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const response = await fetchRoute(makeEnv(await validCredEntries({ orgId: '' })), requestBody);

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: 'unauthorized',
      reason: 'invalid_auth_identity',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects malformed JSON and malformed source items as invalid_request', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const env = makeEnv(await validCredEntries());

    const malformedJson = await fetchRoute(env, '{', {
      headers: { 'Content-Type': 'application/json' },
    });
    expect(malformedJson.status).toBe(400);
    expect(await malformedJson.json()).toEqual({ error: 'invalid_request' });

    const malformedSource = await fetchRoute(env, {
      authorizedSources: [{ source: 'claude', historyChoice: 'unsupported' }],
      idempotencyKey: requestBody.idempotencyKey,
    });
    expect(malformedSource.status).toBe(400);
    expect(await malformedSource.json()).toEqual({ error: 'invalid_request' });

    const paddedIdempotencyKey = await fetchRoute(env, {
      ...requestBody,
      idempotencyKey: ` ${requestBody.idempotencyKey}`,
    });
    expect(paddedIdempotencyKey.status).toBe(400);
    expect(await paddedIdempotencyKey.json()).toEqual({ error: 'invalid_request' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects unknown top-level fields, including every client identity field', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const env = makeEnv(await validCredEntries());
    const identityFields = [
      'orgId',
      'userId',
      'collectorId',
      'collectorCredentialId',
      'enrollmentId',
    ];

    for (const field of identityFields) {
      const response = await fetchRoute(env, { ...requestBody, [field]: 'client-supplied' });
      expect(response.status, field).toBe(400);
      expect(await response.json(), field).toEqual({ error: 'invalid_request' });
    }

    const extraItemField = await fetchRoute(env, {
      ...requestBody,
      authorizedSources: [{ source: 'claude', historyChoice: 'all_history', authorizedAt: 123 }],
    });
    expect(extraItemField.status).toBe(400);
    expect(await extraItemField.json()).toEqual({ error: 'invalid_request' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('forwards only server-derived identity and returns the policy shape', async () => {
    let sentBody: unknown;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      sentBody = await request.json();
      return new Response(JSON.stringify(upstreamSuccess()), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const response = await fetchRoute(makeEnv(await validCredEntries()), requestBody);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      enrolled: true,
      authorizedSources: upstreamSuccess().authorizedSources,
      reason: null,
    });
    expect(sentBody).toEqual({
      hashedSecret: await sha256Hex(SECRET),
      authorizedSources: requestBody.authorizedSources,
      idempotencyKey: requestBody.idempotencyKey,
      orgId: ORG_ID,
      userId: USER_ID,
      collectorId: COLLECTOR_ID,
    });
  });

  it('returns a policy denial from Convex as HTTP 200', async () => {
    mockConvexResponse({ enrolled: false, authorizedSources: [], reason: 'not_activated' });

    const response = await fetchRoute(makeEnv(await validCredEntries()), requestBody);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      enrolled: false,
      authorizedSources: [],
      reason: 'not_activated',
    });
  });

  it('maps a consent conflict to HTTP 409', async () => {
    mockConvexResponse({ error: 'consent_conflict' }, 409);

    const response = await fetchRoute(makeEnv(await validCredEntries()), requestBody);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'consent_conflict' });
  });

  it('maps upstream failures and malformed policy responses to HTTP 503', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('Convex unavailable'));
    const env = makeEnv(await validCredEntries());

    const unavailable = await fetchRoute(env, requestBody);
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toEqual({
      error: 'archive_unavailable',
      reason: 'policy_unavailable',
    });

    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ enrolled: true, authorizedSources: [], reason: null }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const malformed = await fetchRoute(env, requestBody);
    expect(malformed.status).toBe(503);
    expect(await malformed.json()).toEqual({
      error: 'archive_unavailable',
      reason: 'policy_unavailable',
    });
  });

  it('rejects an allowed response whose tenancy does not match the credential', async () => {
    mockConvexResponse(upstreamSuccess({ orgId: 'n57axc8sefsfp6k28nx6c481js806pwv' }));

    const response = await fetchRoute(makeEnv(await validCredEntries()), requestBody);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: 'archive_unavailable',
      reason: 'policy_unavailable',
    });
  });
});
