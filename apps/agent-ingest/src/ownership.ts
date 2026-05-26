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

/** Convex caps the claim batch; we never send more session_pks than this in one call. */
const MAX_CLAIM_BATCH = 1000;

/** Bound the control-plane round trip so a hung Convex doesn't pin the request open. */
const CLAIM_TIMEOUT_MS = 5000;

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
 * silently writing unowned sessions.
 */
export async function claimSessions(
  env: { CONVEX_SITE_URL: string; AGENT_INGEST_SHARED_SECRET: string },
  request: ClaimRequest,
  logger: Logger,
): Promise<SessionClaim[]> {
  if (request.sessionPks.length === 0) return [];
  if (request.sessionPks.length > MAX_CLAIM_BATCH) {
    throw new Error(`claim batch ${request.sessionPks.length} exceeds max ${MAX_CLAIM_BATCH}`);
  }

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
    return body.results;
  } catch (err) {
    logger.error('agent_ingest.claim_parse_error', err);
    throw new ConvexUnreachableError('claim-sessions response invalid', { cause: err });
  }
}
