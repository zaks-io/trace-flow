import { createParser, type EventSourceParser } from 'eventsource-parser';
import { getCurrentTimestamp } from '@trace-flow/utils';
import type { Provider } from '@trace-flow/llm-providers';
import type { SSEStreamData } from '@trace-flow/types';
import { MAX_RESPONSE_CAPTURE_SIZE } from './capture';

/**
 * eventsource-parser documents maxBufferSize as the bound for partial lines
 * and multi-line events. Match the retained response ceiling so every event
 * inside the existing capture budget remains eligible for summary extraction.
 */
export const MAX_SSE_PARSER_BUFFER_SIZE = MAX_RESPONSE_CAPTURE_SIZE;
export const MAX_SSE_FEED_SLICE_SIZE = 64 * 1024;

const SSE_BLANK_LINE_PATTERN = /\r?\n\r?\n/;
const MAX_SSE_BOUNDARY_PREFIX_SIZE = 3;

/**
 * Creates an SSE parser that delegates each parsed event to the Provider's
 * `handleSSEEvent`. Per-provider event shapes (Anthropic content blocks,
 * OpenAI Responses API status mapping, Google cumulative usageMetadata) all
 * live behind the Provider seam — this file just routes.
 */
export function createSSEParser(streamData: SSEStreamData, provider: Provider): EventSourceParser {
  let recovering = false;
  let recoveryPrefix = '';
  const parser = createParser({
    maxBufferSize: MAX_SSE_PARSER_BUFFER_SIZE,
    onError(error) {
      if (error.type !== 'max-buffer-size-exceeded') return;
      recovering = true;
      recoveryPrefix = '';
      parser.reset();
    },
    onEvent(event) {
      const timestamp = getCurrentTimestamp();
      provider.handleSSEEvent(event, timestamp, streamData);
    },
  });

  function feedSlice(slice: string): void {
    if (!recovering) {
      parser.feed(slice);
      if (recovering) recoveryPrefix = slice.slice(-MAX_SSE_BOUNDARY_PREFIX_SIZE);
      return;
    }

    const candidate = recoveryPrefix + slice;
    const boundary = SSE_BLANK_LINE_PATTERN.exec(candidate);
    if (!boundary) {
      recoveryPrefix = candidate.slice(-MAX_SSE_BOUNDARY_PREFIX_SIZE);
      return;
    }

    recovering = false;
    recoveryPrefix = '';
    const remainder = candidate.slice(boundary.index + boundary[0].length);
    if (remainder) {
      parser.feed(remainder);
      if (recovering) recoveryPrefix = remainder.slice(-MAX_SSE_BOUNDARY_PREFIX_SIZE);
    }
  }

  return {
    feed(chunk) {
      for (let offset = 0; offset < chunk.length; offset += MAX_SSE_FEED_SLICE_SIZE) {
        feedSlice(chunk.slice(offset, offset + MAX_SSE_FEED_SLICE_SIZE));
      }
    },
    reset(options) {
      recovering = false;
      recoveryPrefix = '';
      parser.reset(options);
    },
  };
}
