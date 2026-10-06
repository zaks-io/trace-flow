import { vi } from 'vitest';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { loadAgentDelivery } from '@trace-flow/utils';
import type { AgentDeliveryReference, AgentIngestQueueMessage } from '@trace-flow/types';
import { app } from '../index';
import { __resetPolicyCache } from '../policy';
import type { AgentIngestEnv } from '../context';
import type { ClaimStatus } from '../ownership';
import { CONVEX, SECRET, ROOT_KEY, TEST_NOW, POLICY } from './handler-fixture';

export async function queuedMessages(
  queueSend: ReturnType<typeof vi.fn>,
  storage: R2Bucket,
): Promise<AgentIngestQueueMessage[]> {
  const references = queueSend.mock.calls.flatMap((call) =>
    (call[0] as { body: AgentDeliveryReference }[]).map(({ body }) => body),
  );
  return Promise.all(
    references.map((reference) =>
      loadAgentDelivery({
        storage,
        reference,
        encryption: { rootKeyBase64: ROOT_KEY },
        now: reference.created_at,
      }),
    ),
  );
}

/**
 * Per-test routing for the mocked `globalThis.fetch`. `responses.policy` answers the
 * compatibility-policy GET; `responses.claim` answers the claim-sessions POST and receives the parsed
 * request body so a test can echo back the requested `sessionPks`. Anything un-stubbed throws so
 * unexpected fetches fail loudly (net-connect disabled).
 */
export const responses: {
  policy: { status: number; body: string } | null;
  claim: ((req: Request, body: string) => Response | Promise<Response>) | null;
} = { policy: null, claim: null };

export function interceptPolicy(status: number, body: unknown): void {
  responses.policy = { status, body: typeof body === 'string' ? body : JSON.stringify(body) };
}

export function interceptClaim(opts: { httpStatus?: number; claim?: ClaimStatus }): void {
  if (opts.httpStatus && opts.httpStatus !== 200) {
    responses.claim = () =>
      new Response(JSON.stringify({ error: 'down' }), { status: opts.httpStatus });
    return;
  }
  responses.claim = (_req, body) => {
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

export function interceptAccepted(): void {
  interceptPolicy(200, POLICY);
  interceptClaim({ claim: 'claimed' });
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
      if (!responses.policy) throw new Error(`unexpected fetch (no policy stub): ${req.url}`);
      return new Response(responses.policy.body, { status: responses.policy.status });
    }
    if (
      req.method === 'POST' &&
      url.origin === CONVEX &&
      url.pathname === '/agent-ingest/claim-sessions'
    ) {
      if (!responses.claim) throw new Error(`unexpected fetch (no claim stub): ${req.url}`);
      return responses.claim(req, await req.text());
    }
    throw new Error(`unexpected fetch: ${req.method} ${req.url}`);
  });
}

export async function post(
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

export const authHeaders = {
  'X-Trace-Flow-Collector-Secret': SECRET,
  'Content-Type': 'application/json',
};

export function resetHandlerRequestMocks(): void {
  vi.spyOn(Date, 'now').mockReturnValue(TEST_NOW);
  __resetPolicyCache();
  responses.policy = null;
  responses.claim = null;
  installFetchMock();
}
