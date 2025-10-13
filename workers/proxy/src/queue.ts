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
 * - R2 keys (`requestBodyKey`, `responseBodyKey`) allow consumer to fetch full bodies
 * - `timing` tracks latency metrics from request initiation to completion
 * - `tokens/error` are parsed from response body when available
 *
 * Sets `model` to 'unknown' because the proxy doesn't parse request bodies.
 * The consumer extracts the actual model from the stored request body in R2.
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
  requestBodyKey: string;
  responseBodyKey: string;
  tokens: LLMTokenUsage | undefined;
  error: LLMError | undefined;
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
    requestBodyKey,
    responseBodyKey,
    timing,
    tokens,
    error,
  };

  if (sseMessageTiming && Object.keys(sseMessageTiming).length > 0) {
    queueMessage.sseMessageTiming = sseMessageTiming;
  }

  if (sseMetadata && Object.keys(sseMetadata).length > 0) {
    queueMessage.sseMetadata = sseMetadata;
  }

  return queueMessage;
}
