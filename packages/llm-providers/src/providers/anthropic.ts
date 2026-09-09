import type {
  AnthropicContentBlock,
  InputMessage,
  InputContentBlock,
  LLMResponseMetadataSummary,
  LLMTokenUsage,
  SSEMessage,
  SSEStreamData,
} from '@trace-flow/types';
import { createTokenAccumulator } from '../accumulator';
import { parseTokenUsage } from '../parseTokenUsage';
import { PROVIDER_SCHEMAS } from '../schemas';
import type { RawTokenUsage } from '../types';
import type { ParsedSSEEvent, Provider } from './types';
import {
  addSSEMessage,
  appendSSEContentBlock,
  appendSSEEvent,
  appendSSEMetadata,
  boundedSSEMetadataValue,
  isBoundedSSEEventData,
  reportSSEHandlerFailure,
} from './sse-state';

interface AnthropicRequestBody {
  model?: string;
  messages?: {
    role: 'user' | 'assistant';
    content:
      | string
      | {
          type: 'text' | 'tool_use' | 'tool_result' | 'image';
          text?: string;
          id?: string;
          name?: string;
          input?: unknown;
          tool_use_id?: string;
          content?: string | { type: string; text?: string }[];
          source?: unknown;
        }[];
  }[];
  system?: string | { type: 'text'; text: string }[];
}

function parseAnthropicRequestBody(body: string): InputMessage[] | null {
  try {
    const parsed = JSON.parse(body) as AnthropicRequestBody;
    if (!parsed.messages || !Array.isArray(parsed.messages)) return null;

    const inputMessages: InputMessage[] = [];
    let messageIndex = 0;

    if (parsed.system) {
      inputMessages.push({
        role: 'system',
        index: messageIndex++,
        contentBlocks: [{ index: 0, type: 'text' }],
      });
    }

    for (const msg of parsed.messages) {
      const contentBlocks: InputContentBlock[] = [];

      if (typeof msg.content === 'string') {
        contentBlocks.push({ index: 0, type: 'text' });
      } else if (Array.isArray(msg.content)) {
        for (let blockIndex = 0; blockIndex < msg.content.length; blockIndex++) {
          const block = msg.content[blockIndex];
          if (!block) continue;
          const inputBlock: InputContentBlock = { index: blockIndex, type: block.type };
          if (block.type === 'tool_use') {
            inputBlock.toolUseId = block.id;
            inputBlock.toolName = block.name;
          } else if (block.type === 'tool_result') {
            inputBlock.toolResultId = block.tool_use_id;
          }
          contentBlocks.push(inputBlock);
        }
      }

      inputMessages.push({ role: msg.role, index: messageIndex++, contentBlocks });
    }

    return inputMessages;
  } catch {
    console.warn('Provider request body parse failed');
    return null;
  }
}

const ID_PATTERN = /"id"\s*:\s*"([^"]{1,256})"/;
const MODEL_PATTERN = /"model"\s*:\s*"([^"]{1,256})"/;
const STOP_REASON_PATTERN = /"stop_reason"\s*:\s*(?:null|"([^"]{1,256})")/;
const STOP_SEQUENCE_PATTERN = /"stop_sequence"\s*:\s*(?:null|"([^"]{1,256})")/;

const INPUT_TOKENS_PATTERN = /"input_tokens"\s*:\s*(\d{1,20})(?!\d)/;
const OUTPUT_TOKENS_PATTERN = /"output_tokens"\s*:\s*(\d{1,20})(?!\d)/;
const CACHE_CREATION_PATTERN = /"cache_creation_input_tokens"\s*:\s*(\d{1,20})(?!\d)/;
const CACHE_READ_PATTERN = /"cache_read_input_tokens"\s*:\s*(\d{1,20})(?!\d)/;
const EPHEMERAL_5M_PATTERN = /"ephemeral_5m_input_tokens"\s*:\s*(\d{1,20})(?!\d)/;
const EPHEMERAL_1H_PATTERN = /"ephemeral_1h_input_tokens"\s*:\s*(\d{1,20})(?!\d)/;

const CONTENT_BLOCK_INDEX_PATTERN = /"index"\s*:\s*(\d{1,20})(?!\d)/;
const CONTENT_BLOCK_TYPE_PATTERN =
  /"content_block"\s*:\s*\{[^}]*"type"\s*:\s*"(text|tool_use|thinking)"/;
