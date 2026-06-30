import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { sha256Hex } from '@trace-flow/utils';
import type { AgentIngestQueueMessage, AgentToolEventFact } from '@trace-flow/types';
import { app } from '../index';
import { __resetPolicyCache, type CompatibilityPolicy } from '../policy';
import type { AgentIngestEnv } from '../context';
import type { ClaimStatus } from '../ownership';
import { envelope, emptyFacts, facts, toolEventFact } from './factories';

const CONVEX = 'https://convex.test';
const SECRET = 'valid-collector-secret';

const POLICY: CompatibilityPolicy = {
  minDesktopVersion: '1.0.0',
  minParserVersion: '1.0.0',
  denylistedVersions: [],
  updatedAt: 1_700_000_000_000,
};

function makeKv(entries: Record<string, string>): KVNamespace {
  return {
    get: async (key: string) => entries[key] ?? null,
  } as unknown as KVNamespace;
}

interface EnvOverrides {
  creds?: Record<string, string>;
  limitSuccess?: boolean;
  queueSend?: ReturnType<typeof vi.fn>;
}

async function validCredEntries(
  over: Partial<Record<string, unknown>> = {},
): Promise<Record<string, string>> {
  const key = `collector:${await sha256Hex(SECRET)}`;
  return {
    [key]: JSON.stringify({
      orgId: 'org-1',
      userId: 'user-1',
      collectorId: 'collector-1',
      expiresAt: Date.now() + 3_600_000,
      status: 'active',
      createdAt: Date.now(),
      ...over,
    }),
  };
}

function makeEnv(over: EnvOverrides = {}): {
  env: AgentIngestEnv;
  queueSend: ReturnType<typeof vi.fn>;
} {
  const queueSend = over.queueSend ?? vi.fn(async () => {});
  const env = {
    COLLECTOR_CREDS: makeKv(over.creds ?? {}),
    // The handler enqueues via sendBatch (one call per <=100-message group). Tests assert on it.
    AGENT_QUEUE: { sendBatch: queueSend } as unknown as Queue<AgentIngestQueueMessage>,
    AGENT_INGEST_LIMITER: {
      limit: async () => ({ success: over.limitSuccess ?? true }),
    } as unknown as RateLimit,
    CONVEX_SITE_URL: CONVEX,
    AGENT_INGEST_SHARED_SECRET: 'shared-secret',
  } satisfies AgentIngestEnv;
  return { env, queueSend };
}

/**
 * Per-test routing for the mocked `globalThis.fetch`. `policyResponse` answers the
 * compatibility-policy GET; `claimResponder` answers the claim-sessions POST and receives the parsed
 * request body so a test can echo back the requested `sessionPks`. Anything un-stubbed throws so
 * unexpected fetches fail loudly (net-connect disabled).
 */
let policyResponse: { status: number; body: string } | null = null;
let claimResponder: ((req: Request, body: string) => Response | Promise<Response>) | null = null;

function interceptPolicy(status: number, body: unknown): void {
  policyResponse = { status, body: typeof body === 'string' ? body : JSON.stringify(body) };
}

function interceptClaim(opts: { httpStatus?: number; claim?: ClaimStatus }): void {
  if (opts.httpStatus && opts.httpStatus !== 200) {
    claimResponder = () =>
      new Response(JSON.stringify({ error: 'down' }), { status: opts.httpStatus });
    return;
  }
  claimResponder = (_req, body) => {
    const parsed = JSON.parse(body || '{}') as { sessionPks: string[] };
    return new Response(
      JSON.stringify({
        results: parsed.sessionPks.map((sessionPk) => ({
          sessionPk,
          status: opts.claim ?? 'claimed',
          ownerUserId: 'user-1',
        })),
      }),
      { status: 200 },
    );
  };
}

function installFetchMock(): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    if (
      req.method === 'GET' &&
      url.origin === CONVEX &&
      url.pathname === '/agent-ingest/compatibility-policy'
    ) {
      if (!policyResponse) throw new Error(`unexpected fetch (no policy stub): ${req.url}`);
      return new Response(policyResponse.body, { status: policyResponse.status });
    }
    if (
      req.method === 'POST' &&
      url.origin === CONVEX &&
      url.pathname === '/agent-ingest/claim-sessions'
    ) {
      if (!claimResponder) throw new Error(`unexpected fetch (no claim stub): ${req.url}`);
      return claimResponder(req, await req.text());
    }
    throw new Error(`unexpected fetch: ${req.method} ${req.url}`);
  });
}

