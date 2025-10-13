import { createParser, type EventSourceParser } from 'eventsource-parser';
import type { SSEMessageTiming, SSEMetadata } from '@observe/types';
import { getCurrentTimestamp } from '@observe/utils';

/**
 * Processes SSE events to extract timing and metadata for LLM streaming responses.
 * Designed for Anthropic's event structure (message_start, content_block_start, content_block_delta, etc).
 *
 * Only captures the first occurrence of timing events to establish baseline metrics.
 * Prevents overwriting if duplicate events arrive (some providers may send redundant events).
 *
 * Captures both incremental usage (message_delta) and final usage (message_stop) because
 * streaming responses may provide partial token counts during generation.
 */
export function processSSEEvent(
  event: { event?: string; data: string },
  timestamp: number,
  timing: SSEMessageTiming,
  metadata: SSEMetadata,
): void {
  try {
    const eventType = event.event;
    // Only capture timing for the first occurrence of each event type
    // This prevents overwriting timings if duplicate events are received
    if (eventType === 'message_start' && timing.messageStart === undefined) {
      timing.messageStart = timestamp;
      return;
    }

    if (eventType === 'content_block_start' && timing.contentBlockStart === undefined) {
      timing.contentBlockStart = timestamp;
      return;
    }

    if (eventType === 'content_block_delta' && timing.firstDelta === undefined) {
      timing.firstDelta = timestamp;
      return;
    }

    if (eventType === 'message_delta') {
      const parsed = JSON.parse(event.data) as unknown;
      if (parsed && typeof parsed === 'object') {
        const delta = parsed as Record<string, unknown>;
        const usage = delta.usage;
        if (usage && typeof usage === 'object') {
          const typedUsage = usage as Record<string, unknown>;
          metadata.usage = {
            input_tokens:
              typeof typedUsage.input_tokens === 'number' ? typedUsage.input_tokens : undefined,
            cache_creation_input_tokens:
              typeof typedUsage.cache_creation_input_tokens === 'number'
                ? typedUsage.cache_creation_input_tokens
                : undefined,
            cache_read_input_tokens:
              typeof typedUsage.cache_read_input_tokens === 'number'
                ? typedUsage.cache_read_input_tokens
                : undefined,
            output_tokens:
              typeof typedUsage.output_tokens === 'number' ? typedUsage.output_tokens : undefined,
          };
        }
      }
      return;
    }

    if (eventType === 'message_stop') {
      timing.messageStop = timestamp;
      const parsed = JSON.parse(event.data) as unknown;
      if (parsed && typeof parsed === 'object') {
        const stop = parsed as Record<string, unknown>;
        const usage = stop.usage;
        if (usage && typeof usage === 'object') {
          const typedUsage = usage as Record<string, unknown>;
          metadata.finalUsage = {
            input_tokens:
              typeof typedUsage.input_tokens === 'number' ? typedUsage.input_tokens : undefined,
            cache_creation_input_tokens:
              typeof typedUsage.cache_creation_input_tokens === 'number'
                ? typedUsage.cache_creation_input_tokens
                : undefined,
            cache_read_input_tokens:
              typeof typedUsage.cache_read_input_tokens === 'number'
                ? typedUsage.cache_read_input_tokens
                : undefined,
            output_tokens:
              typeof typedUsage.output_tokens === 'number' ? typedUsage.output_tokens : undefined,
          };
        }
      }
    }
  } catch (e) {
    console.error('Error parsing SSE event:', {
      error: e,
      eventType: event.event,
      timestamp,
      dataPreview: event.data?.substring(0, 100),
    });
  }
}

/**
 * Creates an SSE parser that populates timing and metadata objects as events are processed.
 * The parser mutates the provided timing and metadata objects to avoid copying overhead during streaming.
 */
export function createSSEParser(
  timing: SSEMessageTiming,
  metadata: SSEMetadata,
): EventSourceParser {
  return createParser({
    onEvent(event) {
      const timestamp = getCurrentTimestamp();

      console.log('SSE Event:', {
        event: event.event,
        timestamp,
        data: event.data?.substring(0, 100),
      });

      processSSEEvent(event, timestamp, timing, metadata);
    },
  });
}
