import { createParser, type EventSourceParser } from 'eventsource-parser';
import type { SSEStreamData, SSEMessage, SSEEvent } from '@trace-flow/types';
import { getCurrentTimestamp } from '@trace-flow/utils';
import {
  extractMetadataFromSSEData,
  extractTokenUsageFromSSEData,
} from '../parsers/metadata-regex';

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

    // Validate JSON structure for event data (regex parsing won't catch malformed JSON)
    // This helps catch errors that would have been caught by JSON.parse in the old implementation
    // SSE event data should be valid JSON, so validate it
    if (event.data && event.data.trim().length > 0) {
      try {
        // Quick validation: try parsing to detect malformed JSON
        // This matches the old behavior where JSON.parse would throw on invalid JSON
        JSON.parse(event.data);
      } catch (parseError) {
        console.error('Error parsing SSE event:', {
          error: parseError,
          eventType: event.event,
          timestamp,
          dataPreview: event.data?.substring(0, 100),
        });
        return;
      }
    }

    const sseEvent: SSEEvent = {
      type: eventType,
      timestamp,
      data: event.data,
    };

    if (eventType === 'message_start') {
      // Extract metadata and usage from message_start (Anthropic includes usage here)
      const metadata = extractMetadataFromSSEData(event.data);
      const usage = event.data ? extractTokenUsageFromSSEData(event.data) : undefined;

      const newMessage: SSEMessage = {
        messageStart: timestamp,
        events: [sseEvent],
        metadata,
        usage: usage?.input_tokens || usage?.output_tokens ? usage : undefined,
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

    // Extract metadata from this event (accumulates across events)
    // This handles all event types including finish_reason, stop_reason, etc.
    if (event.data) {
      const eventMetadata = extractMetadataFromSSEData(event.data, currentMessage.metadata);
      currentMessage.metadata = { ...currentMessage.metadata, ...eventMetadata };
    }

    if (eventType === 'message_stop' || eventType === 'message_delta') {
      // Update messageStop timestamp for message_stop events
      if (eventType === 'message_stop') {
        currentMessage.messageStop = timestamp;
      }

      // Extract usage from stop/delta events using regex (for token counts)
      if (event.data) {
        const extractedUsage = extractTokenUsageFromSSEData(event.data);
        // Merge with existing usage (accumulate across events)
        const mergedUsage = {
          ...currentMessage.usage,
          ...extractedUsage,
        };
        // Only set usage if it has at least one property with a value
        const hasUsageData =
          mergedUsage.input_tokens !== undefined ||
          mergedUsage.output_tokens !== undefined ||
          mergedUsage.cache_creation_input_tokens !== undefined ||
          mergedUsage.cache_read_input_tokens !== undefined;
        currentMessage.usage = hasUsageData ? mergedUsage : undefined;
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
