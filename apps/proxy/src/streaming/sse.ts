import { createParser, type EventSourceParser } from 'eventsource-parser';
import { getCurrentTimestamp } from '@trace-flow/utils';
import type { Provider } from '@trace-flow/llm-providers';
import type { SSEStreamData } from '@trace-flow/types';

/**
 * Creates an SSE parser that delegates each parsed event to the Provider's
 * `handleSSEEvent`. Per-provider event shapes (Anthropic content blocks,
 * OpenAI Responses API status mapping, Google cumulative usageMetadata) all
 * live behind the Provider seam — this file just routes.
 */
export function createSSEParser(streamData: SSEStreamData, provider: Provider): EventSourceParser {
  return createParser({
    onEvent(event) {
      const timestamp = getCurrentTimestamp();
      provider.handleSSEEvent(event, timestamp, streamData);
    },
  });
}
