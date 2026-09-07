import type { Context } from 'hono';
import type { OTLPQueueMessage, QueueMessageUnion } from '@trace-flow/types';
import { getCurrentTimestamp } from '@trace-flow/utils';
import { currentSentryTraceContext } from '@trace-flow/utils/sentry-tracing';
import { axiomConfigFromEnv, createWorkerLogger, type Logger } from '@trace-flow/logging';
import { validateApiKey, isAuthError } from '../auth';
import type { ApiKeyData } from '../auth';
import { evaluateRecordingPolicy } from '../recordingPolicy';
import type { TracingDecision } from '../context';
import { applyTierToTraces, transformOTLPToTraces } from './transform';
import { decodeOTLPProtobuf, readOTLPBody, OTLPProtoDecodeError } from './decode';
import type { OTLPExportTraceServiceRequest, OTLPExportTraceServiceResponse } from './types';
import { validateOTLPRequest } from './validation';
import {
  buildTraceDeliveryEnvelope,
  enqueueTraceDelivery,
  persistTraceDelivery,
} from '../delivery';

interface Env {
  REQUEST_QUEUE: Queue<QueueMessageUnion>;
  STORAGE: R2Bucket;
  TRACE_DELIVERY_NAMESPACE: string;
  API_KEYS: KVNamespace;
  USAGE_TRACKER: DurableObjectNamespace;
  ORG_LIMITER: RateLimit;
  IP_LIMITER: RateLimit;
  AXIOM_TOKEN?: string;
  AXIOM_DATASET?: string;
  AXIOM_DOMAIN?: string;
}

const MAX_REQUEST_SIZE = 10 * 1024 * 1024; // 10MB, pre- and post-decompression
const JSON_CONTENT_TYPE = 'application/json';
const PROTOBUF_CONTENT_TYPE = 'application/x-protobuf';
const LOG_VALUE_MAX_CHARS = 256;
const LOG_KEY_MAX_CHARS = 128;
const LOG_MAX_SCOPE_NAMES = 10;
const LOG_MAX_SPAN_NAMES = 10;
const LOG_MAX_ATTR_KEYS = 50;
// Keys we refuse to include in logs because downstream consumers (and JSON
// serializers) treat them as object-shape metadata.
const LOG_FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

interface OTLPRejection {
  logReason: string;
  errorMessage: string;
}

function otlpRejectionFor(reason: TracingDecision['reason']): OTLPRejection {
  switch (reason) {
    case 'suspended':
      return { logReason: 'suspended', errorMessage: 'Account suspended' };
    case 'canceled':
      return { logReason: 'canceled', errorMessage: 'Account canceled' };
    case 'no_subscription':
      return { logReason: 'not_found', errorMessage: 'Subscription not found' };
    case 'exceeded':
      return { logReason: 'exceeded', errorMessage: 'Usage limit exceeded' };
    case 'internal_error':
      return { logReason: 'usage_error', errorMessage: 'Usage check failed' };
    case 'ok':
      throw new Error('otlpRejectionFor called with reason=ok');
  }
}

type ParsedContentType = 'json' | 'protobuf' | 'unsupported';

