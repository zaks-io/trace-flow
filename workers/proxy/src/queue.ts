import type {
  QueueMessage,
  LLMTiming,
  LLMTokenUsage,
  LLMError,
  SSEMessageTiming,
  SSEMetadata,
} from '@observe/types';
import { extractProviderFromUrl } from '@observe/utils';

/**
 * Constructs a queue message for async processing by the consumer worker.
 *
 * The message structure separates concerns:
 * - `request/response` contain basic metadata available immediately
 * - R2 keys (`requestBodyKey`, `responseBodyKey`) allow consumer to fetch full bodies (when stored successfully)
 * - `timing` tracks latency metrics from request initiation to completion
 * - `tokens/error` are parsed from response body when available
 * - `truncated` indicates if response was truncated due to size limits
 *
 * Sets `model` to 'unknown' because the proxy doesn't parse request bodies.
 * The consumer extracts the actual model from the stored request body in R2.
 *
 * R2 keys are optional to handle storage failures gracefully - when R2 storage fails,
 * the queue message is still sent but without body keys (consumer can't fetch bodies).
 *
 * SSE metadata is only included when present (streaming responses), keeping messages compact for non-SSE requests.
 */
export function createQueueMessage(params: {
  requestId: string;
  apiKey: string;
  targetUrl: string;
  responseStatus: number;
  requestStart: number;
  requestSent: number;
  firstTokenReceived: number | undefined;
  responseComplete: number;
  latency: number;
  requestBodyKey?: string;
  responseBodyKey?: string;
  tokens: LLMTokenUsage | undefined;
  error: LLMError | undefined;
  truncated?: boolean;
  sseMessageTiming?: SSEMessageTiming;
  sseMetadata?: SSEMetadata;
}): QueueMessage {
  const {
    requestId,
    apiKey,
    targetUrl,
    responseStatus,
    requestStart,
    requestSent,
    firstTokenReceived,
    responseComplete,
    latency,
    requestBodyKey,
    responseBodyKey,
    tokens,
    error,
    truncated,
    sseMessageTiming,
    sseMetadata,
  } = params;

  const provider = extractProviderFromUrl(targetUrl);

  const timing: LLMTiming = {
    requestStart,
    requestSent,
    firstTokenReceived,
    responseComplete,
  };

  const queueMessage: QueueMessage = {
    requestId,
    apiKey,
    targetUrl,
    request: {
      id: requestId,
      provider,
      model: 'unknown',
      messages: [],
      timestamp: requestStart,
    },
    response: {
      id: requestId,
      provider,
      status: responseStatus,
      timestamp: responseComplete,
      latency,
    },
    timing,
    tokens,
    error,
  };

  if (requestBodyKey) {
    queueMessage.requestBodyKey = requestBodyKey;
  }

  if (responseBodyKey) {
    queueMessage.responseBodyKey = responseBodyKey;
  }

  if (truncated !== undefined) {
    queueMessage.truncated = truncated;
  }

  if (sseMessageTiming && Object.keys(sseMessageTiming).length > 0) {
    queueMessage.sseMessageTiming = sseMessageTiming;
  }

  if (sseMetadata && Object.keys(sseMetadata).length > 0) {
    queueMessage.sseMetadata = sseMetadata;
  }

  return queueMessage;
}
