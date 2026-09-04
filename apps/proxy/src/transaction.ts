import type {
  InputMessage,
  LLMError,
  LLMResponseMetadata,
  LLMTokenUsage,
  SSEStreamData,
  SubscriptionTier,
} from '@trace-flow/types';
import type { ResolvedRoute } from '@trace-flow/llm-providers';
import type { Logger } from '@trace-flow/logging';
import { getCurrentTimestamp, redactText, redactValue } from '@trace-flow/utils';
import { currentSentryTraceContext } from '@trace-flow/utils/sentry-tracing';
import { parseError } from './parsers/errors';
import { writeRequestAnalytics, writeSkippedAnalytics } from './analytics';
import { captureStream, chunksToString } from './streaming/capture';
import { createQueueMessage } from './queue';
import { buildTraceDeliveryEnvelope, enqueueTraceDelivery, persistTraceDelivery } from './delivery';
import { MAX_REQUEST_SIZE } from './pipeline/validateRequest';
import type { ProxyEnv, TracingDecision } from './context';
import type { AttachedCapture } from './pipeline/attachCapture';
import type { UpstreamFetchError } from './pipeline/forwardToUpstream';

/**
 * Output of `drainCapture`. Composes the attached stage and adds the stream-side
 * snapshot taken after the response finishes draining.
 */
interface DrainedCapture {
  attached: AttachedCapture;
  requestBody: string;
  responseBody: string;
  firstTokenReceived: number | undefined;
  isTruncated: boolean;
  totalSize: number;
  capturedSize: number;
  responseComplete: number;
  requestCaptureError?: unknown;
  streamError?: unknown;
}

/**
 * The captured artifact for one LLM Request + LLM Response — the unit of metering
 * named in `CONTEXT.md`. Holds identifiers, timing, the raw bodies, and parsed
 * artifacts (tokens, error, metadata, input messages, SSE stream data).
 *
 * Excludes policy concerns: a Transaction is what was captured. Whether it gets
 * persisted, and under what retention, is passed to `persistTransaction` alongside.
 */
export interface Transaction {
  requestId: string;
  traceId: string;
  parentSpanId: string | undefined;
  traceFlags: number;
  traceState: string;
  baggage: Record<string, string>;
  apiKey: string;
  orgId: string;
  operationName: string | undefined;
  targetUrl: string;

  requestBody: string;
  responseBody: string;
  responseStatus: number;

  requestStart: number;
  requestSent: number;
  responseReceived: number;
  firstTokenReceived: number | undefined;
  responseComplete: number;

  tokens: LLMTokenUsage | undefined;
  error: LLMError | undefined;
  responseMetadata: Partial<LLMResponseMetadata> | undefined;
  inputMessages: InputMessage[] | undefined;
  sseStreamData: SSEStreamData | undefined;

  isSSE: boolean;
  isTruncated: boolean;
  totalSize: number;
  capturedSize: number;
  requestCaptureError?: unknown;
  streamError?: unknown;
}

export interface PersistedTransaction {
  deliveryKey: string;
  message: ReturnType<typeof createQueueMessage>;
}

interface PersistOpts {
  tier: SubscriptionTier | undefined;
  route: ResolvedRoute;
  omitBody: boolean;
  logger: Logger;
}

interface SkipOpts {
  decision: TracingDecision;
  route: ResolvedRoute;
  logger: Logger;
}

