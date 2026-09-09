import {
  MAX_SSE_CONTENT_BLOCKS_PER_MESSAGE,
  MAX_SSE_EVENTS_PER_MESSAGE,
  MAX_SSE_MESSAGES,
  boundedSSEMetadataValue,
} from '@trace-flow/llm-providers';
import type {
  AnthropicContentBlock,
  LLMResponseMetadata,
  LLMResponseMetadataSummary,
  SSEMessage,
  SSEStreamData,
} from '@trace-flow/types';

function boundedString(value: string | undefined): string | undefined {
  return boundedSSEMetadataValue(value);
}

/** Keep only bounded response metadata; body text remains encrypted. */
export function sanitizeResponseMetadata(
  metadata: Partial<LLMResponseMetadata> | LLMResponseMetadataSummary,
): LLMResponseMetadataSummary {
  const safe: LLMResponseMetadataSummary = {};
  const id = boundedString(metadata.id);
  const model = boundedString(metadata.model);
  const object = boundedString(metadata.object);
  const finishReason = boundedString(metadata.finishReason);
  const nativeFinishReason = boundedString(metadata.nativeFinishReason);
  const stopReason = boundedString(metadata.stopReason ?? undefined);
  const stopSequence = boundedString(metadata.stopSequence ?? undefined);

  if (id) safe.id = id;
  if (model) safe.model = model;
  if (object) safe.object = object;
  if (typeof metadata.created === 'number' && Number.isFinite(metadata.created)) {
    safe.created = metadata.created;
  }
  if (finishReason) safe.finishReason = finishReason;
  if (nativeFinishReason) safe.nativeFinishReason = nativeFinishReason;
  if (stopReason) safe.stopReason = stopReason;
  if (stopSequence) safe.stopSequence = stopSequence;
  if (typeof metadata.hasLogprobs === 'boolean') safe.hasLogprobs = metadata.hasLogprobs;
  if (typeof metadata.reasoningTokens === 'number' && Number.isFinite(metadata.reasoningTokens)) {
    safe.reasoningTokens = metadata.reasoningTokens;
  }

  const summary = metadata as LLMResponseMetadataSummary;
  const legacy = metadata as Partial<LLMResponseMetadata>;
  if (typeof summary.hasRefusal === 'boolean') {
    safe.hasRefusal = summary.hasRefusal;
  } else if (legacy.refusal !== undefined) {
    safe.hasRefusal = legacy.refusal !== null;
  }
  if (typeof summary.hasReasoning === 'boolean') {
    safe.hasReasoning = summary.hasReasoning;
  } else if (legacy.reasoning !== undefined) {
    safe.hasReasoning = legacy.reasoning !== null;
  }

  return safe;
}

function sanitizeContentBlock(block: AnthropicContentBlock): AnthropicContentBlock | undefined {
  if (block.type !== 'text' && block.type !== 'tool_use' && block.type !== 'thinking') {
    return undefined;
  }

  const safe: AnthropicContentBlock = {
    index: block.index,
    type: block.type,
    startTimestamp: block.startTimestamp,
  };
  const toolUseId = boundedString(block.toolUseId);
  const toolName = boundedString(block.toolName);
  if (toolUseId) safe.toolUseId = toolUseId;
  if (toolName) safe.toolName = toolName;
  if (block.stopTimestamp !== undefined) safe.stopTimestamp = block.stopTimestamp;
  if (block.thinkingTextLength !== undefined) {
    safe.thinkingTextLength = block.thinkingTextLength;
  }
  return safe;
}

type SSEUsage = NonNullable<SSEMessage['usage']>;
const SSE_USAGE_KEYS: (keyof SSEUsage)[] = [
  'input_tokens',
  'cache_creation_input_tokens',
  'cache_read_input_tokens',
  'cache_write_tokens',
  'cached_tokens',
  'ephemeral_5m_input_tokens',
  'ephemeral_1h_input_tokens',
  'output_tokens',
  'reasoning_tokens',
  'cost',
  'prompt_token_count',
  'candidates_token_count',
  'cached_content_token_count',
  'total_token_count',
  'thoughts_token_count',
];

function sanitizeSSEUsage(usage: SSEUsage): SSEUsage {
  const safe: SSEUsage = {};
  for (const key of SSE_USAGE_KEYS) {
    const value = usage[key];
    if (typeof value === 'number' && Number.isFinite(value)) safe[key] = value;
  }
  return safe;
}

function sanitizeSSEMessage(message: SSEMessage): SSEMessage {
  const safe: SSEMessage = {
    messageStart: message.messageStart,
    events: message.events.slice(0, MAX_SSE_EVENTS_PER_MESSAGE).flatMap((event) => {
      const type = boundedString(event.type);
      return type ? [{ type, timestamp: event.timestamp }] : [];
    }),
  };
  if (message.messageStop !== undefined) safe.messageStop = message.messageStop;
  if (message.usage) safe.usage = sanitizeSSEUsage(message.usage);
  if (message.metadata) safe.metadata = sanitizeResponseMetadata(message.metadata);
  if (message.contentBlocks) {
    safe.contentBlocks = message.contentBlocks
      .slice(0, MAX_SSE_CONTENT_BLOCKS_PER_MESSAGE)
      .flatMap((block) => {
        const safeBlock = sanitizeContentBlock(block);
        return safeBlock ? [safeBlock] : [];
      });
  }
  return safe;
}

export function sanitizeSSEStreamData(streamData: SSEStreamData): SSEStreamData {
  return {
    messages: streamData.messages.slice(0, MAX_SSE_MESSAGES).map(sanitizeSSEMessage),
  };
}
