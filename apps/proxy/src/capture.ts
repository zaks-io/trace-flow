import type {
  SSEStreamData,
  QueueMessageUnion,
  LLMTokenUsage,
  LLMResponseMetadata,
  InputMessage,
} from '@trace-flow/types';
import { getCurrentTimestamp } from '@trace-flow/utils';
import type { Logger } from '@trace-flow/logging';
import type { ApiKeyData } from './auth';
import type { UsageCheckResult } from './usage';
import { parseTokenUsage } from './parsers/providers';
import { parseError } from './parsers/errors';
import { extractMetadataFromResponseBody } from './parsers/metadata-regex';
import {
  parseAnthropicRequestBody,
  parseOpenAIStyleRequestBody,
  parseGoogleRequestBody,
} from './parsers/request-body';
import { captureStream, chunksToString } from './streaming/capture';
import type { createResponseCapture } from './streaming/capture';
import { aggregateSSETokens } from './streaming/sse';
import type { EventSourceParser } from 'eventsource-parser';
import { storeBodies } from './storage';
import { createQueueMessage } from './queue';
import type { ResolvedRoute } from './providers';
import { writeRequestAnalytics, writeSkippedAnalytics } from './analytics';
import type { TracingDecision } from './tracing-decision';

interface CaptureEnv {
  STORAGE: R2Bucket;
  REQUEST_QUEUE: Queue<QueueMessageUnion>;
  ANALYTICS: AnalyticsEngineDataset;
}

interface CaptureAndEnqueueParams {
  env: CaptureEnv;
  logger: Logger;
  keyData: ApiKeyData;
  usageCheck: UsageCheckResult;
  requestId: string;
  traceId: string;
  parentSpanId: string | undefined;
  traceFlags: number;
  traceState: string;
  baggage: Record<string, string>;
  operationName: string | undefined;
  apiKey: string;
  route: ResolvedRoute;
  targetUrl: string;
  streamToCapture: ReadableStream | null;
  response: Response;
  capture: ReturnType<typeof createResponseCapture>;
  isSSE: boolean;
  sseStreamData: SSEStreamData;
  parser: EventSourceParser | null;
  pipePromise: Promise<void> | undefined;
  requestStart: number;
  requestSent: number;
  responseReceived: number;
  omitBody: boolean;
  maxRequestSize: number;
}