export async function buildUpstreamFailureTransaction(
  failure: UpstreamFetchError,
): Promise<Transaction> {
  const { validated, targetUrl, streamToCapture, requestStart, requestSent } = failure.exchange;
  let requestBody = '';
  let captureError: unknown;
  try {
    requestBody = await captureStream(streamToCapture, MAX_REQUEST_SIZE);
  } catch (error) {
    captureError = error;
  }
  const responseComplete = getCurrentTimestamp();
  return {
    requestId: validated.requestId,
    traceId: validated.traceId,
    parentSpanId: validated.parentSpanId,
    traceFlags: validated.traceFlags,
    traceState: validated.traceState,
    baggage: validated.baggage,
    apiKey: validated.apiKey,
    orgId: validated.keyData.orgId,
    operationName: validated.operationName,
    targetUrl,
    requestBody,
    responseBody: '',
    responseStatus: 502,
    requestStart,
    requestSent,
    responseReceived: responseComplete,
    firstTokenReceived: undefined,
    responseComplete,
    tokens: undefined,
    error: { type: 'upstream_fetch_error', message: 'Upstream request failed' },
    responseMetadata: undefined,
    inputMessages: undefined,
    sseStreamData: undefined,
    isSSE: false,
    isTruncated: false,
    totalSize: 0,
    capturedSize: 0,
    requestCaptureError: captureError,
    streamError: failure.cause,
  };
}

/**
 * Await the captured stream, flush trailing SSE state, snapshot capture metrics.
 *
 * Google's SSE stream doesn't terminate with a blank line, leaving the final
 * event (with totals) stuck in the parser buffer — we feed a synthetic `\n\n`
 * to flush. Google also omits `[DONE]`, so we stamp `messageStop` on the last
 * SSE message ourselves once we know the response is complete.
 */
export async function drainCapture(attached: AttachedCapture): Promise<DrainedCapture> {
  const { capture, parser, isSSE, sseStreamData, forwarded } = attached;

  const [requestResult, responseResult] = await Promise.all([
    captureStream(forwarded.streamToCapture, MAX_REQUEST_SIZE).then(
      (body) => ({ body, error: undefined }),
      (error: unknown) => ({ body: '', error }),
    ),
    capture.waitForDrain(),
  ]);

  if (responseResult.complete && isSSE && parser) {
    parser.feed('\n\n');
  }

  const responseComplete = getCurrentTimestamp();

  if (responseResult.complete && isSSE && sseStreamData.messages.length > 0) {
    const lastMessage = sseStreamData.messages[sseStreamData.messages.length - 1];
    if (lastMessage && !lastMessage.messageStop) {
      lastMessage.messageStop = responseComplete;
    }
  }

  const responseBody = chunksToString(capture.getCapturedChunks());

  return {
    attached,
    requestBody: requestResult.body,
    responseBody,
    firstTokenReceived: capture.getFirstTokenTime(),
    isTruncated: capture.isTruncated(),
    totalSize: capture.getTotalSize(),
    capturedSize: capture.getCapturedSize(),
    responseComplete,
    requestCaptureError: requestResult.error,
    streamError: responseResult.complete ? undefined : responseResult.error,
  };
}

/**
 * Pure extraction: turn a drained capture into a Transaction. Branches between
 * streaming (read tokens + metadata off the accumulated SSE state) and
 * whole-body responses (parse them out of the response body). Skips token/
 * metadata parsing on error responses to avoid leaking partial data.
 *
 * Request-body parsing is wrapped in try/catch with a logger — provider
 * adapters may throw on malformed bodies, and we want a breadcrumb without
 * dropping the whole transaction.
 */
