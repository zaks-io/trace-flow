import type { QueueMessageUnion, SubscriptionTier } from '@trace-flow/types';

export interface ProxyEnv {
  REQUEST_QUEUE: Queue<QueueMessageUnion>;
  STORAGE: R2Bucket;
  API_KEYS: KVNamespace;
  USAGE_TRACKER: DurableObjectNamespace;
  ORG_LIMITER: RateLimit;
  IP_LIMITER: RateLimit;
  CONVEX_SITE_URL: string;
  USAGE_SYNC_SECRET: string;
  ANALYTICS: AnalyticsEngineDataset;
  AXIOM_TOKEN?: string;
  AXIOM_DATASET?: string;
  AXIOM_DOMAIN?: string;
  SENTRY_DSN?: string;
  SENTRY_ENVIRONMENT?: string;
  BODY_ENCRYPTION_ROOT_KEY?: string;
  BODY_ENCRYPTION_KEY_ID?: string;
  CF_VERSION_METADATA?: { id: string };
}

export interface TracingDecision {
  record: boolean;
  reason: 'ok' | 'exceeded' | 'suspended' | 'canceled' | 'no_subscription' | 'internal_error';
  tier?: SubscriptionTier;
  periodEnd?: number;
}
