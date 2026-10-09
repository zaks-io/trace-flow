import type { Context } from 'hono';

import type { OTLPQueueMessage, QueueMessageUnion, SubscriptionTier } from '@trace-flow/types';
import { BodySizeLimitError, getCurrentTimestamp, readBodyWithLimit } from '@trace-flow/utils';
import { captureSafeException, currentSentryTraceContext } from '@trace-flow/utils/sentry-tracing';
import { axiomConfigFromEnv, createWorkerLogger, type Logger } from '@trace-flow/logging';
import { validateApiKey, isAuthError } from '../auth';
import type { ApiKeyData } from '../auth';
import { startRecordingPolicy } from '../recordingPolicy';
import type { TracingDecision } from '../context';
import { applyTierToTraces, transformOTLPToTraces } from './transform';
import { decodeOTLPProtobuf, readOTLPBody, OTLPProtoDecodeError } from './decode';
import type { OTLPExportTraceServiceRequest, OTLPExportTraceServiceResponse } from './types';
import { validateOTLPRequest } from './validation';
import { IMPORTED_EXECUTION } from '@trace-flow/otel-conventions';
import { selectImportedScope } from './imported/selection';
import { validateImportedExecutionRequest } from './imported/validate';
import { buildImportedExecutionTraces } from './imported/traces';
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
  CONVEX_SITE_URL: string;
  USAGE_SYNC_SECRET: string;
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
interface OTLPRejection {
  logReason: string;
  errorMessage: string;
}