export function buildTransaction(drained: DrainedCapture, logger: Logger): Transaction {
  const { attached, requestBody, responseBody, responseComplete, firstTokenReceived } = drained;
  const { forwarded, isSSE, sseStreamData } = attached;
  const { validated, response, targetUrl } = forwarded;
  const provider = validated.route.provider;

  if (drained.isTruncated) {
    logger.warn('proxy.response_truncated', {
      totalSize: drained.totalSize,
      capturedSize: drained.capturedSize,
    });
  }

  if (drained.requestCaptureError) {
    logger.error('proxy.request_capture_failed', drained.requestCaptureError);
  }

  // For SSE responses, only use aggregated SSE tokens — parsing raw SSE text
  // would match partial data from individual events and could leak stale fields.
  let tokens: LLMTokenUsage | undefined;
  if (!drained.streamError && isSSE && sseStreamData.messages.length > 0) {
    tokens = provider.aggregateSSETokens(sseStreamData);
  } else if (!drained.streamError && response.status < 400) {
    tokens = provider.parseResponseTokenUsage(responseBody);
  }

  const error = drained.streamError
    ? { type: 'stream_interrupted', message: 'Upstream response stream did not complete' }
    : response.status >= 400
      ? parseError(responseBody, response.status)
      : undefined;

  let responseMetadata: Partial<LLMResponseMetadata> | undefined;
  if (!drained.streamError && response.status < 400) {
    if (isSSE && sseStreamData.messages.length > 0) {
      const lastMessage = sseStreamData.messages[sseStreamData.messages.length - 1];
      responseMetadata = lastMessage?.metadata;
    } else {
      responseMetadata = provider.parseResponseMetadata(responseBody, { targetUrl });
    }
  }

  let inputMessages: InputMessage[] | undefined;
  if (requestBody) {
    try {
      inputMessages = provider.parseRequestBody(requestBody) ?? undefined;
    } catch (err) {
      logger.error('proxy.request_body_parse_failed', err);
    }
  }

  return {
    requestId: validated.requestId,
    traceId: validated.traceId,
    parentSpanId: validated.parentSpanId,
    traceFlags: validated.traceFlags,
    traceState: validated.traceState,
    baggage: validated.baggage,
    apiKey: validated.apiKey,
    orgId: validated.keyData.orgId,
    operationName: validated.operationName,
    targetUrl,

    requestBody,
    responseBody,
    responseStatus: drained.streamError ? 502 : response.status,

    requestStart: forwarded.requestStart,
    requestSent: forwarded.requestSent,
    responseReceived: forwarded.responseReceived,
    firstTokenReceived,
    responseComplete,

    tokens,
    error,
    responseMetadata,
    inputMessages,
    sseStreamData: isSSE && sseStreamData.messages.length > 0 ? sseStreamData : undefined,

    isSSE,
    isTruncated: drained.isTruncated || Boolean(drained.requestCaptureError),
    totalSize: drained.totalSize,
    capturedSize: drained.capturedSize,
    requestCaptureError: drained.requestCaptureError,
    streamError: drained.streamError,
  };
}

/**
 * Redact and durably persist one delivery envelope. Body data is encrypted
 * before it shares the envelope with metadata. Queue publication happens only
 * after this function returns successfully.
 */
