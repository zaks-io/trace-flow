import type {
  QueueMessage,
  LLMTiming,
  LLMTokenUsage,
  LLMError,
  SSEStreamData,
  LLMResponseMetadata,
  InputMessage,
  ToolExecution,
  SubscriptionTier,
} from '@trace-flow/types';
import { extractProviderFromUrl } from '@trace-flow/utils';

/**
 * Constructs a queue message for async processing by the consumer worker.
 *
 * The message structure separates concerns:
 * - `request/response` contain basic metadata available immediately
 * - `timing` tracks latency metrics from request initiation to completion
 * - `tokens/error` are parsed from response body when available
 * - `truncated` indicates if response was truncated due to size limits
 *
 * Sets `model` to 'unknown' because the proxy doesn't parse request bodies.
 * The consumer extracts the actual model from the stored request body in R2.
 *
 * SSE metadata is only included when present (streaming responses), keeping messages compact for non-SSE requests.
 */
export function createQueueMessage(params: {
  requestId: string;
  traceId: string;
  parentSpanId?: string;
  traceFlags?: number;
  traceState?: string;
  baggage?: Record<string, string>;
  operationName?: string;
  apiKey: string;
  targetUrl: string;
  responseStatus: number;
  requestStart: number;
  requestSent: number;
  responseReceived: number;
  firstTokenReceived: number | undefined;
  responseComplete: number;
  latency: number;
  tokens: LLMTokenUsage | undefined;
  error: LLMError | undefined;
  truncated?: boolean;
  sseStreamData?: SSEStreamData;
  responseMetadata?: Partial<LLMResponseMetadata>;
  receivedAt: number;
  inputMessages?: InputMessage[];
  toolExecutions?: ToolExecution[];
  tier?: SubscriptionTier;
  orgId?: string;
}): QueueMessage {
  const {
    requestId,
    traceId,
    parentSpanId,
    traceFlags,
    traceState,
    baggage,
    operationName,
    apiKey,
    targetUrl,
    responseStatus,
    requestStart,
    requestSent,
    responseReceived,
    firstTokenReceived,
    responseComplete,
    latency,
    tokens,
    error,
    truncated,
    sseStreamData,
    responseMetadata,
    receivedAt,
    inputMessages,
    toolExecutions,
    tier,
    orgId,
  } = params;

  const provider = extractProviderFromUrl(targetUrl);

  const timing: LLMTiming = {
    requestStart,
    requestSent,
    responseReceived,
    firstTokenReceived,
    responseComplete,
  };

  // Use model from response metadata if available, otherwise default to 'unknown'
  const model = responseMetadata?.model ?? 'unknown';

  const queueMessage: QueueMessage = {
    requestId,
    traceId,
    apiKey,
    targetUrl,
    request: {
      id: requestId,
      provider,
      model,
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
    receivedAt,
  };

  if (truncated !== undefined) {
    queueMessage.truncated = truncated;
  }

  if (sseStreamData && sseStreamData.messages.length > 0) {
    queueMessage.sseStreamData = sseStreamData;
  }

  if (responseMetadata) {
    queueMessage.responseMetadata = responseMetadata;
  }

  if (parentSpanId) {
    queueMessage.parentSpanId = parentSpanId;
  }

  if (traceFlags !== undefined) {
    queueMessage.traceFlags = traceFlags;
  }

  if (traceState) {
    queueMessage.traceState = traceState;
  }

  if (baggage && Object.keys(baggage).length > 0) {
    queueMessage.baggage = baggage;
  }

  if (operationName) {
    queueMessage.operationName = operationName;
  }

  if (inputMessages && inputMessages.length > 0) {
    queueMessage.inputMessages = inputMessages;
  }

  if (toolExecutions && toolExecutions.length > 0) {
    queueMessage.toolExecutions = toolExecutions;
  }

  if (tier) {
    queueMessage.tier = tier;
  }

  if (orgId) {
    queueMessage.orgId = orgId;
  }

  return queueMessage;
}