export async function captureAndEnqueue(params: CaptureAndEnqueueParams): Promise<void> {
  const {
    env,
    logger,
    keyData,
    usageCheck,
    requestId,
    traceId,
    parentSpanId,
    traceFlags,
    traceState,
    baggage,
    operationName,
    apiKey,
    route,
    targetUrl,
    streamToCapture,
    response,
    capture,
    isSSE,
    sseStreamData,
    parser,
    pipePromise,
    requestStart,
    requestSent,
    responseReceived,
    omitBody,
    maxRequestSize,
  } = params;

  try {
    const requestBody = await captureStream(streamToCapture, maxRequestSize);
    await pipePromise;

    // Flush any pending SSE event — some providers (Google) may not send
    // a trailing blank line after the final data: line, leaving the last
    // event (with final token totals) stuck in the parser's buffer
    if (isSSE && parser) {
      parser.feed('\n\n');
    }

    const responseComplete = getCurrentTimestamp();

    // Set messageStop for providers that don't send [DONE] (e.g. Google)
    if (isSSE && sseStreamData.messages.length > 0) {
      const lastMessage = sseStreamData.messages[sseStreamData.messages.length - 1];
      if (lastMessage && !lastMessage.messageStop) {
        lastMessage.messageStop = responseComplete;
      }
    }
    const latency = responseComplete - requestStart;

    const responseCapturedChunks = capture.getCapturedChunks();
    const firstTokenReceived = capture.getFirstTokenTime();
    const isTruncated = capture.isTruncated();
    const totalSize = capture.getTotalSize();
    const responseBody = chunksToString(responseCapturedChunks);

    if (isTruncated) {
      logger.warn('proxy.response_truncated', {
        totalSize,
        capturedSize: responseBody.length,
      });
    }

    // Extract tokens from response body (non-streaming) or SSE stream data (streaming).
    // For SSE responses, only use aggregated SSE tokens — running parseTokenUsage on raw
    // SSE text would match partial data from individual events and could leak stale fields.
    let tokens: LLMTokenUsage | undefined;
    if (isSSE && sseStreamData.messages.length > 0) {
      tokens = aggregateSSETokens(sseStreamData, route.provider.id);
    } else if (response.status < 400) {
      tokens = parseTokenUsage(responseBody, route.provider.id);
    }
    const error = response.status >= 400 ? parseError(responseBody, response.status) : undefined;

    let responseMetadata: Partial<LLMResponseMetadata> | undefined;
    if (response.status < 400) {
      if (isSSE && sseStreamData.messages.length > 0) {
        const lastMessage = sseStreamData.messages[sseStreamData.messages.length - 1];
        responseMetadata = lastMessage?.metadata;
      } else {
        responseMetadata = extractMetadataFromResponseBody(responseBody);
      }
    }

    const isAnthropic = targetUrl.includes('anthropic.com');
    const isGoogle = targetUrl.includes('generativelanguage.googleapis.com');
    const isOpenAIStyle =
      targetUrl.includes('openai.com') ||
      targetUrl.includes('groq.com') ||
      targetUrl.includes('openrouter.ai');

    let inputMessages: InputMessage[] | undefined;

    if (requestBody) {
      try {
        if (isAnthropic) {
          inputMessages = parseAnthropicRequestBody(requestBody) ?? undefined;
        } else if (isGoogle) {
          inputMessages = parseGoogleRequestBody(requestBody) ?? undefined;
        } else if (isOpenAIStyle) {
          inputMessages = parseOpenAIStyleRequestBody(requestBody) ?? undefined;
        }
      } catch (err) {
        logger.error('proxy.request_body_parse_failed', err);
      }
    }

    const tier = usageCheck.status !== 'error' ? usageCheck.tier : undefined;
    let stored = false;
    const storageSkipped = omitBody;

    if (!omitBody) {
      stored = await storeBodies(
        env.STORAGE,
        requestId,
        requestBody,
        responseBody,
        isTruncated,
        logger,
        keyData.orgId,
      );

      if (!stored) {
        logger.warn('proxy.r2_storage_failed');
      }
    }

    const queueMessage = createQueueMessage({
      requestId,
      traceId,
      parentSpanId: parentSpanId ?? undefined,
      traceFlags,
      traceState: traceState || undefined,
      baggage: Object.keys(baggage).length > 0 ? baggage : undefined,
      operationName,
      apiKey,
      targetUrl,
      responseStatus: response.status,
      requestStart,
      requestSent,
      responseReceived,
      firstTokenReceived,
      responseComplete,
      latency,
      tokens,
      error,
      truncated: isTruncated,
      sseStreamData: isSSE && sseStreamData.messages.length > 0 ? sseStreamData : undefined,
      responseMetadata,
      receivedAt: requestStart * 1_000_000,
      inputMessages,
      tier,
      orgId: keyData.orgId,
    });

    writeRequestAnalytics({
      analytics: env.ANALYTICS,
      orgId: keyData.orgId,
      route,
      responseStatus: response.status,
      operationName,
      isSSE,
      responseMetadata,
      requestStart,
      requestSent,
      responseReceived,
      responseComplete,
      firstTokenReceived,
      tokens,
      totalSize,
      storageSkipped,
      stored,
    });

    logger.info('proxy.capture_metrics', {
      status: response.status,
      totalLatencyMs: responseComplete - requestStart,
      prepLatencyMs: requestSent - requestStart,
      ttfbMs: firstTokenReceived ? firstTokenReceived - requestSent : 0,
      isSse: isSSE,
      model: responseMetadata?.model,
      totalTokens: tokens?.totalTokens ?? 0,
      r2Stored: storageSkipped ? 'skipped' : stored ? 'stored' : 'failed',
    });

    await env.REQUEST_QUEUE.send(queueMessage);
  } catch (err) {
    logger.error('proxy.capture_failed', err);
  } finally {
    await logger.flush();
  }
}

interface CleanupSkippedCaptureParams {
  env: Pick<CaptureEnv, 'ANALYTICS'>;
  logger: Logger;
  keyData: ApiKeyData;
  route: ResolvedRoute;
  response: Response;
  operationName: string | undefined;
  decision: TracingDecision;
  isSSE: boolean;
  streamToCapture: ReadableStream | null;
  pipePromise: Promise<void> | undefined;
}

export async function cleanupSkippedCapture(params: CleanupSkippedCaptureParams): Promise<void> {
  const {
    env,
    logger,
    keyData,
    route,
    response,
    operationName,
    decision,
    isSSE,
    streamToCapture,
    pipePromise,
  } = params;

  try {
    writeSkippedAnalytics(
      env.ANALYTICS,
      keyData.orgId,
      route,
      response.status,
      operationName,
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