const TOOL_USE_ID_PATTERN = /"content_block"\s*:\s*\{[^}]*"id"\s*:\s*"([^"]{1,256})"/;
const TOOL_USE_NAME_PATTERN = /"content_block"\s*:\s*\{[^}]*"name"\s*:\s*"([^"]{1,256})"/;
const OVERSIZED_ANTHROPIC_EVENT_TYPES = new Set(['message_start', 'message_delta', 'message_stop']);

function extractMetadata(
  data: string,
  existing: LLMResponseMetadataSummary = {},
): LLMResponseMetadataSummary {
  const metadata: LLMResponseMetadataSummary = { ...existing };

  const idMatch = ID_PATTERN.exec(data);
  const id = boundedSSEMetadataValue(idMatch?.[1]);
  if (id && !metadata.id) metadata.id = id;

  const modelMatch = MODEL_PATTERN.exec(data);
  const model = boundedSSEMetadataValue(modelMatch?.[1]);
  if (model && !metadata.model) metadata.model = model;

  const stopReasonMatch = STOP_REASON_PATTERN.exec(data);
  const stopReason = boundedSSEMetadataValue(stopReasonMatch?.[1]);
  if (stopReason && !metadata.stopReason) metadata.stopReason = stopReason;

  const stopSequenceMatch = STOP_SEQUENCE_PATTERN.exec(data);
  const stopSequence = boundedSSEMetadataValue(stopSequenceMatch?.[1]);
  if (stopSequence && !metadata.stopSequence) {
    metadata.stopSequence = stopSequence;
  }

  return metadata;
}

function extractUsage(data: string): RawTokenUsage {
  const usage: RawTokenUsage = {};

  const inputMatch = INPUT_TOKENS_PATTERN.exec(data);
  if (inputMatch?.[1]) usage.input_tokens = parseInt(inputMatch[1], 10);

  const outputMatch = OUTPUT_TOKENS_PATTERN.exec(data);
  if (outputMatch?.[1]) usage.output_tokens = parseInt(outputMatch[1], 10);

  const cacheCreationMatch = CACHE_CREATION_PATTERN.exec(data);
  if (cacheCreationMatch?.[1]) {
    usage.cache_creation_input_tokens = parseInt(cacheCreationMatch[1], 10);
  }

  const cacheReadMatch = CACHE_READ_PATTERN.exec(data);
  if (cacheReadMatch?.[1]) usage.cache_read_input_tokens = parseInt(cacheReadMatch[1], 10);

  const ephemeral5mMatch = EPHEMERAL_5M_PATTERN.exec(data);
  if (ephemeral5mMatch?.[1]) usage.ephemeral_5m_input_tokens = parseInt(ephemeral5mMatch[1], 10);

  const ephemeral1hMatch = EPHEMERAL_1H_PATTERN.exec(data);
  if (ephemeral1hMatch?.[1]) usage.ephemeral_1h_input_tokens = parseInt(ephemeral1hMatch[1], 10);

  return usage;
}

function hasUsageData(usage: RawTokenUsage): boolean {
  return (
    usage.input_tokens !== undefined ||
    usage.output_tokens !== undefined ||
    usage.cache_creation_input_tokens !== undefined ||
    usage.cache_read_input_tokens !== undefined ||
    usage.ephemeral_5m_input_tokens !== undefined ||
    usage.ephemeral_1h_input_tokens !== undefined
  );
}

function parseContentBlockStart(
  data: string,
): Omit<AnthropicContentBlock, 'startTimestamp'> | null {
  const indexMatch = CONTENT_BLOCK_INDEX_PATTERN.exec(data);
  const typeMatch = CONTENT_BLOCK_TYPE_PATTERN.exec(data);
  if (!indexMatch?.[1] || !typeMatch?.[1]) return null;

  const result: Omit<AnthropicContentBlock, 'startTimestamp'> = {
    index: parseInt(indexMatch[1], 10),
    type: typeMatch[1] as 'text' | 'tool_use' | 'thinking',
  };

  if (result.type === 'tool_use') {
    const idMatch = TOOL_USE_ID_PATTERN.exec(data);
    const nameMatch = TOOL_USE_NAME_PATTERN.exec(data);
    result.toolUseId = boundedSSEMetadataValue(idMatch?.[1]);
    result.toolName = boundedSSEMetadataValue(nameMatch?.[1]);
  }

  return result;
}

function parseContentBlockStopIndex(data: string): number | null {
  const match = CONTENT_BLOCK_INDEX_PATTERN.exec(data);
  return match?.[1] ? parseInt(match[1], 10) : null;
}

