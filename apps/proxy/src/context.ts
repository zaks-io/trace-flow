import type { SSEStreamData, QueueMessageUnion, SubscriptionTier } from '@trace-flow/types';
import type { ResolvedRoute } from '@trace-flow/llm-providers';
import type { Logger } from '@trace-flow/logging';
import type { EventSourceParser } from 'eventsource-parser';
import type { ApiKeyData } from './auth';
import type { UsageCheckResult } from './usage';
import type { createResponseCapture } from './streaming/capture';

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

/**
 * Threaded through the proxy pipeline (validate → forward → attach → respond → capture).
 * Each stage populates fields from its concern; downstream stages may read them.
 *
 * One record, not a chain of refined subtypes — every stage takes/returns the same
 * shape and the type system tracks "what's been filled in" by convention rather
 * than nominal narrowing.
 */
export interface CaptureContext {
  env: ProxyEnv;
  logger: Logger;

  // validate
  keyData: ApiKeyData;
  usageCheck: UsageCheckResult;
  decision: TracingDecision;
  route: ResolvedRoute;
  requestId: string;
  traceId: string;
  parentSpanId: string | undefined;
  traceFlags: number;
  traceState: string;
  baggage: Record<string, string>;
  operationName: string | undefined;
  apiKey: string;
  omitBody: boolean;

  // forward
  targetUrl: string;
  streamToCapture: ReadableStream | null;
  response: Response;
  requestStart: number;
  requestSent: number;
  responseReceived: number;

  // attach
  isSSE: boolean;
  sseStreamData: SSEStreamData;
  parser: EventSourceParser | null;
  capture: ReturnType<typeof createResponseCapture>;
  readable: ReadableStream;
  pipePromise: Promise<void> | undefined;
}