export async function persistTransaction(
  env: ProxyEnv,
  transaction: Transaction,
  opts: PersistOpts,
): Promise<PersistedTransaction> {
  const { tier, route, omitBody, logger } = opts;

  try {
    const redactedRequestBody = redactText(transaction.requestBody);
    const redactedResponseBody = redactText(transaction.responseBody);
    const redactedError = transaction.error ? redactValue(transaction.error) : undefined;
    const redactedResponseMetadata = transaction.responseMetadata
      ? redactValue(transaction.responseMetadata)
      : undefined;
    const redactedSseStreamData = transaction.sseStreamData
      ? redactValue(transaction.sseStreamData)
      : undefined;
    const redactedInputMessages =
      transaction.inputMessages && transaction.inputMessages.length > 0
        ? redactValue(transaction.inputMessages)
        : undefined;

    const latency = transaction.responseComplete - transaction.requestStart;
    const queueMessage = createQueueMessage({
      requestId: transaction.requestId,
      traceId: transaction.traceId,
      parentSpanId: transaction.parentSpanId,
      traceFlags: transaction.traceFlags,
      traceState: transaction.traceState || undefined,
      baggage: Object.keys(transaction.baggage).length > 0 ? transaction.baggage : undefined,
      operationName: transaction.operationName,
      apiKey: transaction.apiKey,
      targetUrl: transaction.targetUrl,
      responseStatus: transaction.responseStatus,
      requestStart: transaction.requestStart,
      requestSent: transaction.requestSent,
      responseReceived: transaction.responseReceived,
      firstTokenReceived: transaction.firstTokenReceived,
      responseComplete: transaction.responseComplete,
      latency,
      tokens: transaction.tokens,
      error: redactedError,
      truncated: transaction.isTruncated,
      sseStreamData: redactedSseStreamData,
      responseMetadata: redactedResponseMetadata,
      receivedAt: transaction.requestStart * 1_000_000,
      inputMessages: redactedInputMessages,
      tier,
      orgId: transaction.orgId,
      sentryTraceContext: currentSentryTraceContext(),
    });

    try {
      writeRequestAnalytics({
        analytics: env.ANALYTICS,
        orgId: transaction.orgId,
        route,
        responseStatus: transaction.responseStatus,
        operationName: transaction.operationName,
        isSSE: transaction.isSSE,
        responseMetadata: transaction.responseMetadata,
        requestStart: transaction.requestStart,
        requestSent: transaction.requestSent,
        responseReceived: transaction.responseReceived,
        responseComplete: transaction.responseComplete,
        firstTokenReceived: transaction.firstTokenReceived,
        tokens: transaction.tokens,
        totalSize: transaction.totalSize,
        storageSkipped: omitBody,
        stored: !omitBody,
      });
    } catch (err) {
      logger.error('proxy.analytics_write_failed', err);
    }

    logger.info('proxy.capture_metrics', {
      status: transaction.responseStatus,
      totalLatencyMs: latency,
      prepLatencyMs: transaction.requestSent - transaction.requestStart,
      ttfbMs: transaction.firstTokenReceived
        ? transaction.firstTokenReceived - transaction.requestSent
        : 0,
      isSse: transaction.isSSE,
      model: transaction.responseMetadata?.model,
      totalTokens: transaction.tokens?.totalTokens ?? 0,
      r2Stored: omitBody ? 'skipped' : 'pending_delivery',
    });

    const envelope = await buildTraceDeliveryEnvelope(
      queueMessage,
      omitBody
        ? undefined
        : {
            requestId: transaction.requestId,
            requestBody: redactedRequestBody,
            responseBody: redactedResponseBody,
            truncated: transaction.isTruncated,
            orgId: transaction.orgId,
            encryption: {
              rootKeyBase64: env.BODY_ENCRYPTION_ROOT_KEY,
              keyId: env.BODY_ENCRYPTION_KEY_ID,
            },
          },
    );
    const deliveryKey = await persistTraceDelivery(
      env.STORAGE,
      envelope,
      env.TRACE_DELIVERY_NAMESPACE,
    );
    return { deliveryKey, message: queueMessage };
  } catch (err) {
    logger.error('proxy.capture_failed', err);
    throw err;
  }
}

export async function enqueuePersistedTransaction(
  env: ProxyEnv,
  persisted: PersistedTransaction,
  logger: Logger,
): Promise<void> {
  try {
    await enqueueTraceDelivery(env.REQUEST_QUEUE, persisted.deliveryKey, persisted.message);
  } catch (err) {
    logger.error('proxy.queue_send_failed', err, { deliveryKey: persisted.deliveryKey });
  } finally {
    await logger.flush();
  }
}

/**
 * Skip-path companion to `persistTransaction`. Cancels the capture stream,
 * waits for the pipe to settle, and writes a skip analytics record. Doesn't
 * produce a Transaction — there's nothing to persist when recording is gated.
 */
export async function recordSkippedExchange(
  env: ProxyEnv,
  attached: AttachedCapture,
  opts: SkipOpts,
): Promise<void> {
  const { decision, route, logger } = opts;
  const { forwarded, isSSE, pipePromise, capture } = attached;
  const { validated, response, streamToCapture } = forwarded;
  capture.release();

  try {
    writeSkippedAnalytics(
      env.ANALYTICS,
      validated.keyData.orgId,
      route,
      response.status,
      validated.operationName,
      decision,
      isSSE,
    );
    logger.info('proxy.capture_skipped', {
      reason: decision.reason,
      status: response.status,
    });

    await streamToCapture?.cancel();
    await pipePromise;
  } catch (err) {
    if (err instanceof Error && err.name !== 'AbortError') {
      logger.error('proxy.stream_cleanup_failed', err);
    }
  } finally {
    await logger.flush();
  }
}
