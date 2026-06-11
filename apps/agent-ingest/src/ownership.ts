import type { Logger } from '@trace-flow/logging';

/**
 * First-writer session ownership. Before enqueuing a session's facts the Worker asks Convex (2a's
 * `/agent-ingest/claim-sessions`) to record the claim. The first collector to claim a `session_pk`
 * owns it; a later collector claiming the same session gets `conflict`, and the Worker drops just
 * that session's facts (one user re-pointing a second machine at the same transcript must not
 * double-write — see ADR "Session ownership").
 */

export type ClaimStatus = 'claimed' | 'owned' | 'conflict';

interface SessionClaim {
  sessionPk: string;
  status: ClaimStatus;
  ownerUserId: string;
}

/** Thrown when the control plane is unreachable; the handler maps it to a 503 so the client retries. */
export class ConvexUnreachableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ConvexUnreachableError';
  }
}

/** Convex caps the claim batch; larger claim sets are split into chunks of this size. */
const MAX_CLAIM_BATCH = 1000;

/**
 * Keep this below the collector's 30s POST timeout, but above Convex's observed response tail for
 * successful claims. A 5s cutoff caused the Worker to abort after Convex had already committed claims.
 */
const CLAIM_TIMEOUT_MS = 15000;

interface ClaimRequest {
  orgId: string;
  userId: string;
  collectorId: string;
  sessionPks: string[];
}

interface ClaimResponseBody {
  results: SessionClaim[];
}

const CLAIM_STATUSES: ReadonlySet<string> = new Set<ClaimStatus>(['claimed', 'owned', 'conflict']);

/** Guards a single claim — a missing `sessionPk`/`status` must fail closed, not silently flip a
 *  conflicted session to owned and double-write it. */
function isSessionClaim(value: unknown): value is SessionClaim {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.sessionPk === 'string' &&
    typeof v.ownerUserId === 'string' &&
    typeof v.status === 'string' &&
    CLAIM_STATUSES.has(v.status)
  );
}

/**
 * Claims session ownership for `sessionPks`. Returns the per-session statuses; the caller keeps
 * `claimed`/`owned` sessions and discards `conflict` ones. Throws {@link ConvexUnreachableError} on
 * any transport or non-2xx response so the batch fails closed with a retryable 503 rather than
 * silently writing unowned sessions. A claim set larger than {@link MAX_CLAIM_BATCH} (a legitimately
 * large ingest can exceed it) is split into chunks rather than rejected.
 */
export async function claimSessions(
  env: { CONVEX_SITE_URL: string; AGENT_INGEST_SHARED_SECRET: string },
  request: ClaimRequest,
  logger: Logger,
): Promise<SessionClaim[]> {
  if (request.sessionPks.length === 0) return [];

  const results: SessionClaim[] = [];
  for (let i = 0; i < request.sessionPks.length; i += MAX_CLAIM_BATCH) {
    const chunk = request.sessionPks.slice(i, i + MAX_CLAIM_BATCH);
    results.push(...(await claimChunk(env, { ...request, sessionPks: chunk }, logger)));
  }
  return results;
}

/** Claims one ≤{@link MAX_CLAIM_BATCH} chunk and verifies the response covers it exactly. */
async function claimChunk(
  env: { CONVEX_SITE_URL: string; AGENT_INGEST_SHARED_SECRET: string },
  request: ClaimRequest,
  logger: Logger,
): Promise<SessionClaim[]> {
  let res: Response;
  try {
    res = await fetch(`${env.CONVEX_SITE_URL}/agent-ingest/claim-sessions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.AGENT_INGEST_SHARED_SECRET}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(CLAIM_TIMEOUT_MS),
    });
  } catch (err) {
    logger.error('agent_ingest.claim_fetch_error', err);
    throw new ConvexUnreachableError('claim-sessions fetch failed', { cause: err });
  }

  if (!res.ok) {
    logger.error('agent_ingest.claim_rejected', undefined, { status: res.status });
    throw new ConvexUnreachableError(`claim-sessions returned ${res.status}`);
  }

  try {
    const body: ClaimResponseBody = await res.json();
    if (!Array.isArray(body.results)) throw new Error('response missing results array');
    if (!body.results.every(isSessionClaim)) throw new Error('response has a malformed claim');
    assertCoversExactly(request.sessionPks, body.results);
    return body.results;
  } catch (err) {
    logger.error('agent_ingest.claim_parse_error', err);
    throw new ConvexUnreachableError('claim-sessions response invalid', { cause: err });
  }
}

/**
 * Fail closed unless the response holds exactly one claim per requested session. A partial response
 * (a missing `session_pk`) would otherwise be treated as non-conflict and silently enqueued unowned;
 * a duplicate or unrequested `session_pk` signals a control-plane bug we must not trust.
 */
function assertCoversExactly(requested: string[], results: SessionClaim[]): void {
  const returned = new Set(results.map((r) => r.sessionPk));
  if (returned.size !== results.length) {
    throw new Error('claim response has a duplicate session_pk');
  }
  if (returned.size !== requested.length || !requested.every((pk) => returned.has(pk))) {
    throw new Error('claim response does not cover the requested sessions exactly');
  }
}
