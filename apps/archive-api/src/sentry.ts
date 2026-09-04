import * as Sentry from '@sentry/cloudflare';
import type { CloudflareOptions } from '@sentry/cloudflare';
import { TRACE_FLOW_PROPAGATION_TARGETS } from '@trace-flow/utils/sentry-tracing';
import type { ArchiveApiEnv } from './context';

/** Incoming request bodies are never attached to Archive API Sentry telemetry. */
export const ARCHIVE_API_SENTRY_MAX_REQUEST_BODY_SIZE = 'none' as const;

/**
 * Archive credential / grant headers. Keys and values must not appear on Sentry
 * events or spans. Authorization and Cookie are the wrong credential class and
 * are scrubbed the same way so they cannot leak through default request handling.
 */
export const ARCHIVE_API_SENTRY_REDACTED_HEADERS = [
  'x-trace-flow-collector-secret',
  'x-trace-flow-archive-export-grant',
  'authorization',
  'cookie',
] as const;

const REDACTED_HEADER_FRAGMENTS = ARCHIVE_API_SENTRY_REDACTED_HEADERS.map((name) =>
  name.replace(/-/g, '_'),
);

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[.-]/g, '_');
}

function isRedactedHeaderKey(key: string): boolean {
  const normalized = normalizeKey(key);
  return REDACTED_HEADER_FRAGMENTS.some(
    (fragment) =>
      normalized === fragment ||
      normalized.endsWith(`_${fragment}`) ||
      normalized.endsWith(`.${fragment}`),
  );
}

function isRequestBodyKey(key: string, parentKey: string | undefined): boolean {
  const normalized = normalizeKey(key);
  if (normalized === 'http_request_body_data' || normalized.endsWith('_http_request_body_data')) {
    return true;
  }
  return parentKey === 'request' && (normalized === 'data' || normalized === 'body');
}

function isDroppedKey(key: string, parentKey: string | undefined): boolean {
  if (isRedactedHeaderKey(key) || isRequestBodyKey(key, parentKey)) return true;
  if (parentKey === 'headers' && isRedactedHeaderKey(key)) return true;
  if (parentKey === 'request' && normalizeKey(key) === 'cookies') return true;
  return false;
}

/**
 * Fail-closed redaction for anything Sentry is about to send. Drops request
 * bodies and archive credential/grant headers from events, transactions, and
 * spans. Distributed-trace fields are left intact.
 */
export function redactArchiveApiSentryPayload<T>(payload: T, parentKey?: string): T {
  if (Array.isArray(payload)) {
    const redacted: unknown[] = [];
    for (const item of payload) {
      redacted.push(redactArchiveApiSentryPayload(item, parentKey));
    }
    return redacted as T;
  }
  if (payload === null || typeof payload !== 'object') {
    return payload;
  }

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
    if (isDroppedKey(key, parentKey)) continue;
    out[key] = redactArchiveApiSentryPayload(
      value,
      normalizeKey(key) === 'headers' ? 'headers' : key,
    );
  }
  return out as T;
}

export function createArchiveApiSentryOptions(env: ArchiveApiEnv): CloudflareOptions {
  return {
    dsn: env.SENTRY_DSN,
    release: env.CF_VERSION_METADATA?.id,
    environment: env.SENTRY_ENVIRONMENT ?? 'development',
    tracesSampleRate: 1.0,
    sendDefaultPii: false,
    tracePropagationTargets: TRACE_FLOW_PROPAGATION_TARGETS,
    integrations(defaults) {
      return defaults.map((integration) => {
        if (integration.name === 'HttpServer') {
          return Sentry.httpServerIntegration({
            maxRequestBodySize: ARCHIVE_API_SENTRY_MAX_REQUEST_BODY_SIZE,
          });
        }
        if (integration.name === 'RequestData') {
          return Sentry.requestDataIntegration({
            include: {
              cookies: false,
              data: false,
              headers: false,
              ip: false,
              query_string: true,
              url: true,
            },
          });
        }
        return integration;
      });
    },
    beforeSend(event) {
      return redactArchiveApiSentryPayload(event);
    },
    beforeSendTransaction(event) {
      return redactArchiveApiSentryPayload(event);
    },
    beforeSendSpan(span) {
      return redactArchiveApiSentryPayload(span);
    },
  };
}
