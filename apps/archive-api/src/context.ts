/**
 * Typed Archive API bindings. The set is intentionally narrow: Collector Credential
 * KV plus Convex policy. Forbidden classes (Body Object, Tinybird, proxy bucket,
 * agent queue) must not appear here or in wrangler.jsonc.
 */
export interface ArchiveApiEnv {
  /** Convex-synced Collector Credential records, keyed `collector:<sha256-hex-of-secret>`. */
  COLLECTOR_CREDS: KVNamespace;
  /** Convex HTTP site URL, e.g. `https://{deployment}.convex.site`. */
  CONVEX_SITE_URL: string;
  /** Shared secret for the `/archive-api/*` Convex routes (Bearer). */
  ARCHIVE_API_SHARED_SECRET: string;
  SENTRY_DSN?: string;
  SENTRY_ENVIRONMENT?: string;
  CF_VERSION_METADATA?: { id: string };
  AXIOM_TOKEN?: string;
  AXIOM_DATASET?: string;
  AXIOM_DOMAIN?: string;
}

/**
 * Binding contract mirrored by `wrangler.jsonc`. Keep these in lockstep: Archive
 * API may reuse Collector Credential KV and must not grow Body Object, Tinybird,
 * proxy-bucket, or agent-queue bindings in this authorization-boundary slice.
 */
export const ARCHIVE_API_WRANGLER_CONTRACT = {
  kv_namespaces: [{ binding: 'COLLECTOR_CREDS', id: 'f945ee3d71954ffabd364e3db385d3ab' }],
  r2_buckets: undefined as { binding: string; bucket_name: string }[] | undefined,
  queues: undefined as { producers?: { binding: string }[] } | undefined,
  proxy_bucket: undefined as string | undefined,
  agent_queue: undefined as string | undefined,
  vars: {
    SENTRY_ENVIRONMENT: 'development',
  } as Record<string, string | undefined>,
};

export const FORBIDDEN_ARCHIVE_API_BINDINGS = [
  'BODY_ENCRYPTION_ROOT_KEY',
  'BODY_ENCRYPTION_KEY_ID',
  'BODY_ACCESS_JWT_SECRET',
  'TINYBIRD_ADMIN_TOKEN',
  'TINYBIRD_API_URL',
  'AGENT_QUEUE',
  'STORAGE',
] as const;

export type ForbiddenArchiveApiBinding = (typeof FORBIDDEN_ARCHIVE_API_BINDINGS)[number];

export type ArchiveApiEnvHasNoForbiddenBindings = [
  Extract<keyof ArchiveApiEnv, ForbiddenArchiveApiBinding>,
] extends [never]
  ? true
  : never;