function classifyContentType(contentType: string | undefined): ParsedContentType {
  if (!contentType) return 'unsupported';
  if (contentType.includes(JSON_CONTENT_TYPE)) return 'json';
  if (contentType.includes(PROTOBUF_CONTENT_TYPE)) return 'protobuf';
  return 'unsupported';
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function sanitizeLogKey(key: string): string | null {
  if (LOG_FORBIDDEN_KEYS.has(key)) return null;
  return truncate(key, LOG_KEY_MAX_CHARS);
}

/**
 * Emits bounded structural metadata after auth and usage gating. Attribute values never enter logs.
 */
function logPayloadSample(
  logger: Logger,
  body: OTLPExportTraceServiceRequest,
  encoding: ParsedContentType,
  bytes: number,
): void {
  const resourceSpanCount = body.resourceSpans.length;
  let spanCount = 0;
  const scopeNames = new Set<string>();
  const spanNames: string[] = [];
  const attributeKeys = new Set<string>();

  for (const rs of body.resourceSpans) {
    for (const ss of rs.scopeSpans) {
      if (ss.scope?.name && scopeNames.size < LOG_MAX_SCOPE_NAMES) {
        scopeNames.add(truncate(ss.scope.name, LOG_KEY_MAX_CHARS));
      }
      for (const span of ss.spans) {
        spanCount++;
        if (spanNames.length < LOG_MAX_SPAN_NAMES) {
          spanNames.push(truncate(span.name, LOG_VALUE_MAX_CHARS));
        }
        if (span.attributes) {
          for (const attr of span.attributes) {
            if (attributeKeys.size >= LOG_MAX_ATTR_KEYS) break;
            const k = sanitizeLogKey(attr.key);
            if (k) attributeKeys.add(k);
          }
        }
      }
    }
  }

  logger.info('otlp.payload_received', {
    encoding,
    bytes,
    resourceSpanCount,
    spanCount,
    scopeNames: [...scopeNames],
    spanNamesSample: spanNames,
    attributeKeys: [...attributeKeys],
  });
}

/**
 * Handles OTLP trace ingestion requests.
 * Accepts OTLP/HTTP in both JSON (application/json) and protobuf
 * (application/x-protobuf) encodings, with optional gzip/deflate compression.
 */
export async function handleOTLPTraces(c: Context<{ Bindings: Env }>): Promise<Response> {
  const logger = createWorkerLogger({
    service: 'proxy',
    request: c.req.raw,
    axiom: axiomConfigFromEnv(c.env),
    context: { component: 'otlp' },
  });

  const authResult = await validateApiKey(c, logger);
  if (isAuthError(authResult)) {
    c.executionCtx.waitUntil(logger.flush());
    return authResult;
  }
  const keyData: ApiKeyData = authResult;
  const orgLogger = keyData.orgId ? logger.child({ orgId: keyData.orgId }) : logger;

  const clientIp = c.req.header('cf-connecting-ip') ?? 'unknown';
  const [ipLimit, orgLimit] = await Promise.all([
    c.env.IP_LIMITER.limit({ key: clientIp }),
    keyData.orgId
      ? c.env.ORG_LIMITER.limit({ key: keyData.orgId })
      : Promise.resolve({ success: true }),
  ]);

  if (!ipLimit.success) {
    orgLogger.warn('otlp.rate_limited', { reason: 'per_ip', clientIp });
    c.executionCtx.waitUntil(orgLogger.flush());
    return c.json({ error: { code: 429, message: 'Per-IP rate limit exceeded' } }, 429, {
      'Retry-After': '60',
    });
  }

  if (!orgLimit.success) {
    orgLogger.warn('otlp.rate_limited', { reason: 'per_org' });
    c.executionCtx.waitUntil(orgLogger.flush());
    return c.json({ error: { code: 429, message: 'Per-organization rate limit exceeded' } }, 429, {
      'Retry-After': '60',
    });
  }

  const rawContentType = c.req.header('Content-Type');
  const contentType = classifyContentType(rawContentType);
  if (contentType === 'unsupported') {
    orgLogger.warn('otlp.unsupported_content_type', { contentType: rawContentType });
    c.executionCtx.waitUntil(orgLogger.flush());
    return c.json(
      {
        error: {
          code: 415,
          message: `Unsupported content type. Use ${JSON_CONTENT_TYPE} or ${PROTOBUF_CONTENT_TYPE}`,
        },
      },
      415,
    );
  }

  const contentLength = parseInt(c.req.header('Content-Length') ?? '0', 10);
  if (contentLength > MAX_REQUEST_SIZE) {
    orgLogger.warn('otlp.request_too_large', { contentLength });
    c.executionCtx.waitUntil(orgLogger.flush());
    return c.json(
      {
        error: {
          code: 413,
          message: `Request body exceeds ${MAX_REQUEST_SIZE / (1024 * 1024)}MB limit`,
        },
      },
      413,
    );
  }

  const contentEncoding = c.req.header('Content-Encoding') ?? undefined;
  let body: OTLPExportTraceServiceRequest;
  let decodedBytes = 0;

  try {
    const raw = await c.req.raw.arrayBuffer();
    // Catches chunked requests that omitted Content-Length; readOTLPBody
    // enforces the same cap again post-decompression.
    if (raw.byteLength > MAX_REQUEST_SIZE) {
      orgLogger.warn('otlp.request_too_large', { actualBytes: raw.byteLength });
      c.executionCtx.waitUntil(orgLogger.flush());
      return c.json(
        {
          error: {
            code: 413,
            message: `Request body exceeds ${MAX_REQUEST_SIZE / (1024 * 1024)}MB limit`,
          },
        },
        413,
      );
    }

    const decompressed = await readOTLPBody(raw, contentEncoding, MAX_REQUEST_SIZE);
    decodedBytes = decompressed.byteLength;

    if (contentType === 'protobuf') {
      body = decodeOTLPProtobuf(decompressed);
    } else {
      body = JSON.parse(new TextDecoder().decode(decompressed)) as OTLPExportTraceServiceRequest;
    }
  } catch (err) {
    const event =
      contentType === 'protobuf' ? 'otlp.protobuf_decode_failed' : 'otlp.json_parse_failed';
    orgLogger.error(event, err, { contentEncoding });
    c.executionCtx.waitUntil(orgLogger.flush());
    const message =
      err instanceof OTLPProtoDecodeError
        ? err.message
        : contentType === 'protobuf'
          ? 'Invalid protobuf payload'
          : 'Invalid JSON in request body';
    return c.json({ error: { code: 400, message } }, 400);
  }

  const validation = validateOTLPRequest(body);
  if (!validation.valid) {
    orgLogger.warn('otlp.validation_failed', {
      encoding: contentType,
      error: validation.error,
    });
    c.executionCtx.waitUntil(orgLogger.flush());
    const status = validation.status ?? 400;
    return c.json(
      {
        error: {
          code: status,
          message: validation.error,
        },
      },
      status,
    );
  }

  const apiKey = keyData.analyticsKeyId;
  // Convert milliseconds to nanoseconds for OTLP spec compliance
  const receivedAtNano = getCurrentTimestamp() * 1_000_000;
  const traces = transformOTLPToTraces(body, apiKey, receivedAtNano);

  if (traces.length === 0) {
    const response: OTLPExportTraceServiceResponse = { partialSuccess: {} };
    c.executionCtx.waitUntil(orgLogger.flush());
    return c.json(response, 200);
  }

  if (!keyData.orgId) {
    orgLogger.warn('otlp.rejected_no_org');
    c.executionCtx.waitUntil(orgLogger.flush());
    return c.json(
      {
        error: {
          code: 403,
          message: 'API key is not associated with an organization',
        },
      },
      403,
    );
  }

  const { decision } = await evaluateRecordingPolicy(
    c.env,
    keyData.orgId,
    traces.length,
    orgLogger,
  );

  if (!decision.record) {
    const rejection = otlpRejectionFor(decision.reason);
    orgLogger.warn('otlp.reject', { reason: rejection.logReason, rejectedSpans: traces.length });
    if (decision.reason === 'internal_error') {
      c.executionCtx.waitUntil(orgLogger.flush());
      return c.json({ error: { code: 503, message: rejection.errorMessage } }, 503, {
        'Retry-After': '1',
      });
    }
    const response: OTLPExportTraceServiceResponse = {
      partialSuccess: { rejectedSpans: traces.length, errorMessage: rejection.errorMessage },
    };
    c.header('X-Trace-Flow-Recording', 'false');
    c.executionCtx.waitUntil(orgLogger.flush());
    return c.json(response, 200);
  }

  // The transform stamped a default tier before the org's tier was known; apply the real one now.
  applyTierToTraces(traces, receivedAtNano, decision.tier);

  // Sample only on the success path — rejected tenants don't cost us log volume.
  logPayloadSample(orgLogger, body, contentType, decodedBytes);

  const message: OTLPQueueMessage = {
    type: 'otlp',
    apiKey,
    traces,
    receivedAt: receivedAtNano,
    sentry_trace_context: currentSentryTraceContext(),
  };

  let deliveryKey: string;
  try {
    const envelope = await buildTraceDeliveryEnvelope(message);
    deliveryKey = await persistTraceDelivery(
      c.env.STORAGE,
      envelope,
      c.env.TRACE_DELIVERY_NAMESPACE,
    );
  } catch (err) {
    orgLogger.error('otlp.delivery_persist_failed', err, { traceCount: traces.length });
    c.executionCtx.waitUntil(orgLogger.flush());
    return c.json({ error: { code: 503, message: 'Trace persistence failed' } }, 503, {
      'Retry-After': '1',
    });
  }

  c.executionCtx.waitUntil(
    (async () => {
      try {
        await enqueueTraceDelivery(c.env.REQUEST_QUEUE, deliveryKey, message);
        orgLogger.info('otlp.enqueued', {
          encoding: contentType,
          spanCount: traces.length,
          resourceSpanCount: body.resourceSpans.length,
          deliveryKey,
        });
      } catch (err) {
        orgLogger.error('otlp.enqueue_failed', err, {
          traceCount: traces.length,
          deliveryKey,
        });
      } finally {
        await orgLogger.flush();
      }
    })(),
  );

  const response: OTLPExportTraceServiceResponse = { partialSuccess: {} };
  c.header('X-Trace-Flow-Recording', 'true');
  return c.json(response, 200);
}
