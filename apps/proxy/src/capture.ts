import type { LLMTokenUsage, LLMResponseMetadata, InputMessage } from '@trace-flow/types';
import { getCurrentTimestamp, redactText, redactValue } from '@trace-flow/utils';
import { parseError } from './parsers/errors';
import { captureStream, chunksToString } from './streaming/capture';
import { storeBodies } from './storage';
import { createQueueMessage } from './queue';
import { writeRequestAnalytics, writeSkippedAnalytics } from './analytics';
import { MAX_REQUEST_SIZE } from './pipeline/validateRequest';
import type { CaptureContext } from './context';

export async function captureAndEnqueue(ctx: CaptureContext): Promise<void> {
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
  } = ctx;

  const provider = route.provider;

  try {
    const requestBody = await captureStream(streamToCapture, MAX_REQUEST_SIZE);
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
      tokens = provider.aggregateSSETokens(sseStreamData);
    } else if (response.status < 400) {
      tokens = provider.parseResponseTokenUsage(responseBody);
    }
    const error = response.status >= 400 ? parseError(responseBody, response.status) : undefined;

    let responseMetadata: Partial<LLMResponseMetadata> | undefined;
    if (response.status < 400) {
      if (isSSE && sseStreamData.messages.length > 0) {
        const lastMessage = sseStreamData.messages[sseStreamData.messages.length - 1];
        responseMetadata = lastMessage?.metadata;
      } else {
        responseMetadata = provider.parseResponseMetadata(responseBody);
      }
    }

    // Google embed responses (and batchEmbedContents) don't include modelVersion in the body.
    // Fall back to the model in the URL path so traces don't show 'unknown'.
    if (!responseMetadata?.model && provider.resolveModelFromUrl) {
      const pathModel = provider.resolveModelFromUrl(targetUrl);
      if (pathModel) {
        responseMetadata = { ...(responseMetadata ?? {}), model: pathModel };
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

    const tier = usageCheck.status !== 'error' ? usageCheck.tier : undefined;

    // Persist / queue redacted copies; parsing above used raw request/response text.
    const redactedRequestBody = redactText(requestBody);
    const redactedResponseBody = redactText(responseBody);
    const redactedError = error ? redactValue(error) : undefined;
    const redactedResponseMetadata = responseMetadata ? redactValue(responseMetadata) : undefined;
    const redactedSseStreamData =
      isSSE && sseStreamData.messages.length > 0 ? redactValue(sseStreamData) : undefined;
    const redactedInputMessages =
      inputMessages && inputMessages.length > 0 ? redactValue(inputMessages) : undefined;

    let stored = false;
    const storageSkipped = omitBody;

    if (!omitBody) {
      stored = await storeBodies(
        env.STORAGE,
        requestId,
        redactedRequestBody,
        redactedResponseBody,
        isTruncated,
        logger,
        keyData.orgId,
        {
          rootKeyBase64: env.BODY_ENCRYPTION_ROOT_KEY,
          keyId: env.BODY_ENCRYPTION_KEY_ID,
        },
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
      error: redactedError,
      truncated: isTruncated,
      sseStreamData: redactedSseStreamData,
      responseMetadata: redactedResponseMetadata,
      receivedAt: requestStart * 1_000_000,
      inputMessages: redactedInputMessages,
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

export async function cleanupSkippedCapture(ctx: CaptureContext): Promise<void> {
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
  } = ctx;

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