async function post(
  env: AgentIngestEnv,
  body: BodyInit,
  headers: Record<string, string>,
): Promise<Response> {
  const req = new Request('https://ingest.test/v1/ingest', { method: 'POST', headers, body });
  const ctx = createExecutionContext();
  const res = await app.fetch(req, env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

/** Gzip a string the same way the Collector's api-client does, so the body is `Content-Encoding: gzip`. */
async function gzip(text: string): Promise<Uint8Array> {
  const stream = new Response(text).body!.pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

const authHeaders = { 'X-Trace-Flow-Collector-Secret': SECRET, 'Content-Type': 'application/json' };

describe('POST /v1/ingest', () => {
  beforeEach(() => {
    __resetPolicyCache();
    policyResponse = null;
    claimResponder = null;
    installFetchMock();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('401s when the collector secret is missing', async () => {
    const { env } = makeEnv({ creds: await validCredEntries() });
    const res = await post(env, JSON.stringify(envelope()), { 'Content-Type': 'application/json' });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ reason: 'missing' });
  });

  it('401s when the secret does not resolve to a credential', async () => {
    const { env } = makeEnv({ creds: {} });
    const res = await post(env, JSON.stringify(envelope()), authHeaders);
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ reason: 'invalid' });
  });

  it('401s a revoked credential', async () => {
    const { env } = makeEnv({ creds: await validCredEntries({ status: 'revoked' }) });
    const res = await post(env, JSON.stringify(envelope()), authHeaders);
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ reason: 'revoked' });
  });

  it('401s an expired credential', async () => {
    const { env } = makeEnv({ creds: await validCredEntries({ expiresAt: Date.now() - 1000 }) });
    const res = await post(env, JSON.stringify(envelope()), authHeaders);
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ reason: 'expired' });
  });

  it('401s a credential record whose shape is malformed (missing expiresAt)', async () => {
    const { env } = makeEnv({ creds: await validCredEntries({ expiresAt: undefined }) });
    const res = await post(env, JSON.stringify(envelope()), authHeaders);
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ reason: 'invalid' });
  });

  it('413s an oversized body', async () => {
    const { env } = makeEnv({ creds: await validCredEntries() });
    const huge = `{"x":"${'a'.repeat(10 * 1024 * 1024 + 16)}"}`;
    const res = await post(env, huge, authHeaders);
    expect(res.status).toBe(413);
  });

  it('400s malformed JSON', async () => {
    const { env } = makeEnv({ creds: await validCredEntries() });
    const res = await post(env, 'not json', authHeaders);
    expect(res.status).toBe(400);
  });

  it('202s a gzip-encoded body (the Collector gzips and sends Content-Encoding: gzip)', async () => {
    const { env, queueSend } = makeEnv({ creds: await validCredEntries() });
    interceptPolicy(200, POLICY);
    interceptClaim({ claim: 'claimed' });
    const body = await gzip(JSON.stringify(envelope()));
    const res = await post(env, body, { ...authHeaders, 'Content-Encoding': 'gzip' });
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ sessions: 1 });
    expect(queueSend).toHaveBeenCalledTimes(1);
    // Prove the body was actually inflated and parsed, not just that a 202 came back: the enqueued
    // message must carry the decompressed facts. sendBatch is called with an array of {body} entries.
    const sentGroup = queueSend.mock.calls[0]![0] as { body: AgentIngestQueueMessage }[];
    const enqueued = sentGroup[0]!.body;
    expect(enqueued.facts.messages.length).toBeGreaterThan(0);
  });

  it('400s a body that declares Content-Encoding: gzip but is not gzip', async () => {
    const { env } = makeEnv({ creds: await validCredEntries() });
    const res = await post(env, '{"not":"gzip"}', { ...authHeaders, 'Content-Encoding': 'gzip' });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid_envelope' });
  });

  it('400s an envelope missing batch/facts', async () => {
    const { env } = makeEnv({ creds: await validCredEntries() });
    const res = await post(env, '{}', authHeaders);
    expect(res.status).toBe(400);
  });

  it('400s a structurally present but malformed envelope (empty batch + facts)', async () => {
    const { env } = makeEnv({ creds: await validCredEntries() });
    const res = await post(env, JSON.stringify({ batch: {}, facts: {} }), authHeaders);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid_envelope' });
  });

  it('400s a fact element missing its required fields (per-element shape, before the policy fetch)', async () => {
    const { env, queueSend } = makeEnv({ creds: await validCredEntries() });
    const bad = envelope({ facts: facts({ tool_events: [{} as unknown as AgentToolEventFact] }) });
    const res = await post(env, JSON.stringify(bad), authHeaders);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid_envelope' });
    expect(queueSend).not.toHaveBeenCalled();
  });

  it('503s when the compatibility policy is unavailable on a cold miss', async () => {
    const { env } = makeEnv({ creds: await validCredEntries() });
    interceptPolicy(503, { error: 'down' });
    const res = await post(env, JSON.stringify(envelope()), authHeaders);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: 'policy_unavailable' });
  });

  it('426s a client below the minimum version', async () => {
    const { env } = makeEnv({ creds: await validCredEntries() });
    interceptPolicy(200, { ...POLICY, minDesktopVersion: '2.0.0' });
    const env426 = envelope();
    env426.batch.desktop_version = '0.1.0';
    const res = await post(env, JSON.stringify(env426), authHeaders);
    expect(res.status).toBe(426);
    expect(await res.json()).toMatchObject({
      error: 'upgrade_required',
      detail: 'desktop_below_min',
    });
  });

  it('429s when over the per-org rate limit', async () => {
    const { env } = makeEnv({ creds: await validCredEntries(), limitSuccess: false });
    interceptPolicy(200, POLICY);
    const res = await post(env, JSON.stringify(envelope()), authHeaders);
    expect(res.status).toBe(429);
  });

  it('202s an empty-facts batch without enqueuing', async () => {
    const { env, queueSend } = makeEnv({ creds: await validCredEntries() });
    interceptPolicy(200, POLICY);
    const res = await post(env, JSON.stringify(envelope({ facts: emptyFacts() })), authHeaders);
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ sessions: 0 });
    expect(queueSend).not.toHaveBeenCalled();
  });

  it('drops every conflicted session and 202s a no-op', async () => {
    const { env, queueSend } = makeEnv({ creds: await validCredEntries() });
    interceptPolicy(200, POLICY);
    interceptClaim({ claim: 'conflict' });
    const res = await post(env, JSON.stringify(envelope()), authHeaders);
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ sessions: 0, skipped_conflict: 1 });
    expect(queueSend).not.toHaveBeenCalled();
  });

  it('503s when session ownership claim is unreachable', async () => {
    const { env } = makeEnv({ creds: await validCredEntries() });
    interceptPolicy(200, POLICY);
    interceptClaim({ httpStatus: 500 });
    const res = await post(env, JSON.stringify(envelope()), authHeaders);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: 'session_claim_unavailable' });
  });

  it('503s when the claim response is malformed (fails closed, never assumes ownership)', async () => {
    const { env, queueSend } = makeEnv({ creds: await validCredEntries() });
    interceptPolicy(200, POLICY);
    claimResponder = () =>
      new Response(JSON.stringify({ results: [{ status: 'claimed' }] }), { status: 200 }); // missing sessionPk
    const res = await post(env, JSON.stringify(envelope()), authHeaders);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: 'session_claim_unavailable' });
    expect(queueSend).not.toHaveBeenCalled();
  });

  it('503s when the claim response covers a session that was never requested (fails closed)', async () => {
    const { env, queueSend } = makeEnv({ creds: await validCredEntries() });
    interceptPolicy(200, POLICY);
    claimResponder = () =>
      new Response(
        JSON.stringify({
          results: [
            { sessionPk: 'not-the-requested-pk', status: 'claimed', ownerUserId: 'user-1' },
          ],
        }),
        { status: 200 },
      );
    const res = await post(env, JSON.stringify(envelope()), authHeaders);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: 'session_claim_unavailable' });
    expect(queueSend).not.toHaveBeenCalled();
  });

  it('503s when enqueue fails', async () => {
    const queueSend = vi.fn(async () => {
      throw new Error('queue down');
    });
    const { env } = makeEnv({ creds: await validCredEntries(), queueSend });
    interceptPolicy(200, POLICY);
    interceptClaim({ claim: 'claimed' });
    const res = await post(env, JSON.stringify(envelope()), authHeaders);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: 'enqueue_failed' });
  });

  it('202s the happy path and enqueues the claimed session', async () => {
    const { env, queueSend } = makeEnv({ creds: await validCredEntries() });
    interceptPolicy(200, POLICY);
    interceptClaim({ claim: 'claimed' });
    const res = await post(env, JSON.stringify(envelope()), authHeaders);
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ sessions: 1 });
    expect(queueSend).toHaveBeenCalledTimes(1);
  });

  it('accepts legacy tool events without ingest-time classification fields', async () => {
    const { env, queueSend } = makeEnv({ creds: await validCredEntries() });
    interceptPolicy(200, POLICY);
    interceptClaim({ claim: 'claimed' });
    const legacyTool = toolEventFact({ status: 'failure' });
    delete legacyTool.error_category;
    delete legacyTool.error_category_coverage;
    delete legacyTool.is_navigation;
    delete legacyTool.navigation_kind;
    delete legacyTool.navigation_hint_coverage;
    delete legacyTool.navigation_path_hint;
    delete legacyTool.navigation_pattern_hint;
    const legacyEnvelope = envelope({
      facts: facts({
        tool_events: [legacyTool],
        file_events: [],
        capability_snapshots: [],
        pull_request_links: [],
      }),
    });

    const res = await post(env, JSON.stringify(legacyEnvelope), authHeaders);
    expect(res.status).toBe(202);
    expect(queueSend).toHaveBeenCalledTimes(1);
  });

  it('re-redacts free-text excerpts and increments dropped_sensitive before enqueue', async () => {
    const { env, queueSend } = makeEnv({ creds: await validCredEntries() });
    interceptPolicy(200, POLICY);
    interceptClaim({ claim: 'claimed' });
    const leaky = envelope({
      facts: facts({
        tool_events: [
          toolEventFact({
            command_excerpt: 'export AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE',
            navigation_path_hint: '/Users/janedoe/secret-project',
            navigation_pattern_hint: 'AKIAIOSFODNN7EXAMPLE',
            dropped_sensitive: 0,
          }),
        ],
        file_events: [],
        capability_snapshots: [],
        pull_request_links: [],
      }),
    });
    const res = await post(env, JSON.stringify(leaky), authHeaders);
    expect(res.status).toBe(202);

    expect(queueSend).toHaveBeenCalledTimes(1);
    const sentGroup = queueSend.mock.calls[0]![0] as { body: AgentIngestQueueMessage }[];
    const enqueued = sentGroup[0]!.body;
    const tool = enqueued.facts.tool_events[0]!;
    expect(tool.command_excerpt).toBe('');
    expect(tool.navigation_path_hint).toBe('/Users/[REDACTED]/secret-project');
    expect(tool.navigation_pattern_hint).toBe('');
    expect(tool.dropped_sensitive).toBeGreaterThanOrEqual(1);
  });

  it('caps navigation hints to their field cap and the remaining tool excerpt budget', async () => {
    const { env, queueSend } = makeEnv({ creds: await validCredEntries() });
    interceptPolicy(200, POLICY);
    interceptClaim({ claim: 'claimed' });
    const bounded = envelope({
      facts: facts({
        tool_events: [
          toolEventFact({
            command_excerpt: '',
            error_excerpt: '',
            navigation_path_hint: 'p'.repeat(300),
            navigation_pattern_hint: 'q'.repeat(300),
          }),
          toolEventFact({
            tool_use_id: 'tool-2',
            source_block_index: 1,
            command_excerpt: 'c'.repeat(1024),
            error_excerpt: 'e'.repeat(4096),
            navigation_path_hint: 'p'.repeat(300),
            navigation_pattern_hint: 'q'.repeat(300),
          }),
        ],
        file_events: [],
        capability_snapshots: [],
        pull_request_links: [],
      }),
    });

    const res = await post(env, JSON.stringify(bounded), authHeaders);
    expect(res.status).toBe(202);

    const sentGroup = queueSend.mock.calls[0]![0] as { body: AgentIngestQueueMessage }[];
    const [withRoom, noRoom] = sentGroup[0]!.body.facts.tool_events;
    expect(withRoom!.navigation_path_hint).toHaveLength(256);
    expect(withRoom!.navigation_pattern_hint).toHaveLength(256);
    expect(noRoom!.navigation_path_hint).toBe('');
    expect(noRoom!.navigation_pattern_hint).toBe('');
  });
});
