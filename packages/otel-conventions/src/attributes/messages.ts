import type { AnthropicContentBlock, InputMessage } from '@trace-flow/types';
import { GEN_AI, EVENT_NAMES, inputEventName, outputEventName } from '../keys';

export interface SpanEventInput {
  timestampMs: number;
  name: string;
  attributes: Record<string, string>;
}

export function inputMessageEvents(
  inputMessages: InputMessage[],
  requestTimestampMs: number,
): SpanEventInput[] {
  const events: SpanEventInput[] = [];
  for (const message of inputMessages) {
    if (message.role === 'system') {
      events.push({
        timestampMs: requestTimestampMs,
        name: EVENT_NAMES.INPUT_SYSTEM,
        attributes: {
          [GEN_AI.MESSAGE_ROLE]: message.role,
          [GEN_AI.MESSAGE_INDEX]: String(message.index),
        },
      });
      continue;
    }
    for (const block of message.contentBlocks) {
      const attributes: Record<string, string> = {
        [GEN_AI.MESSAGE_ROLE]: message.role,
        [GEN_AI.MESSAGE_INDEX]: String(message.index),
        [GEN_AI.CONTENT_TYPE]: block.type,
      };

      let name: string;
      if (block.type === 'tool_result') {
        name = inputEventName('tool_result');
        if (block.toolResultId) attributes[GEN_AI.TOOL_ID] = block.toolResultId;
      } else if (block.type === 'tool_use' || block.type === 'tool_call') {
        name = inputEventName('tool_use');
        if (block.toolUseId) attributes[GEN_AI.TOOL_ID] = block.toolUseId;
        if (block.toolName) attributes[GEN_AI.TOOL_NAME] = block.toolName;
      } else {
        name = inputEventName(block.type);
      }

      events.push({ timestampMs: requestTimestampMs, name, attributes });
    }
  }
  return events;
}

export function outputBlockEvents(
  blocks: AnthropicContentBlock[],
  fallbackTimestampMs: number,
): SpanEventInput[] {
  return blocks.map((block) => {
    const attributes: Record<string, string> = {
      [GEN_AI.CONTENT_TYPE]: block.type,
      [GEN_AI.MESSAGE_INDEX]: String(block.index),
    };
    if (block.type === 'tool_use') {
      if (block.toolUseId) attributes[GEN_AI.TOOL_ID] = block.toolUseId;
      if (block.toolName) attributes[GEN_AI.TOOL_NAME] = block.toolName;
    }
    return {
      timestampMs: block.stopTimestamp ?? fallbackTimestampMs,
      name: outputEventName(block.type),
      attributes,
    };
  });
}

/**
 * The unified message-index calculation (`inputMessageCount + messageIndex*100
 * + block.index`) is preserved from the pre-refactor logic to keep span
 * ordering stable across the migration.
 */
export function contentBlockSpanAttributes(
  block: AnthropicContentBlock,
  messageIndex: number,
  requestId: string,
  inputMessageCount: number,
): Record<string, string> {
  const attributes: Record<string, string> = {
    [GEN_AI.REQUEST_ID]: requestId,
    [GEN_AI.MESSAGE_INDEX]: String(inputMessageCount + messageIndex * 100 + block.index),
    [GEN_AI.CONTENT_TYPE]: block.type,
  };
  if (block.type === 'tool_use') {
    if (block.toolUseId) attributes[GEN_AI.TOOL_ID] = block.toolUseId;
    if (block.toolName) attributes[GEN_AI.TOOL_NAME] = block.toolName;
  }
  return attributes;
}

export function toolCallBracketEvents(block: AnthropicContentBlock): SpanEventInput[] {
  if (block.type !== 'tool_use' || block.stopTimestamp === undefined) return [];
  const toolId = block.toolUseId ?? '';
  const toolName = block.toolName ?? '';
  const baseAttrs = { [GEN_AI.TOOL_ID]: toolId, [GEN_AI.TOOL_NAME]: toolName };
  return [
    {
      timestampMs: block.startTimestamp,
      name: EVENT_NAMES.TOOL_CALL_START,
      attributes: baseAttrs,
    },
    {
      timestampMs: block.stopTimestamp,
      name: EVENT_NAMES.TOOL_CALL_END,
      attributes: baseAttrs,
    },
  ];
}
