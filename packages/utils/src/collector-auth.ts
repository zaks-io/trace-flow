import { sha256Hex } from './crypto';

/** Tenancy + audit identity resolved from a Collector Credential. */
export interface CollectorCredential {
  orgId: string;
  userId: string;
  collectorId: string;
  /**
   * Stable per-credential audit id. The KV record does not carry the Convex document id, and the
   * hashed secret is the stable per-credential key there (rotation mints a new secret → new hash),
   * so it is the audit identity. It is internal-only and never a dedupe key (ADR "Identity").
   */
  collectorCredentialId: string;
}

/** Shape of the JSON value Convex writes for each Collector Credential KV record. */
export interface CollectorCredKvValue {
  orgId: string;
  userId: string;
  collectorId: string;
  expiresAt: number;
  status: 'active' | 'revoked';
  createdAt: number;
}

/** Minimal KV read surface so Workers and unit tests share the same auth path. */
export interface CollectorCredStore {
  get(key: string): Promise<string | null>;
}

/** Structured logger events only — never request bodies or secrets. */
export interface CollectorAuthLogger {
  warn(event: string, data?: Record<string, unknown>): void;
  error(event: string, error?: unknown, data?: Record<string, unknown>): void;
}

export type CollectorAuthFailure = 'missing' | 'invalid' | 'expired' | 'revoked';

export type CollectorAuthResult =
  | { ok: true; credential: CollectorCredential }
  | { ok: false; reason: CollectorAuthFailure };

/** Runtime guard for the KV value — JSON.parse returns unknown, and auth must not trust the shape. */
export function isCollectorCredKvValue(value: unknown): value is CollectorCredKvValue {
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

export function collectorCredKvKey(hashedSecret: string): string {
  return `collector:${hashedSecret}`;
}

/**
 * Validates a Collector Credential secret against the COLLECTOR_CREDS KV namespace.
 * Reads KV on every request (no cache) so revocation takes effect immediately.
 */
export async function authenticateCollectorCredential(
  store: CollectorCredStore,
  secret: string | undefined,
  logger: CollectorAuthLogger,
  eventPrefix = 'collector_auth',
): Promise<CollectorAuthResult> {
  if (!secret) {
    logger.warn(`${eventPrefix}.auth_rejected`, { reason: 'missing' });
    return { ok: false, reason: 'missing' };
  }

  const hashedSecret = await sha256Hex(secret);
  const raw = await store.get(collectorCredKvKey(hashedSecret));
  if (!raw) {
    logger.warn(`${eventPrefix}.auth_rejected`, { reason: 'invalid' });
    return { ok: false, reason: 'invalid' };
  }

  let value: CollectorCredKvValue;
  try {
    value = JSON.parse(raw) as CollectorCredKvValue;
  } catch {
    logger.error(`${eventPrefix}.auth_cred_corrupt`, undefined, { reason: 'parse_error' });
    return { ok: false, reason: 'invalid' };
  }
  if (!isCollectorCredKvValue(value)) {
    logger.error(`${eventPrefix}.auth_cred_corrupt`, undefined, { reason: 'malformed' });
    return { ok: false, reason: 'invalid' };
  }

  if (value.status !== 'active') {
    logger.warn(`${eventPrefix}.auth_rejected`, { reason: 'revoked' });
    return { ok: false, reason: 'revoked' };
  }
  if (value.expiresAt <= Date.now()) {
    logger.warn(`${eventPrefix}.auth_rejected`, { reason: 'expired' });
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
