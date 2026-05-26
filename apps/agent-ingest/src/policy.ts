import type { Logger } from '@trace-flow/logging';

/** Compatibility policy served by 2a's `/agent-ingest/compatibility-policy` route. */
export interface CompatibilityPolicy {
  minDesktopVersion: string;
  minParserVersion: string;
  denylistedVersions: string[];
  updatedAt: number;
}

/** Runtime guard — a malformed policy must degrade/fail closed, never crash the version gate. */
function isCompatibilityPolicy(value: unknown): value is CompatibilityPolicy {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.minDesktopVersion === 'string' &&
    typeof v.minParserVersion === 'string' &&
    Array.isArray(v.denylistedVersions) &&
    v.denylistedVersions.every((x) => typeof x === 'string') &&
    typeof v.updatedAt === 'number'
  );
}

const POLICY_FRESH_TTL_MS = 60_000;

/** Bound the policy round trip; on timeout we degrade to the cached policy or fail closed. */
const POLICY_TIMEOUT_MS = 5000;

/**
 * Module-scope last-good policy, persisted across requests within a V8 isolate. Enables
 * stale-while-degraded: a transient Convex failure serves the last good policy rather than failing
 * closed, but a cold isolate with no cached policy fails closed (`policy_unavailable`).
 */
let cached: { policy: CompatibilityPolicy; fetchedAt: number } | null = null;

/** Visible for testing — clears the module-scope cache between cases. */
export function __resetPolicyCache(): void {
  cached = null;
}

export type PolicyResult =
  | { ok: true; policy: CompatibilityPolicy; degraded: boolean }
  | { ok: false; reason: 'policy_unavailable' };

/**
 * Returns the active compatibility policy, edge-cached for 60s. On a fetch failure it serves the
 * last good policy (degraded) if one exists, else fails closed — a cold-miss plus an unreachable
 * control plane must never fail open into accepting unknown-version uploads.
 */
export async function getCompatibilityPolicy(
  env: { CONVEX_SITE_URL: string; AGENT_INGEST_SHARED_SECRET: string },
  logger: Logger,
): Promise<PolicyResult> {
  if (cached && Date.now() - cached.fetchedAt < POLICY_FRESH_TTL_MS) {
    return { ok: true, policy: cached.policy, degraded: false };
  }

  try {
    const res = await fetch(`${env.CONVEX_SITE_URL}/agent-ingest/compatibility-policy`, {
      headers: { Authorization: `Bearer ${env.AGENT_INGEST_SHARED_SECRET}` },
      signal: AbortSignal.timeout(POLICY_TIMEOUT_MS),
    });
    if (!res.ok) {
      logger.error('agent_ingest.policy_fetch_failed', undefined, { status: res.status });
      return degradeOrFail(logger);
    }
    const parsed: unknown = await res.json();
    if (!isCompatibilityPolicy(parsed)) {
      logger.error('agent_ingest.policy_malformed');
      return degradeOrFail(logger);
    }
    cached = { policy: parsed, fetchedAt: Date.now() };
    return { ok: true, policy: parsed, degraded: false };
  } catch (err) {
    logger.error('agent_ingest.policy_fetch_error', err);
    return degradeOrFail(logger);
  }
}

function degradeOrFail(logger: Logger): PolicyResult {
  if (cached) {
    logger.warn('agent_ingest.policy_degraded', { fetchedAt: cached.fetchedAt });
    return { ok: true, policy: cached.policy, degraded: true };
  }
  return { ok: false, reason: 'policy_unavailable' };
}

export type CompatibilityCheck =
  | { ok: true }
  | { ok: false; detail: 'denylisted_version' | 'desktop_below_min' | 'parser_below_min' };

/** Hard-blocks denylisted versions and any desktop/parser version below the policy minimum. */
export function checkCompatibility(
  policy: CompatibilityPolicy,
  desktopVersion: string,
  parserVersion: string,
): CompatibilityCheck {
  // Normalize the same way `semverLt` does (strip a leading `v`) so a denylisted `1.2.3` can't be
  // slipped past by sending `v1.2.3` (or vice versa) — the min-version gate normalizes, so this must.
  const denylisted = new Set(policy.denylistedVersions.map(normalizeVersion));
  if (
    denylisted.has(normalizeVersion(desktopVersion)) ||
    denylisted.has(normalizeVersion(parserVersion))
  ) {
    return { ok: false, detail: 'denylisted_version' };
  }
  if (semverLt(desktopVersion, policy.minDesktopVersion)) {
    return { ok: false, detail: 'desktop_below_min' };
  }
  if (semverLt(parserVersion, policy.minParserVersion)) {
    return { ok: false, detail: 'parser_below_min' };
  }
  return { ok: true };
}

/** Strips only a leading `v`; keeps any prerelease/build so a denylist can target `1.2.3-beta`. */
function normalizeVersion(v: string): string {
  return v.replace(/^v/, '');
}

function parseSemver(v: string): [number, number, number] {
  const core = normalizeVersion(v).split('+')[0]?.split('-')[0] ?? '';
  const parts = core.split('.').map((n) => parseInt(n, 10) || 0);
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
}

function semverLt(a: string, b: string): boolean {
  const [a0, a1, a2] = parseSemver(a);
  const [b0, b1, b2] = parseSemver(b);
  if (a0 !== b0) return a0 < b0;
  if (a1 !== b1) return a1 < b1;
  return a2 < b2;
}
