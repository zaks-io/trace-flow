import { createParser, type EventSourceParser } from 'eventsource-parser';
import type {
  SSEStreamData,
  SSEMessage,
  SSEEvent,
  AnthropicContentBlock,
  LLMTokenUsage,
} from '@trace-flow/types';
import { getCurrentTimestamp } from '@trace-flow/utils';
import { createTokenAccumulator, type ProviderId } from '@trace-flow/llm-providers';
import {
  extractMetadataFromSSEData,
  extractTokenUsageFromSSEData,
} from '../parsers/metadata-regex';

// Regex patterns for content block parsing (performance-optimized, consistent with metadata-regex.ts)
const CONTENT_BLOCK_INDEX_PATTERN = /"index"\s*:\s*(\d+)/;
const CONTENT_BLOCK_TYPE_PATTERN =
  /"content_block"\s*:\s*\{[^}]*"type"\s*:\s*"(text|tool_use|thinking)"/;
const TOOL_USE_ID_PATTERN = /"content_block"\s*:\s*\{[^}]*"id"\s*:\s*"([^"]+)"/;
const TOOL_USE_NAME_PATTERN = /"content_block"\s*:\s*\{[^}]*"name"\s*:\s*"([^"]+)"/;
const THINKING_DELTA_TYPE_PATTERN = /"type"\s*:\s*"thinking_delta"/;
const THINKING_DELTA_TEXT_PATTERN = /"thinking"\s*:\s*"((?:[^"\\]|\\.)*)"/;

/**
 * Parses content_block_start event data to extract block info.
 */
function parseContentBlockStart(
  data: string,
): Omit<AnthropicContentBlock, 'startTimestamp'> | null {
  const indexMatch = CONTENT_BLOCK_INDEX_PATTERN.exec(data);
  const typeMatch = CONTENT_BLOCK_TYPE_PATTERN.exec(data);

  if (!indexMatch?.[1] || !typeMatch?.[1]) {
    return null;
  }

  const result: Omit<AnthropicContentBlock, 'startTimestamp'> = {
    index: parseInt(indexMatch[1], 10),
    type: typeMatch[1] as 'text' | 'tool_use' | 'thinking',
  };

  if (result.type === 'tool_use') {
    const idMatch = TOOL_USE_ID_PATTERN.exec(data);
    const nameMatch = TOOL_USE_NAME_PATTERN.exec(data);
    if (idMatch?.[1]) result.toolUseId = idMatch[1];
    if (nameMatch?.[1]) result.toolName = nameMatch[1];
  }

  return result;
}

/**
 * Parses content_block_stop event data to extract the block index.
 */
