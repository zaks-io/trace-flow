import type { AnthropicContentBlock, SSEMessage, SSEStreamData } from '@trace-flow/types';

/**
 * SSE state is an aggregate used for analytics, not a transcript buffer.
 * These caps keep hostile or malfunctioning providers from turning event
 * volume into retained Worker state while the response continues downstream.
 */
export const MAX_SSE_MESSAGES = 16;
export const MAX_SSE_EVENTS_PER_MESSAGE = 512;
export const MAX_SSE_RETAINED_EVENTS = MAX_SSE_MESSAGES * MAX_SSE_EVENTS_PER_MESSAGE;
export const MAX_SSE_CONTENT_BLOCKS_PER_MESSAGE = 128;
export const MAX_SSE_METADATA_VALUE_LENGTH = 256;
export const MAX_SSE_EVENT_DATA_LENGTH = 64 * 1024;

const UTF8_ENCODER = new TextEncoder();
const REPORTED_SSE_FAILURES = new WeakSet<SSEStreamData>();

function utf8ByteLengthWithin(value: string, limit: number): boolean {
  if (value.length > limit) return false;
  if (value.length * 3 <= limit) return true;
  return UTF8_ENCODER.encode(value).byteLength <= limit;
}

export function isBoundedSSEEventData(data: string): boolean {
  return utf8ByteLengthWithin(data, MAX_SSE_EVENT_DATA_LENGTH);
}

export function boundedSSEMetadataValue(value: string | undefined): string | undefined {
  return value && utf8ByteLengthWithin(value, MAX_SSE_METADATA_VALUE_LENGTH) ? value : undefined;
}

export function reportSSEHandlerFailure(streamData: SSEStreamData): void {
  if (REPORTED_SSE_FAILURES.has(streamData)) return;
  REPORTED_SSE_FAILURES.add(streamData);
  console.error('Provider SSE event handling failed');
}

export function addSSEMessage(
  streamData: SSEStreamData,
  message: SSEMessage,
): SSEMessage | undefined {
  if (streamData.messages.length >= MAX_SSE_MESSAGES) return undefined;
  streamData.messages.push(message);
  return message;
}

/**
 * Retain only event identity and timing. Raw `data` belongs in the encrypted
 * response body and must never be copied into delivery metadata.
 */
export function appendSSEEvent(message: SSEMessage, type: string, timestamp: number): void {
  const boundedType = boundedSSEMetadataValue(type);
  if (!boundedType || message.events.length >= MAX_SSE_EVENTS_PER_MESSAGE) return;
  message.events.push({ type: boundedType, timestamp });
}

export function appendSSEContentBlock(message: SSEMessage, block: AnthropicContentBlock): void {
  if ((message.contentBlocks?.length ?? 0) >= MAX_SSE_CONTENT_BLOCKS_PER_MESSAGE) return;
  message.contentBlocks ??= [];
  message.contentBlocks.push(block);
}

export function appendSSEMetadata(current: SSEMessage, metadata: SSEMessage['metadata']): void {
  if (!metadata) return;
  current.metadata = { ...current.metadata, ...metadata };
}
