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

type PolicyResult =
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
  logger.error('agent_ingest.policy_unavailable');
  return { ok: false, reason: 'policy_unavailable' };
}

type CompatibilityCheck =
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

function parseSemver(v: string): { core: [number, number, number]; prerelease: string } {
  const noBuild = normalizeVersion(v).split('+')[0] ?? '';
  const dash = noBuild.indexOf('-');
  const core = dash === -1 ? noBuild : noBuild.slice(0, dash);
  const prerelease = dash === -1 ? '' : noBuild.slice(dash + 1);
  const parts = core.split('.').map((n) => parseInt(n, 10) || 0);
  return { core: [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0], prerelease };
}

function semverLt(a: string, b: string): boolean {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  for (let i = 0; i < 3; i++) {
    const ca = pa.core[i] ?? 0;
    const cb = pb.core[i] ?? 0;
    if (ca !== cb) return ca < cb;
  }
  // Equal cores: a prerelease (`1.2.3-beta`) has lower precedence than the release (`1.2.3`), so an
  // unsupported prerelease can't sneak past a `1.2.3` minimum. semver §11.
  if (pa.prerelease === pb.prerelease) return false;
  if (pa.prerelease === '') return false; // release ≥ any prerelease of the same core
  if (pb.prerelease === '') return true; // prerelease < release of the same core
  return comparePrerelease(pa.prerelease, pb.prerelease) < 0;
}

/** Compares dot-separated prerelease identifiers per semver §11.4 (numeric < alphanumeric). */
function comparePrerelease(a: string, b: string): number {
  const as = a.split('.');
  const bs = b.split('.');
  for (let i = 0; i < Math.max(as.length, bs.length); i++) {
    if (i >= as.length) return -1; // fewer identifiers → lower precedence
    if (i >= bs.length) return 1;
    const ai = as[i]!;
    const bi = bs[i]!;
    const aNum = /^\d+$/.test(ai);
    const bNum = /^\d+$/.test(bi);
    if (aNum && bNum) {
      const d = parseInt(ai, 10) - parseInt(bi, 10);
      if (d !== 0) return d < 0 ? -1 : 1;
    } else if (aNum !== bNum) {
      return aNum ? -1 : 1; // numeric identifiers rank below alphanumeric
    } else if (ai !== bi) {
      return ai < bi ? -1 : 1;
    }
  }
  return 0;
}
