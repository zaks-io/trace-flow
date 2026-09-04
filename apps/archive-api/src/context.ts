/**
 * Typed Archive API bindings. The Worker owns the archive bucket, session ledger,
 * and wrapped-key boundary. Forbidden classes (Body Object, Tinybird, proxy bucket,
 * agent queue) must not appear here or in wrangler.jsonc.
 */
export interface ArchiveApiEnv {
  /** Convex-synced Collector Credential records, keyed `collector:<sha256-hex-of-secret>`. */
  COLLECTOR_CREDS: KVNamespace;
  /** Convex HTTP site URL, e.g. `https://{deployment}.convex.site`. */
  CONVEX_SITE_URL: string;
  /** Shared secret for the `/archive-api/*` Convex routes (Bearer). */
  ARCHIVE_API_SHARED_SECRET: string;
  /** Dedicated Agent Archive R2 bucket. */
  ARCHIVE_STORAGE: R2Bucket;
  /** Session ledger keyed by server-derived Organization/contribution/source/session. */
  ARCHIVE_SESSION_LEDGER: DurableObjectNamespace;
  /** Active Archive Encryption Key version selected by server configuration. */
  ARCHIVE_KEY_VERSION: string;
  /** Secret used only to unwrap the per-Organization Archive Encryption Key. */
  ARCHIVE_KEY_WRAPPING_SECRET: string;
  SENTRY_DSN?: string;
  SENTRY_ENVIRONMENT?: string;
  CF_VERSION_METADATA?: { id: string };
  AXIOM_TOKEN?: string;
  AXIOM_DATASET?: string;
  AXIOM_DOMAIN?: string;
}

/**
 * Binding contract mirrored by `wrangler.jsonc`. Keep these in lockstep: Archive
 * API owns only the dedicated archive storage and ledger in addition to Collector
 * Credential KV and Convex policy.
 */
export const ARCHIVE_API_WRANGLER_CONTRACT = {
  kv_namespaces: [{ binding: 'COLLECTOR_CREDS', id: 'f945ee3d71954ffabd364e3db385d3ab' }],
  r2_buckets: [
    { binding: 'ARCHIVE_STORAGE', bucket_name: 'trace-flow-agent-archive-dev', jurisdiction: 'us' },
  ],
  durable_objects: [{ binding: 'ARCHIVE_SESSION_LEDGER', class_name: 'ArchiveSessionLedger' }],
  queues: undefined as { producers?: { binding: string }[] } | undefined,
  proxy_bucket: undefined as string | undefined,
  agent_queue: undefined as string | undefined,
  vars: {
    SENTRY_ENVIRONMENT: 'development',
    ARCHIVE_KEY_VERSION: '1',
  } as Record<string, string | undefined>,
};

export const FORBIDDEN_ARCHIVE_API_BINDINGS = [
  'BODY_ENCRYPTION_ROOT_KEY',
  'BODY_ENCRYPTION_KEY_ID',
  'BODY_ACCESS_JWT_SECRET',
  'TINYBIRD_ADMIN_TOKEN',
  'TINYBIRD_API_URL',
  'AGENT_QUEUE',
] as const;

export type ForbiddenArchiveApiBinding = (typeof FORBIDDEN_ARCHIVE_API_BINDINGS)[number];

export type ArchiveApiEnvHasNoForbiddenBindings = [
  Extract<keyof ArchiveApiEnv, ForbiddenArchiveApiBinding>,
] extends [never]
  ? true
  : never;