interface OTLPInputFailure {
  errorClass: 'client' | 'internal';
  event: string;
  status: 400 | 413 | 500;
  message: string;
  data?: Record<string, unknown>;
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

function classifyInputFailure(
  error: unknown,
  contentType: Exclude<ParsedContentType, 'unsupported'>,
): OTLPInputFailure {
  if (error instanceof BodySizeLimitError) {
    return {
      errorClass: 'client',
      event: 'otlp.request_too_large',
      status: 413,
      message: `Request body exceeds ${MAX_REQUEST_SIZE / (1024 * 1024)}MB limit`,
      data: { actualBytes: error.receivedBytes },
    };
  }
  if (error instanceof OTLPProtoDecodeError) {
    return {
      errorClass: 'client',
      event: contentType === 'protobuf' ? 'otlp.protobuf_decode_failed' : 'otlp.json_parse_failed',
      status: error.status,
      message: error.message,
    };
  }
  if (error instanceof SyntaxError && contentType === 'json') {
    return {
      errorClass: 'client',
      event: 'otlp.json_parse_failed',
      status: 400,
      message: 'Invalid JSON in request body',
    };
  }
  return {
    errorClass: 'internal',
    event: 'otlp.input_internal_failed',
    status: 500,
    message: 'Failed to process request body',
  };
}

/**
 * Emits counts after auth and usage gating. OTLP names and keys are supplied by the client and may
 * contain customer payloads, so none of them cross the logging boundary.
 */
function logPayloadSummary(
  logger: Logger,
  body: OTLPExportTraceServiceRequest,
  encoding: ParsedContentType,
  bytes: number,
): void {
  const resourceSpanCount = body.resourceSpans.length;
  let spanCount = 0;

  for (const rs of body.resourceSpans) {
    for (const ss of rs.scopeSpans) {
      spanCount += ss.spans.length;
    }
  }

  logger.info('otlp.payload_received', {
    encoding,
    bytes,
    resourceSpanCount,
    spanCount,
  });
}

/**
 * A provisional envelope that outlives a rejection is replayed by the delivery sweep, recording an
 * export the policy declined, so a failed discard is reported rather than ignored.
 */
async function discardProvisionalDelivery(
  storage: R2Bucket,
  delivery: Promise<string>,
  logger: Logger,
): Promise<void> {
  let deliveryKey: string;
  try {
    deliveryKey = await delivery;
  } catch {
    return;
  }
  try {
    await storage.delete(deliveryKey);
  } catch (err) {
    logger.error('otlp.provisional_delivery_discard_failed', undefined, { deliveryKey });
    captureSafeException(err, {
      message: 'OTLP provisional delivery discard failed',
      operation: 'otlp.delivery_discard',
    });
  } finally {
    await logger.flush();
  }
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

  // Before auth so a flood of bad keys is shed here instead of reaching Convex.
  const clientIp = c.req.header('cf-connecting-ip') ?? 'unknown';
  const ipLimit = await c.env.IP_LIMITER.limit({ key: clientIp });
  if (!ipLimit.success) {
    logger.warn('otlp.rate_limited', { reason: 'per_ip', clientIp });
    c.executionCtx.waitUntil(logger.flush());
    return c.json({ error: { code: 429, message: 'Per-IP rate limit exceeded' } }, 429, {
      'Retry-After': '60',
    });
  }

  const authResult = await validateApiKey(c, logger);
  if (isAuthError(authResult)) {
    c.executionCtx.waitUntil(logger.flush());
    return authResult;
  }
  const keyData: ApiKeyData = authResult;
  const orgLogger = keyData.orgId ? logger.child({ orgId: keyData.orgId }) : logger;

  const rawContentType = c.req.header('Content-Type');
  const contentType = classifyContentType(rawContentType);
  if (contentType === 'unsupported') {
    orgLogger.warn('otlp.unsupported_content_type', {
      contentTypePresent: rawContentType !== undefined,
    });
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
    const raw = await readBodyWithLimit(c.req.raw.body, MAX_REQUEST_SIZE);

    const decompressed = await readOTLPBody(raw, contentEncoding, MAX_REQUEST_SIZE);
    decodedBytes = decompressed.byteLength;

    if (contentType === 'protobuf') {
      body = decodeOTLPProtobuf(decompressed);
    } else {
      body = JSON.parse(new TextDecoder().decode(decompressed)) as OTLPExportTraceServiceRequest;
    }
  } catch (err) {
    const failure = classifyInputFailure(err, contentType);
    const logData = {
      compressed: contentEncoding !== undefined,
      ...failure.data,
    };
    if (failure.errorClass === 'client') {
      orgLogger.warn(failure.event, logData);
    } else {
      orgLogger.error(failure.event, undefined, logData);
      captureSafeException(err, {
        message: 'OTLP body processing failed',
        operation: 'otlp.input',
      });
    }
    c.executionCtx.waitUntil(orgLogger.flush());
    return c.json({ error: { code: failure.status, message: failure.message } }, failure.status);
  }

  const orgLimit = keyData.orgId
    ? await c.env.ORG_LIMITER.limit({ key: keyData.orgId })
    : { success: true };
  if (!orgLimit.success) {
    orgLogger.warn('otlp.rate_limited', { reason: 'per_org' });
    c.executionCtx.waitUntil(orgLogger.flush());
    return c.json({ error: { code: 429, message: 'Per-organization rate limit exceeded' } }, 429, {
      'Retry-After': '60',
    });
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

  const selection = selectImportedScope(body);
  if (selection.kind === 'invalid') {
    orgLogger.warn('otlp.imported_execution_rejected', { reason: selection.reason, spanIndex: 0 });
    c.executionCtx.waitUntil(orgLogger.flush());
    return c.json({ error: { code: 400, message: selection.reason } }, 400);
  }
  const imported =
    selection.kind === 'imported' ? validateImportedExecutionRequest(body) : undefined;
  if (imported && !imported.valid) {
    orgLogger.warn('otlp.imported_execution_rejected', {
      reason: imported.reason,
      spanIndex: imported.spanIndex,
    });
    c.executionCtx.waitUntil(orgLogger.flush());
    return c.json({ error: { code: 400, message: imported.reason } }, 400);
  }
  const apiKey = keyData.analyticsKeyId;
  // Convert milliseconds to nanoseconds for OTLP spec compliance
  const receivedAtNano = getCurrentTimestamp() * 1_000_000;
  if (imported?.valid && !keyData.orgId) {
    orgLogger.warn('otlp.rejected_no_org');
    c.executionCtx.waitUntil(orgLogger.flush());
    return c.json(
      { error: { code: 403, message: 'API key is not associated with an organization' } },
      403,
    );
  }
  const traces = imported?.valid
    ? await buildImportedExecutionTraces(imported.executions, apiKey, keyData.orgId, receivedAtNano)
    : transformOTLPToTraces(body, apiKey, receivedAtNano);

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

  const recording = await startRecordingPolicy(c.env, keyData.orgId, traces.length, orgLogger);
  const message: OTLPQueueMessage = {
    type: 'otlp',
    apiKey,
    traces,
    receivedAt: receivedAtNano,
    ...(imported?.valid
      ? { importedExecution: { contract: IMPORTED_EXECUTION.CONTRACT, orgId: keyData.orgId } }
      : {}),
    sentry_trace_context: currentSentryTraceContext(),
  };
  const persistDelivery = async (tier: SubscriptionTier | undefined): Promise<string> => {
    // The transform stamped a default tier before the org's tier was known; apply the real one now.
    applyTierToTraces(traces, receivedAtNano, tier);
    const envelope = await buildTraceDeliveryEnvelope(message);
    return persistTraceDelivery(c.env.STORAGE, envelope, c.env.TRACE_DELIVERY_NAMESPACE);
  };

  // Writing the envelope while the usage Durable Object answers keeps that round trip off the
  // response path. Every outcome that does not record must discard it.
  const provisionalDelivery =
    recording.provisionalTier === undefined
      ? undefined
      : persistDelivery(recording.provisionalTier);
  // A failed write only matters if the export is recorded, which is decided below.
  provisionalDelivery?.catch(() => undefined);
  const discardProvisional = () => {
    if (provisionalDelivery) {
      c.executionCtx.waitUntil(
        discardProvisionalDelivery(c.env.STORAGE, provisionalDelivery, orgLogger),
      );
    }
  };

  let decision: TracingDecision;
  try {
    ({ decision } = await recording.evaluation);
  } catch (err) {
    discardProvisional();
    throw err;
  }

  if (!decision.record) {
    discardProvisional();
    const rejection = otlpRejectionFor(decision.reason);
    orgLogger.warn('otlp.reject', {
      reason: rejection.logReason,
      rejectedSpans: traces.length,
    });
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

  // Sample only on the success path — rejected tenants don't cost us log volume.
  logPayloadSummary(orgLogger, body, contentType, decodedBytes);

  let deliveryKey: string;
  try {
    deliveryKey = await (provisionalDelivery ?? persistDelivery(decision.tier));
  } catch (err) {
    orgLogger.error('otlp.delivery_persist_failed', undefined, { traceCount: traces.length });
    captureSafeException(err, {
      message: 'OTLP delivery persistence failed',
      operation: 'otlp.delivery_persist',
    });
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
        orgLogger.error('otlp.enqueue_failed', undefined, {
          traceCount: traces.length,
          deliveryKey,
        });
        captureSafeException(err, {
          message: 'OTLP queue publication failed',
          operation: 'otlp.enqueue',
        });
      } finally {
        await orgLogger.flush();
      }
    })(),
  );

  const response: OTLPExportTraceServiceResponse = { partialSuccess: {} };
  c.header('X-Trace-Flow-Recording', 'true');
  if (imported?.valid) c.header('X-Trace-Flow-Contract', IMPORTED_EXECUTION.CONTRACT);
  return c.json(response, 200);
}
