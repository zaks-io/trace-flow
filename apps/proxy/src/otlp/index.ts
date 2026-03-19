import type { Context } from 'hono';
import type { OTLPQueueMessage, QueueMessageUnion } from '@trace-flow/types';
import { getCurrentTimestamp } from '@trace-flow/utils';
import { validateApiKey, isAuthError, checkBillingStatus } from '../auth';
import type { ApiKeyData } from '../auth';
import { checkUsage } from '../usage';
import { transformOTLPToTraces } from './transform';
import type { OTLPExportTraceServiceRequest, OTLPExportTraceServiceResponse } from './types';

interface Env {
  REQUEST_QUEUE: Queue<QueueMessageUnion>;
  API_KEYS: KVNamespace;
  USAGE_TRACKER: DurableObjectNamespace;
}

const MAX_REQUEST_SIZE = 10 * 1024 * 1024; // 10MB

interface ValidationResult {
  valid: boolean;
  error?: string;
  rejectedSpans?: number;
}

/**
 * Validates the structure of an OTLP trace request.
 */
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

  if (!s.endTimeUnixNano) {
    return { valid: false, error: `Span ${spanIndex}: endTimeUnixNano is required` };
  }

  return { valid: true };
}

/**
 * Handles OTLP trace ingestion requests.
 * Accepts standard OpenTelemetry OTLP/HTTP JSON format.
 */
export async function handleOTLPTraces(c: Context<{ Bindings: Env }>): Promise<Response> {
  const authResult = await validateApiKey(c);
  if (isAuthError(authResult)) {
    return authResult;
  }
  const keyData: ApiKeyData = authResult;

  const contentType = c.req.header('Content-Type');
  if (!contentType?.includes('application/json')) {
    return c.json(
      {
        error: {
          code: 415,
          message: 'Unsupported content type. Use application/json',
        },
      },
      415,
    );
  }

  const contentLength = parseInt(c.req.header('Content-Length') ?? '0', 10);
  if (contentLength > MAX_REQUEST_SIZE) {
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

  let body: OTLPExportTraceServiceRequest;
  try {
    body = await c.req.json<OTLPExportTraceServiceRequest>();
  } catch {
    return c.json(
      {
        error: {
          code: 400,
          message: 'Invalid JSON in request body',
        },
      },
      400,
    );
  }

  const validation = validateOTLPRequest(body);
  if (!validation.valid) {
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
    return c.json(response, 200);
  }

  // Require orgId for OTLP ingestion
  if (!keyData.orgId) {
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

  const billing = await checkBillingStatus(c.env, keyData.orgId);

  if (
    billing.status === 'suspended' ||
    billing.status === 'canceled' ||
    billing.status === 'not_found'
  ) {
    console.log(
      JSON.stringify({
        type: 'otlp_reject',
        orgId: keyData.orgId,
        reason: billing.status,
        rejectedSpans: traces.length,
      }),
    );
    const response: OTLPExportTraceServiceResponse = {
      partialSuccess: {
        rejectedSpans: traces.length,
        errorMessage:
          billing.status === 'suspended'
            ? 'Account suspended'
            : billing.status === 'canceled'
              ? 'Account canceled'
              : 'Subscription not found',
      },
    };
    c.header('X-Trace-Flow-Recording', 'false');
    return c.json(response, 200);
  }

  const usageCheck = await checkUsage(c.env, keyData.orgId, traces.length, billing.subscription);

  if (usageCheck.status === 'exceeded') {
    console.log(
      JSON.stringify({
        type: 'otlp_reject',
        orgId: keyData.orgId,
        reason: 'exceeded',
        rejectedSpans: traces.length,
      }),
    );
    const response: OTLPExportTraceServiceResponse = {
      partialSuccess: {
        rejectedSpans: traces.length,
        errorMessage: 'Usage limit exceeded',
      },
    };
    c.header('X-Trace-Flow-Recording', 'false');
    return c.json(response, 200);
  }

  if (usageCheck.status === 'error') {
    console.warn(
      JSON.stringify({
        type: 'otlp_reject',
        orgId: keyData.orgId,
        reason: 'usage_error',
        rejectedSpans: traces.length,
      }),
    );
    const response: OTLPExportTraceServiceResponse = {
      partialSuccess: {
        rejectedSpans: traces.length,
        errorMessage: 'Usage check failed',
      },
    };
    c.header('X-Trace-Flow-Recording', 'false');
    return c.json(response, 200);
  }

  const message: OTLPQueueMessage = {
    type: 'otlp',
    apiKey,
    traces,
    receivedAt: receivedAtNano,
  };

  c.executionCtx.waitUntil(
    (async () => {
      try {
        await c.env.REQUEST_QUEUE.send(message);
        console.log(
          JSON.stringify({
            type: 'otlp_kpm',
            orgId: keyData.orgId,
            spanCount: traces.length,
            resourceSpanCount: body.resourceSpans.length,
          }),
        );
      } catch (error) {
        console.error('Failed to enqueue OTLP traces:', {
          orgId: keyData.orgId,
          traceCount: traces.length,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })(),
  );

  const response: OTLPExportTraceServiceResponse = { partialSuccess: {} };
  c.header('X-Trace-Flow-Recording', 'true');
  return c.json(response, 200);
}
