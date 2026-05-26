import type { Logger } from '@trace-flow/logging';
import { sha256Hex } from '@trace-flow/utils';

/** Tenancy + audit identity resolved from a Collector Credential. */
export interface CollectorCredential {
  orgId: string;
  userId: string;
  collectorId: string;
  /**
   * Stable per-credential audit id. The 2a KV record does not carry the Convex document id, and the
   * hashed secret is the stable per-credential key there (rotation mints a new secret → new hash),
   * so it is the audit identity. It is internal-only and never a dedupe key (ADR "Identity").
   */
  collectorCredentialId: string;
}

/** Shape of the JSON value 2a's `syncCollectorCredToKV` writes for each credential. */
interface CollectorCredKvValue {
  orgId: string;
  userId: string;
  collectorId: string;
  expiresAt: number;
  status: 'active' | 'revoked';
  createdAt: number;
}

/** Runtime guard for the KV value — JSON.parse returns `any`, and auth must not trust the shape. */
function isCollectorCredKvValue(value: unknown): value is CollectorCredKvValue {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.orgId === 'string' &&
    typeof v.userId === 'string' &&
    typeof v.collectorId === 'string' &&
    typeof v.expiresAt === 'number' &&
    (v.status === 'active' || v.status === 'revoked')
  );
}

export type AuthFailure = 'missing' | 'invalid' | 'expired' | 'revoked';

export type AuthResult =
  | { ok: true; credential: CollectorCredential }
  | { ok: false; reason: AuthFailure };

/**
 * Validates the `X-Trace-Flow-Collector-Secret` header against the COLLECTOR_CREDS KV namespace.
 * Reads KV on every request (no cache) so revocation takes effect immediately — ingest is a
 * low-frequency batch path, not a hot path. Logs every rejection before returning.
 */
export async function authenticateCollector(
  env: { COLLECTOR_CREDS: KVNamespace },
  secret: string | undefined,
  logger: Logger,
): Promise<AuthResult> {
  if (!secret) {
    logger.warn('agent_ingest.auth_rejected', { reason: 'missing' });
    return { ok: false, reason: 'missing' };
  }

  const hashedSecret = await sha256Hex(secret);
  const raw = await env.COLLECTOR_CREDS.get(`collector:${hashedSecret}`);
  if (!raw) {
    logger.warn('agent_ingest.auth_rejected', { reason: 'invalid' });
    return { ok: false, reason: 'invalid' };
  }

  let value: CollectorCredKvValue;
  try {
    value = JSON.parse(raw) as CollectorCredKvValue;
  } catch {
    logger.error('agent_ingest.auth_cred_corrupt', undefined, { reason: 'parse_error' });
    return { ok: false, reason: 'invalid' };
  }
  // Validate shape before trusting it — a missing `expiresAt` would otherwise compare `undefined <=
  // now` as false and silently bypass expiration. 2a writes this record, but auth is a trust boundary.
  if (!isCollectorCredKvValue(value)) {
    logger.error('agent_ingest.auth_cred_corrupt', undefined, { reason: 'malformed' });
    return { ok: false, reason: 'invalid' };
  }

  if (value.status !== 'active') {
    logger.warn('agent_ingest.auth_rejected', { reason: 'revoked' });
    return { ok: false, reason: 'revoked' };
  }
  if (value.expiresAt <= Date.now()) {
    logger.warn('agent_ingest.auth_rejected', { reason: 'expired' });
    return { ok: false, reason: 'expired' };
  }

  return {
    ok: true,
    credential: {
      orgId: value.orgId,
      userId: value.userId,
      collectorId: value.collectorId,
      collectorCredentialId: hashedSecret,
    },
  };
}
