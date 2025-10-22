import { createParser, type EventSourceParser } from 'eventsource-parser';
import type { SSEStreamData, SSEMessage, SSEEvent } from '@observe/types';
import { getCurrentTimestamp } from '@observe/utils';

/**
 * Processes SSE events to track multiple messages and record all events as OpenTelemetry events.
 * Supports multi-turn conversations where multiple messages may be exchanged in one stream.
 *
 * Each message_start creates a new message span with its own event timeline.
 * All SSE events (message_start, content_block_start, content_block_delta, etc.) are recorded
 * as OpenTelemetry events for detailed observability.
 */
export function processSSEEvent(
  event: { event?: string; data: string },
  timestamp: number,
  streamData: SSEStreamData,
): void {
  try {
    const eventType = event.event;
    if (!eventType) return;

    const sseEvent: SSEEvent = {
      type: eventType,
      timestamp,
      data: event.data,
    };

    if (eventType === 'message_start') {
      const newMessage: SSEMessage = {
        messageStart: timestamp,
        events: [sseEvent],
      };
      streamData.messages.push(newMessage);
      return;
    }

    const currentMessage = streamData.messages[streamData.messages.length - 1];
    if (!currentMessage) {
      console.warn('Received SSE event before message_start:', eventType);
      return;
    }

    currentMessage.events.push(sseEvent);

    if (eventType === 'message_stop') {
      currentMessage.messageStop = timestamp;

      const parsed = JSON.parse(event.data) as unknown;
      if (parsed && typeof parsed === 'object') {
        const stop = parsed as Record<string, unknown>;
        const usage = stop.usage;
        if (usage && typeof usage === 'object') {
          const typedUsage = usage as Record<string, unknown>;
          currentMessage.usage = {
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
 * Creates an SSE parser that tracks multiple messages and records all events.
 * The parser mutates the provided streamData object to avoid copying overhead during streaming.
 */
export function createSSEParser(streamData: SSEStreamData): EventSourceParser {
  return createParser({
    onEvent(event) {
      const timestamp = getCurrentTimestamp();
      processSSEEvent(event, timestamp, streamData);
    },
  });
}