function parseThinkingDelta(data: unknown): { index: number; textLength: number } | null {
  if (!data || typeof data !== 'object') return null;

  const candidate = data as {
    index?: unknown;
    delta?: { type?: unknown; thinking?: unknown };
  };
  if (
    !Number.isInteger(candidate.index) ||
    candidate.delta?.type !== 'thinking_delta' ||
    typeof candidate.delta.thinking !== 'string'
  ) {
    return null;
  }

  return { index: candidate.index as number, textLength: candidate.delta.thinking.length };
}

function handleSSEEvent(event: ParsedSSEEvent, timestamp: number, state: SSEStreamData): void {
  try {
    const eventType = event.event;
    if (!eventType) return;

    let parsedEventData: unknown;
    if (event.data && event.data.trim().length > 0) {
      if (isBoundedSSEEventData(event.data)) {
        try {
          parsedEventData = JSON.parse(event.data);
        } catch {
          return;
        }
      } else if (!OVERSIZED_ANTHROPIC_EVENT_TYPES.has(eventType)) {
        return;
      }
    }

    if (eventType === 'message_start') {
      const metadata = extractMetadata(event.data);
      const usage = event.data ? extractUsage(event.data) : undefined;
      const newMessage: SSEMessage = {
        messageStart: timestamp,
        events: [],
        metadata,
        usage: usage && hasUsageData(usage) ? usage : undefined,
      };
      appendSSEEvent(newMessage, eventType, timestamp);
      addSSEMessage(state, newMessage);
      return;
    }

    const current = state.messages[state.messages.length - 1];
    if (!current) return;

    appendSSEEvent(current, eventType, timestamp);

    if (event.data) {
      const eventMetadata = extractMetadata(event.data, current.metadata);
      appendSSEMetadata(current, eventMetadata);
    }

    if (eventType === 'content_block_start' && event.data) {
      const blockInfo = parseContentBlockStart(event.data);
      if (blockInfo) {
        appendSSEContentBlock(current, { ...blockInfo, startTimestamp: timestamp });
      }
    }

    if (eventType === 'content_block_delta' && current.contentBlocks) {
      const thinkingDelta = parseThinkingDelta(parsedEventData);
      if (thinkingDelta) {
        const block = current.contentBlocks.find((item) => item.index === thinkingDelta.index);
        if (block) {
          block.thinkingTextLength = (block.thinkingTextLength ?? 0) + thinkingDelta.textLength;
        }
      }
    }

    if (eventType === 'content_block_stop' && event.data) {
      const blockIndex = parseContentBlockStopIndex(event.data);
      if (blockIndex !== null && current.contentBlocks) {
        const block = current.contentBlocks.find((b) => b.index === blockIndex);
        if (block) block.stopTimestamp = timestamp;
      }
    }

    const carriesUsage = eventType === 'message_stop' || eventType === 'message_delta';

    if (carriesUsage) {
      if (eventType === 'message_stop') current.messageStop = timestamp;
      if (event.data) {
        const extracted = extractUsage(event.data);
        const merged: RawTokenUsage = { ...current.usage, ...extracted };
        current.usage = hasUsageData(merged) ? merged : undefined;
      }
    }
  } catch {
    reportSSEHandlerFailure(state);
  }
}

function aggregateSSETokens(streamData: SSEStreamData): LLMTokenUsage | undefined {
  if (!streamData.messages || streamData.messages.length === 0) return undefined;

  const accumulator = createTokenAccumulator('anthropic');
  for (const message of streamData.messages) {
    if (message.contentBlocks) {
      for (const block of message.contentBlocks) {
        if (block.type === 'thinking' && block.thinkingTextLength) {
          accumulator.acceptThinkingChars(block.thinkingTextLength);
        }
      }
    }
    if (message.usage) accumulator.acceptEvent(message.usage);
  }
  return accumulator.finalize();
}

export const anthropic: Provider = {
  id: 'anthropic',
  baseUrl: 'https://api.anthropic.com',
  tokenSchema: PROVIDER_SCHEMAS.anthropic,

  parseRequestBody: parseAnthropicRequestBody,
  parseResponseMetadata: (body) => {
    const metadata = extractMetadata(body);
    return Object.keys(metadata).length > 0 ? metadata : undefined;
  },
  parseResponseTokenUsage: (body) => parseTokenUsage(body, 'anthropic'),

  handleSSEEvent,
  aggregateSSETokens,
};
