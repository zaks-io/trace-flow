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

interface Env {
  REQUEST_QUEUE: Queue<QueueMessageUnion>;
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
// Bounds on attribute values logged from user payloads: prevents a single malicious
// span from ballooning our Axiom ingest, and caps the cost of a sampled request.
const LOG_VALUE_MAX_CHARS = 256;
const LOG_KEY_MAX_CHARS = 128;
const LOG_MAX_ATTRS = 20;
const LOG_MAX_SERVICE_NAMES = 10;
const LOG_MAX_SPAN_NAMES = 10;
const LOG_MAX_ATTR_KEYS = 50;
// Keys we refuse to include in logs because downstream consumers (and JSON
// serializers) treat them as object-shape metadata.
const LOG_FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

interface ValidationResult {
  valid: boolean;
  error?: string;
  rejectedSpans?: number;
}

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

function validateOTLPRequest(request: unknown): ValidationResult {
  if (!request || typeof request !== 'object') {
    return { valid: false, error: 'Request body must be an object' };
  }

  const req = request as OTLPExportTraceServiceRequest;

  if (!Array.isArray(req.resourceSpans)) {
    return { valid: false, error: 'resourceSpans must be an array' };
  }

  let spanCount = 0;

  for (const resourceSpan of req.resourceSpans) {
    if (!resourceSpan || typeof resourceSpan !== 'object') {
      return { valid: false, error: 'Each resourceSpan must be an object' };
    }

    if (!Array.isArray(resourceSpan.scopeSpans)) {
      return { valid: false, error: 'scopeSpans must be an array' };
    }

    for (const scopeSpan of resourceSpan.scopeSpans) {
      if (!scopeSpan || typeof scopeSpan !== 'object') {
        return { valid: false, error: 'Each scopeSpan must be an object' };
      }

      if (!Array.isArray(scopeSpan.spans)) {
        return { valid: false, error: 'spans must be an array' };
      }

      for (const span of scopeSpan.spans) {
        spanCount++;
        const spanValidation = validateSpan(span, spanCount);
        if (!spanValidation.valid) {
          return spanValidation;
        }
      }
    }
  }

  return { valid: true };
}

/**
 * OTLP timestamps are integer nanoseconds carried as a decimal string (or, loosely, a JSON
 * number). `transformSpan` feeds them to `BigInt()`, which throws on non-integer numbers
 * (`1.5`), exponent strings (`"1e18"`), and non-numeric strings (`"abc"`). Validate up front so a
 * malformed exporter gets a 400 instead of an uncaught 500 the SDK would retry.
 */
function isIntegerNano(value: unknown): boolean {
  if (typeof value === 'number') return Number.isInteger(value);
  if (typeof value === 'string') return /^-?\d+$/.test(value);
  return false;
}

function validateSpan(span: unknown, spanIndex: number): ValidationResult {
  if (!span || typeof span !== 'object') {
    return { valid: false, error: `Span ${spanIndex} must be an object` };
  }

  const s = span as Record<string, unknown>;

  if (!s.traceId || typeof s.traceId !== 'string') {
    return { valid: false, error: `Span ${spanIndex}: traceId is required and must be a string` };
  }

  if (!s.spanId || typeof s.spanId !== 'string') {
    return { valid: false, error: `Span ${spanIndex}: spanId is required and must be a string` };
  }

  if (!s.name || typeof s.name !== 'string') {
    return { valid: false, error: `Span ${spanIndex}: name is required and must be a string` };
  }

  if (!s.startTimeUnixNano) {
    return { valid: false, error: `Span ${spanIndex}: startTimeUnixNano is required` };
  }
  if (!isIntegerNano(s.startTimeUnixNano)) {
    return {
      valid: false,
      error: `Span ${spanIndex}: startTimeUnixNano must be an integer nanosecond value`,
    };
  }

  if (!s.endTimeUnixNano) {
    return { valid: false, error: `Span ${spanIndex}: endTimeUnixNano is required` };
  }
  if (!isIntegerNano(s.endTimeUnixNano)) {
    return {
      valid: false,
      error: `Span ${spanIndex}: endTimeUnixNano must be an integer nanosecond value`,
    };
  }

  return { valid: true };
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

function sanitizeLogValue(value: unknown): unknown {
  if (typeof value === 'string') return truncate(value, LOG_VALUE_MAX_CHARS);
  return value;
}

/**
 * Emits a bounded snapshot of the ingested payload so we can verify the real
 * data shape from new OTLP clients. Runs only after auth + billing + usage
 * gating to avoid logging for tenants we are already rejecting, and all
 * user-supplied keys/values are length-capped and sanitized.
 */
function logPayloadSample(
  logger: Logger,
  body: OTLPExportTraceServiceRequest,
  encoding: ParsedContentType,
  bytes: number,
): void {
  const resourceSpanCount = body.resourceSpans.length;
  let spanCount = 0;
  const serviceNames = new Set<string>();
  const scopeNames = new Set<string>();
  const spanNames: string[] = [];
  const attributeKeys = new Set<string>();
  let firstSpanAttrs: Record<string, unknown> | undefined;

  outer: for (const rs of body.resourceSpans) {
    const svc = rs.resource?.attributes?.find((a) => a.key === 'service.name');
    if (svc && serviceNames.size < LOG_MAX_SERVICE_NAMES) {
      const v = svc.value;
      const name =
        v.stringValue ??
        v.intValue ??
        (v.boolValue !== undefined ? String(v.boolValue) : undefined);
      if (name) serviceNames.add(truncate(name, LOG_VALUE_MAX_CHARS));
    }
    for (const ss of rs.scopeSpans) {
      if (ss.scope?.name) scopeNames.add(truncate(ss.scope.name, LOG_KEY_MAX_CHARS));
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
        if (!firstSpanAttrs && span.attributes && span.attributes.length > 0) {
          firstSpanAttrs = {};
          for (const attr of span.attributes.slice(0, LOG_MAX_ATTRS)) {
            const k = sanitizeLogKey(attr.key);
            if (!k) continue;
            const v = attr.value;
            const raw =
              v.stringValue ??
              v.intValue ??
              v.doubleValue ??
              v.boolValue ??
              (v.arrayValue ? '<array>' : v.kvlistValue ? '<kvlist>' : undefined);
            firstSpanAttrs[k] = sanitizeLogValue(raw);
          }
          // Early exit: one span's attributes is enough to verify shape.
          if (firstSpanAttrs) break outer;
        }
      }
    }
  }

  logger.info('otlp.payload_received', {
    encoding,
    bytes,
    resourceSpanCount,
    spanCount,
    serviceNames: [...serviceNames],
    scopeNames: [...scopeNames],
    spanNamesSample: spanNames,
    attributeKeys: [...attributeKeys],
    firstSpanAttributes: firstSpanAttrs,
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
    return c.json(
      {
        error: {
          code: 400,
          message: validation.error,
        },
      },
      400,
    );
  }

  const apiKey = c.req.header('X-Trace-Flow-Api-Key') ?? '';
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

  c.executionCtx.waitUntil(
    (async () => {
      try {
        await c.env.REQUEST_QUEUE.send(message);
        orgLogger.info('otlp.enqueued', {
          encoding: contentType,
          spanCount: traces.length,
          resourceSpanCount: body.resourceSpans.length,
        });
      } catch (err) {
        orgLogger.error('otlp.enqueue_failed', err, {
          traceCount: traces.length,
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
