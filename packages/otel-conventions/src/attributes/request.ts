import type { QueueMessage } from '@trace-flow/types';
import { GEN_AI, HTTP, TRACE_FLOW, SOURCE_PROXY } from '../keys';

/**
 * Root-span request attributes derived from the QueueMessage. These describe
 * "the LLM Request" — provider, model, route, operation, streaming flag. Always
 * present on a Root Span; not used on child variants.
 */
export function requestAttributes(
  data: QueueMessage,
  options: { isStreaming: boolean; operationName: string },
): Record<string, string> {
  return {
    [TRACE_FLOW.SOURCE]: SOURCE_PROXY,
    [GEN_AI.REQUEST_ID]: data.requestId,
    [GEN_AI.SYSTEM]: data.request.provider,
    [GEN_AI.REQUEST_MODEL]: data.request.model,
    [HTTP.URL]: data.targetUrl,
    [HTTP.RESPONSE_STATUS_CODE]: String(data.response.status),
    [GEN_AI.STREAMING]: String(options.isStreaming),
    [GEN_AI.OPERATION_NAME]: options.operationName,
  };
}
