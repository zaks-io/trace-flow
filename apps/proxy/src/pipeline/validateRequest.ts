import type { Context } from 'hono';
import { axiomConfigFromEnv, createWorkerLogger } from '@trace-flow/logging';
import type { Logger } from '@trace-flow/logging';
import {
  generateId,
  generateTraceId,
  parseTraceparent,
  parseBaggage,
  deriveOperationName,
} from '@trace-flow/utils';
import { PROVIDERS, resolveRoute } from '@trace-flow/llm-providers';
import { validateApiKey, isAuthError } from '../auth';
import type { ApiKeyData } from '../auth';
import type { UsageCheckResult } from '../usage';
import { evaluateRecordingPolicy } from '../recordingPolicy';
import type { ProxyEnv, TracingDecision } from '../context';

export const MAX_REQUEST_SIZE = 10 * 1024 * 1024;

/**
 * Output of the validate stage. A `Response` here is an early exit: auth failure,
 * rate limit, billing block, payload-too-large, or an invalid route. Otherwise
 * the validated record is everything `forwardToUpstream` needs.
 */
type ValidateResult =
  | { kind: 'reject'; response: Response }
  | { kind: 'accept'; validated: ValidatedRequest };

export interface ValidatedRequest {
  logger: Logger;
  keyData: ApiKeyData;
  usageCheck: UsageCheckResult;
  decision: TracingDecision;
  route: ReturnType<typeof resolveRoute> & object;
  requestId: string;
  traceId: string;
  parentSpanId: string | undefined;
  traceFlags: number;
  traceState: string;
  baggage: Record<string, string>;
  operationName: string | undefined;
  apiKey: string;
  omitBody: boolean;
}

export async function validateRequest(c: Context<{ Bindings: ProxyEnv }>): Promise<ValidateResult> {
  const requestLogger = createWorkerLogger({
    service: 'proxy',
    request: c.req.raw,
    axiom: axiomConfigFromEnv(c.env),
    context: { component: 'gateway' },
  });

  const authResult = await validateApiKey(c, requestLogger);
  if (isAuthError(authResult)) {
    c.executionCtx.waitUntil(requestLogger.flush());
    return { kind: 'reject', response: authResult };
  }
  const keyData: ApiKeyData = authResult;

  if (!keyData.orgId) {
    requestLogger.warn('proxy.request_rejected', { reason: 'no_org' });
    c.executionCtx.waitUntil(requestLogger.flush());
    return {
      kind: 'reject',
      response: c.json(
        {
          error: 'Misconfigured API key',
          message: 'API key is not associated with an organization',
        },
        403,
      ),
    };
  }

  const orgLogger = requestLogger.child({ orgId: keyData.orgId });

  const clientIp = c.req.header('cf-connecting-ip') ?? 'unknown';
  const [ipLimit, orgLimit] = await Promise.all([
    c.env.IP_LIMITER.limit({ key: clientIp }),
    c.env.ORG_LIMITER.limit({ key: keyData.orgId }),
  ]);

  if (!ipLimit.success) {
    orgLogger.warn('proxy.rate_limited', { reason: 'per_ip', clientIp });
    c.executionCtx.waitUntil(orgLogger.flush());
    return {
      kind: 'reject',
      response: c.json({ error: 'Too many requests', message: 'Per-IP rate limit exceeded' }, 429, {
        'Retry-After': '60',
      }),
    };
  }

  if (!orgLimit.success) {
    orgLogger.warn('proxy.rate_limited', { reason: 'per_org' });
    c.executionCtx.waitUntil(orgLogger.flush());
    return {
      kind: 'reject',
      response: c.json(
        { error: 'Rate limit exceeded', message: 'Per-organization rate limit exceeded' },
        429,
        { 'Retry-After': '60' },
      ),
    };
  }

  const { decision, usageCheck } = await evaluateRecordingPolicy(
    c.env,
    keyData.orgId,
    1,
    orgLogger,
  );

  if (decision.reason === 'internal_error') {
    orgLogger.error('proxy.tracing_disabled', undefined, {
      usageStatus: usageCheck.status,
      usageReason: usageCheck.status === 'error' ? usageCheck.reason : undefined,
    });
  }

  const contentLength = parseInt(c.req.header('Content-Length') ?? '0', 10);
  if (contentLength > MAX_REQUEST_SIZE) {
    orgLogger.warn('proxy.request_rejected', {
      reason: 'too_large',
      contentLength,
    });
    c.executionCtx.waitUntil(orgLogger.flush());
    return {
      kind: 'reject',
      response: c.json(
        {
          error: 'Request too large',
          message: `Request body exceeds ${MAX_REQUEST_SIZE / (1024 * 1024)}MB limit`,
        },
        413,
      ),
    };
  }

  const route = resolveRoute(c.req.path);
  if (!route) {
    orgLogger.warn('proxy.request_rejected', {
      reason: 'invalid_route',
      path: c.req.path,
    });
    c.executionCtx.waitUntil(orgLogger.flush());
    return {
      kind: 'reject',
      response: c.json(
        {
          error: 'Invalid route',
          message: `Use /{provider}/... where provider is one of: ${Object.keys(PROVIDERS).join(', ')}`,
        },
        404,
      ),
    };
  }

  const apiKey = c.req.header('X-Trace-Flow-Api-Key') ?? '';
  const requestId = generateId();

  const traceparent = parseTraceparent(c.req.header('traceparent'));
  const traceId = traceparent?.traceId ?? generateTraceId();
  const parentSpanId = traceparent?.parentId ?? undefined;
  const traceFlags = traceparent?.flags ?? 0x01;
  const traceState = c.req.header('tracestate') ?? '';
  const baggage = parseBaggage(c.req.header('baggage'));
  const omitBody = c.req.header('X-Trace-Flow-Omit-Body') === 'true';

  const operationName = deriveOperationName(c.req.path);
  const logger = orgLogger.child({
    traceId,
    requestId,
    parentSpanId,
    provider: route.provider.id,
    operation: operationName,
  });

  return {
    kind: 'accept',
    validated: {
      logger,
      keyData,
      usageCheck,
      decision,
      route,
      requestId,
      traceId,
      parentSpanId,
      traceFlags,
      traceState,
      baggage,
      operationName,
      apiKey,
      omitBody,
    },
  };
}
