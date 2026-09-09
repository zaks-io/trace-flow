import { createParser, type EventSourceParser } from 'eventsource-parser';
import { getCurrentTimestamp } from '@trace-flow/utils';
import type { Provider } from '@trace-flow/llm-providers';
import type { SSEStreamData } from '@trace-flow/types';
import { createSSEInputGuard, MAX_SSE_INCOMPLETE_EVENT_CHARS } from './sseInputGuard';

/**
 * eventsource-parser documents maxBufferSize as the bound for partial lines
 * and multi-line events. Match the retained response ceiling so every event
 * inside the existing capture budget remains eligible for summary extraction.
 */
export const MAX_SSE_PARSER_BUFFER_SIZE = MAX_SSE_INCOMPLETE_EVENT_CHARS;
export const MAX_SSE_FEED_SLICE_SIZE = 64 * 1024;

/**
 * Creates an SSE parser that delegates each parsed event to the Provider's
 * `handleSSEEvent`. Per-provider event shapes (Anthropic content blocks,
 * OpenAI Responses API status mapping, Google cumulative usageMetadata) all
 * live behind the Provider seam — this file just routes.
 */
export function createSSEParser(streamData: SSEStreamData, provider: Provider): EventSourceParser {
  let parserOverflowed = false;
  const parser = createParser({
    maxBufferSize: MAX_SSE_PARSER_BUFFER_SIZE,
    onError(error) {
      if (error.type !== 'max-buffer-size-exceeded') return;
      parserOverflowed = true;
      parser.reset();
    },
    onEvent(event) {
      const timestamp = getCurrentTimestamp();
      provider.handleSSEEvent(event, timestamp, streamData);
    },
  });
  const inputGuard = createSSEInputGuard({
    onLine(line) {
      parserOverflowed = false;
      parser.feed(line);
      return !parserOverflowed;
    },
    onViolation() {
      parser.reset();
    },
  });

  return {
    feed(chunk) {
      for (let offset = 0; offset < chunk.length; offset += MAX_SSE_FEED_SLICE_SIZE) {
        inputGuard.feed(chunk.slice(offset, offset + MAX_SSE_FEED_SLICE_SIZE));
      }
    },
    reset(options) {
      inputGuard.reset();
      parser.reset(options);
    },
  };
}