function parseContentBlockStopIndex(data: string): number | null {
  const match = CONTENT_BLOCK_INDEX_PATTERN.exec(data);
  return match?.[1] ? parseInt(match[1], 10) : null;
}

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

    // Handle OpenAI-style streaming (no event type, just data lines)
    if (!eventType) {
      // [DONE] marks stream completion
      if (event.data === '[DONE]') {
        const currentMessage = streamData.messages[streamData.messages.length - 1];
        if (currentMessage && !currentMessage.messageStop) {
          currentMessage.messageStop = timestamp;
        }
        return;
      }

      // Skip empty data
      if (!event.data || event.data.trim().length === 0) {
        return;
      }

      // Validate JSON
      try {
        JSON.parse(event.data);
      } catch {
        return; // Skip non-JSON data
      }

      // Create message on first chunk if none exists
      if (streamData.messages.length === 0) {
        const metadata = extractMetadataFromSSEData(event.data);
        streamData.messages.push({
          messageStart: timestamp,
          events: [],
          metadata,
        });
      }

      const currentMessage = streamData.messages[streamData.messages.length - 1];
      if (!currentMessage) return;

      // Track as content_block_delta event for TTFT detection
      currentMessage.events.push({
        type: 'content_block_delta',
        timestamp,
        data: event.data,
      });

      // Extract and accumulate metadata (finish_reason, usage, etc.)
      const eventMetadata = extractMetadataFromSSEData(event.data, currentMessage.metadata);
      currentMessage.metadata = { ...currentMessage.metadata, ...eventMetadata };

      // Extract usage from OpenAI streaming chunks
      const extractedUsage = extractTokenUsageFromSSEData(event.data);
      if (extractedUsage) {
        const mergedUsage = { ...currentMessage.usage, ...extractedUsage };
        const hasUsageData =
          mergedUsage.input_tokens !== undefined ||
          mergedUsage.output_tokens !== undefined ||
          mergedUsage.cached_tokens !== undefined ||
          mergedUsage.prompt_token_count !== undefined ||
          mergedUsage.candidates_token_count !== undefined;
        if (hasUsageData) currentMessage.usage = mergedUsage;
      }

      return;
    }

    // Anthropic-style streaming (has event types)
    // Validate JSON structure for event data
    if (event.data && event.data.trim().length > 0) {
      try {
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

    // message_start (Anthropic) and response.created (OpenAI Responses API) both
    // open a new message span — Anthropic includes initial usage here, Responses
    // API only ships an id/model shell.
    if (eventType === 'message_start' || eventType === 'response.created') {
      const metadata = extractMetadataFromSSEData(event.data);
      const usage = event.data ? extractTokenUsageFromSSEData(event.data) : undefined;

      const newMessage: SSEMessage = {
        messageStart: timestamp,
        events: [sseEvent],
        metadata,
        usage:
          usage?.input_tokens !== undefined ||
          usage?.output_tokens !== undefined ||
          usage?.cache_creation_input_tokens !== undefined ||
          usage?.cache_read_input_tokens !== undefined ||
          usage?.cached_tokens !== undefined ||
          usage?.ephemeral_5m_input_tokens !== undefined ||
          usage?.ephemeral_1h_input_tokens !== undefined
            ? usage
            : undefined,
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

    // Track content block start (Anthropic-specific)
    if (eventType === 'content_block_start' && event.data) {
      const blockInfo = parseContentBlockStart(event.data);
      if (blockInfo) {
        currentMessage.contentBlocks ??= [];
        currentMessage.contentBlocks.push({
          ...blockInfo,
          startTimestamp: timestamp,
        });
      }
    }

    // Track thinking text length from thinking_delta events (Anthropic extended thinking)
    if (eventType === 'content_block_delta' && event.data && currentMessage.contentBlocks) {
      if (THINKING_DELTA_TYPE_PATTERN.test(event.data)) {
        const indexMatch = CONTENT_BLOCK_INDEX_PATTERN.exec(event.data);
        const textMatch = THINKING_DELTA_TEXT_PATTERN.exec(event.data);
        if (indexMatch?.[1] && textMatch?.[1]) {
          const blockIndex = parseInt(indexMatch[1], 10);
          const block = currentMessage.contentBlocks.find((b) => b.index === blockIndex);
          if (block) {
            block.thinkingTextLength = (block.thinkingTextLength ?? 0) + textMatch[1].length;
          }
        }
      }
    }

    // Track content block stop (Anthropic-specific)
    if (eventType === 'content_block_stop' && event.data) {
      const blockIndex = parseContentBlockStopIndex(event.data);
      if (blockIndex !== null && currentMessage.contentBlocks) {
        const block = currentMessage.contentBlocks.find((b) => b.index === blockIndex);
        if (block) {
          block.stopTimestamp = timestamp;
        }
      }
    }

    // Events that carry usage data we want to extract. message_delta is mid-stream
    // for Anthropic (carries incremental output_tokens) so it's grouped here even
    // though it isn't a stream-closing event.
    const shouldExtractUsage =
      eventType === 'message_stop' ||
      eventType === 'message_delta' ||
      eventType === 'response.completed' ||
      eventType === 'response.failed' ||
      eventType === 'response.incomplete';

    if (shouldExtractUsage) {
      // Stream-closing events (everything except message_delta) also stamp messageStop
      if (
        eventType === 'message_stop' ||
        eventType === 'response.completed' ||
        eventType === 'response.failed' ||
        eventType === 'response.incomplete'
      ) {
        currentMessage.messageStop = timestamp;
      }

      // Extract usage from terminal events using regex (for token counts)
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
          mergedUsage.cache_read_input_tokens !== undefined ||
          mergedUsage.cached_tokens !== undefined ||
          mergedUsage.ephemeral_5m_input_tokens !== undefined ||
          mergedUsage.ephemeral_1h_input_tokens !== undefined;
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

/**
 * Aggregates token usage from all SSE messages into a unified LLMTokenUsage format.
 * Provider-specific normalization (Anthropic input+cache reconstruction, Google
 * cachedContent unification, Anthropic thinking-token estimation) lives in the
 * shared `createTokenAccumulator` so streaming and whole-body extraction stay in sync.
 */
export function aggregateSSETokens(
  streamData: SSEStreamData,
  provider: ProviderId,
): LLMTokenUsage | undefined {
  if (!streamData.messages || streamData.messages.length === 0) {
    return undefined;
  }

  const accumulator = createTokenAccumulator(provider);

  for (const message of streamData.messages) {
    if (message.contentBlocks) {
      for (const block of message.contentBlocks) {
        if (block.type === 'thinking' && block.thinkingTextLength) {
          accumulator.acceptThinkingChars(block.thinkingTextLength);
        }
      }
    }
    if (message.usage) {
      accumulator.acceptEvent(message.usage);
    }
  }

  return accumulator.finalize();
}
