import type {
  InputMessage,
  InputContentBlock,
  LLMResponseMetadata,
  LLMTokenUsage,
  SSEStreamData,
  SSEMessage,
  SSEEvent,
} from '@trace-flow/types';
import { createTokenAccumulator } from '../accumulator';
import { parseTokenUsage } from '../parseTokenUsage';
import type { ProviderId, RawTokenUsage } from '../types';
import type { ParsedSSEEvent } from './types';

type OpenAIContentPart =
  | { type: 'text'; text?: string }
  | { type: 'image_url'; image_url?: unknown }
  | { type: 'input_audio'; input_audio?: unknown }
  | { type: string; [key: string]: unknown };

interface OpenAIStyleRequestBody {
  model?: string;
  messages?: {
    role: 'user' | 'assistant' | 'system' | 'tool';
    content?: string | null | OpenAIContentPart[];
    tool_calls?: {
      id: string;
      type: 'function';
      function: {
        name: string;
        arguments: string;
      };
    }[];
    tool_call_id?: string;
  }[];
}

export function parseOpenAIStyleRequestBody(body: string): InputMessage[] | null {
  try {
    const parsed = JSON.parse(body) as OpenAIStyleRequestBody;

    if (!parsed.messages || !Array.isArray(parsed.messages)) {
      return null;
    }

    const inputMessages: InputMessage[] = [];

    for (let messageIndex = 0; messageIndex < parsed.messages.length; messageIndex++) {
      const msg = parsed.messages[messageIndex];
      if (!msg) continue;

      const contentBlocks: InputContentBlock[] = [];

      if (typeof msg.content === 'string') {
        contentBlocks.push({ index: contentBlocks.length, type: 'text' });
      } else if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (!part || typeof part !== 'object') continue;
          if (part.type === 'image_url') {
            contentBlocks.push({ index: contentBlocks.length, type: 'image' });
          } else {
            contentBlocks.push({ index: contentBlocks.length, type: 'text' });
          }
        }
      }

      if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
        for (const toolCall of msg.tool_calls) {
          if (!toolCall) continue;
          contentBlocks.push({
            index: contentBlocks.length,
            type: 'tool_call',
            toolUseId: toolCall.id,
            toolName: toolCall.function?.name,
          });
        }
      }

      if (msg.role === 'tool' && msg.tool_call_id) {
        contentBlocks.push({
          index: contentBlocks.length,
          type: 'tool_result',
          toolResultId: msg.tool_call_id,
        });
      }

      if (contentBlocks.length > 0) {
        inputMessages.push({ role: msg.role, index: messageIndex, contentBlocks });
      }
    }

    return inputMessages.length > 0 ? inputMessages : null;
  } catch {
    return null;
  }
}

const ID_PATTERN = /"id"\s*:\s*"([^"]+)"/;
const MODEL_PATTERN = /"model"\s*:\s*"([^"]+)"/;
const OBJECT_PATTERN = /"object"\s*:\s*"([^"]+)"/;
const CREATED_PATTERN = /"created"\s*:\s*(\d+)/;
const CREATED_AT_PATTERN = /"created_at"\s*:\s*(\d+)/;
const FINISH_REASON_PATTERN = /"finish_reason"\s*:\s*"([^"]+)"/;
const NATIVE_FINISH_REASON_PATTERN = /"native_finish_reason"\s*:\s*"([^"]+)"/;
const RESPONSE_STATUS_PATTERN = /"status"\s*:\s*"([^"]+)"/;
const RESPONSES_API_MARKER = /"object"\s*:\s*"response"|"type"\s*:\s*"response\./;
const TERMINAL_RESPONSE_STATUSES = new Set(['completed', 'failed', 'incomplete', 'cancelled']);
const REASONING_TOKENS_PATTERN = /"reasoning_tokens"\s*:\s*(\d+)/;
const HAS_LOGPROBS_PATTERN = /"logprobs"\s*:\s*(?:null|{)/;
const REFUSAL_PATTERN = /"refusal"\s*:\s*(?:null|"([^"]*)")/;
const REASONING_PATTERN = /"reasoning"\s*:\s*(?:null|"([^"]*)")/;

const INPUT_TOKENS_PATTERN = /"input_tokens"\s*:\s*(\d+)/;
const OUTPUT_TOKENS_PATTERN = /"output_tokens"\s*:\s*(\d+)/;
const PROMPT_TOKENS_PATTERN = /"prompt_tokens"\s*:\s*(\d+)/;
const COMPLETION_TOKENS_PATTERN = /"completion_tokens"\s*:\s*(\d+)/;
const CACHED_TOKENS_PATTERN = /"cached_tokens"\s*:\s*(\d+)/;
const CACHE_WRITE_TOKENS_PATTERN = /"cache_write_tokens"\s*:\s*(\d+)/;
const UPSTREAM_COST_PATTERN = /"usage"[\s\S]*?"cost"\s*:\s*([0-9.eE+-]+)/;

function runRegex(pattern: RegExp, data: string): RegExpExecArray | null {
  return pattern.exec(data);
}

function extractOpenAIStyleMetadata(
  data: string,
  existing: Partial<LLMResponseMetadata> = {},
): Partial<LLMResponseMetadata> {
  const metadata: Partial<LLMResponseMetadata> = { ...existing };

  const idMatch = runRegex(ID_PATTERN, data);
  if (idMatch && !metadata.id) metadata.id = idMatch[1];

  const modelMatch = runRegex(MODEL_PATTERN, data);
  if (modelMatch && !metadata.model) metadata.model = modelMatch[1];

  const objectMatch = runRegex(OBJECT_PATTERN, data);
  if (objectMatch && !metadata.object) metadata.object = objectMatch[1];

  const createdMatch = runRegex(CREATED_PATTERN, data);
  if (createdMatch?.[1] && !metadata.created) metadata.created = parseInt(createdMatch[1], 10);

  if (!metadata.created) {
    const createdAtMatch = runRegex(CREATED_AT_PATTERN, data);
    if (createdAtMatch?.[1]) metadata.created = parseInt(createdAtMatch[1], 10);
  }

  const finishReasonMatch = runRegex(FINISH_REASON_PATTERN, data);
  if (finishReasonMatch && !metadata.finishReason) metadata.finishReason = finishReasonMatch[1];

  if (RESPONSES_API_MARKER.test(data)) {
    const statusMatch = runRegex(RESPONSE_STATUS_PATTERN, data);
    if (statusMatch?.[1] && TERMINAL_RESPONSE_STATUSES.has(statusMatch[1])) {
      metadata.finishReason = statusMatch[1];
    }
  }

  const nativeFinishReasonMatch = runRegex(NATIVE_FINISH_REASON_PATTERN, data);
  if (nativeFinishReasonMatch && !metadata.nativeFinishReason) {
    metadata.nativeFinishReason = nativeFinishReasonMatch[1];
  }

  const reasoningTokensMatch = runRegex(REASONING_TOKENS_PATTERN, data);
  if (reasoningTokensMatch?.[1] && !metadata.reasoningTokens) {
    metadata.reasoningTokens = parseInt(reasoningTokensMatch[1], 10);
  }

  if (HAS_LOGPROBS_PATTERN.test(data) && metadata.hasLogprobs === undefined) {
    metadata.hasLogprobs = true;
  }

  const refusalMatch = runRegex(REFUSAL_PATTERN, data);
  if (refusalMatch && metadata.refusal === undefined) {
    metadata.refusal = refusalMatch[1] ?? null;
  }

  const reasoningMatch = runRegex(REASONING_PATTERN, data);
  if (reasoningMatch && metadata.reasoning === undefined) {
    metadata.reasoning = reasoningMatch[1] ?? null;
  }

  return metadata;
}

function extractOpenAIStyleUsage(data: string, includeCost = false): RawTokenUsage {
  const usage: RawTokenUsage = {};

  const inputTokensMatch = runRegex(INPUT_TOKENS_PATTERN, data);
  if (inputTokensMatch?.[1]) usage.input_tokens = parseInt(inputTokensMatch[1], 10);

  const outputTokensMatch = runRegex(OUTPUT_TOKENS_PATTERN, data);
  if (outputTokensMatch?.[1]) usage.output_tokens = parseInt(outputTokensMatch[1], 10);

  if (usage.input_tokens === undefined) {
    const promptMatch = runRegex(PROMPT_TOKENS_PATTERN, data);
    if (promptMatch?.[1]) usage.input_tokens = parseInt(promptMatch[1], 10);
  }

  if (usage.output_tokens === undefined) {
    const completionMatch = runRegex(COMPLETION_TOKENS_PATTERN, data);
    if (completionMatch?.[1]) usage.output_tokens = parseInt(completionMatch[1], 10);
  }

  const cachedMatch = runRegex(CACHED_TOKENS_PATTERN, data);
  if (cachedMatch?.[1]) usage.cached_tokens = parseInt(cachedMatch[1], 10);

  const cacheWriteMatch = runRegex(CACHE_WRITE_TOKENS_PATTERN, data);
  if (cacheWriteMatch?.[1]) usage.cache_write_tokens = parseInt(cacheWriteMatch[1], 10);

  const reasoningMatch = runRegex(REASONING_TOKENS_PATTERN, data);
  if (reasoningMatch?.[1]) usage.reasoning_tokens = parseInt(reasoningMatch[1], 10);

  if (includeCost) {
    const costMatch = runRegex(UPSTREAM_COST_PATTERN, data);
    if (costMatch?.[1]) usage.cost = parseFloat(costMatch[1]);
  }

  return usage;
}

function hasUsageData(usage: RawTokenUsage): boolean {
  return (
    usage.input_tokens !== undefined ||
    usage.output_tokens !== undefined ||
    usage.cached_tokens !== undefined ||
    usage.cache_write_tokens !== undefined ||
    usage.reasoning_tokens !== undefined ||
    usage.cost !== undefined
  );
}

/**
 * Handles OpenAI-style SSE events. Covers two streaming shapes:
 *
 * 1. Chat Completions / Groq / OpenRouter: no `event:` field, just JSON `data:` lines
 *    terminated by `[DONE]`. Single message; usage arrives in the final chunk.
 * 2. Responses API: typed events (`response.created`, `response.completed`, …) where
 *    `response.created` opens the message and `response.completed|failed|incomplete`
 *    carry terminal usage + map status → finishReason.
 */
export function handleOpenAIStyleSSEEvent(
  event: ParsedSSEEvent,
  timestamp: number,
  state: SSEStreamData,
  options: { includeCost?: boolean } = {},
): void {
  const includeCost = options.includeCost ?? false;

  try {
    const eventType = event.event;

    if (!eventType) {
      if (event.data === '[DONE]') {
        const current = state.messages[state.messages.length - 1];
        if (current && !current.messageStop) current.messageStop = timestamp;
        return;
      }

      if (!event.data || event.data.trim().length === 0) return;

      try {
        JSON.parse(event.data);
      } catch {
        return;
      }

      if (state.messages.length === 0) {
        const metadata = extractOpenAIStyleMetadata(event.data);
        state.messages.push({ messageStart: timestamp, events: [], metadata });
      }

      const current = state.messages[state.messages.length - 1];
      if (!current) return;

      current.events.push({ type: 'content_block_delta', timestamp, data: event.data });

      const eventMetadata = extractOpenAIStyleMetadata(event.data, current.metadata);
      current.metadata = { ...current.metadata, ...eventMetadata };

      const extracted = extractOpenAIStyleUsage(event.data, includeCost);
      if (hasUsageData(extracted)) {
        current.usage = { ...current.usage, ...extracted };
      }
      return;
    }

    if (event.data && event.data.trim().length > 0) {
      try {
        JSON.parse(event.data);
      } catch (parseError) {
        console.error('Error parsing SSE event:', {
          error: parseError,
          eventType,
          timestamp,
        });
        return;
      }
    }

    const sseEvent: SSEEvent = { type: eventType, timestamp, data: event.data };

    if (eventType === 'response.created') {
      const metadata = extractOpenAIStyleMetadata(event.data);
      const usage = event.data ? extractOpenAIStyleUsage(event.data, includeCost) : undefined;
      const newMessage: SSEMessage = {
        messageStart: timestamp,
        events: [sseEvent],
        metadata,
        usage: usage && hasUsageData(usage) ? usage : undefined,
      };
      state.messages.push(newMessage);
      return;
    }

    const current = state.messages[state.messages.length - 1];
    if (!current) {
      console.warn('Received SSE event before response.created:', eventType);
      return;
    }

    current.events.push(sseEvent);

    if (event.data) {
      const eventMetadata = extractOpenAIStyleMetadata(event.data, current.metadata);
      current.metadata = { ...current.metadata, ...eventMetadata };
    }

    const isTerminal =
      eventType === 'response.completed' ||
      eventType === 'response.failed' ||
      eventType === 'response.incomplete';

    if (isTerminal) {
      current.messageStop = timestamp;
      if (event.data) {
        const extracted = extractOpenAIStyleUsage(event.data, includeCost);
        const merged: RawTokenUsage = { ...current.usage, ...extracted };
        current.usage = hasUsageData(merged) ? merged : undefined;
      }
    }
  } catch (e) {
    console.error('Error parsing SSE event:', {
      error: e,
      eventType: event.event,
      timestamp,
    });
  }
}

export function parseOpenAIStyleResponseMetadata(
  body: string,
): Partial<LLMResponseMetadata> | undefined {
  const metadata = extractOpenAIStyleMetadata(body);
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

export function aggregateOpenAIStyleSSETokens(
  streamData: SSEStreamData,
  providerId: ProviderId,
): LLMTokenUsage | undefined {
  if (!streamData.messages || streamData.messages.length === 0) return undefined;

  const accumulator = createTokenAccumulator(providerId);
  for (const message of streamData.messages) {
    if (message.usage) accumulator.acceptEvent(message.usage);
  }
  return accumulator.finalize();
}

export function parseOpenAIStyleResponseTokenUsage(
  body: string,
  providerId: ProviderId,
): LLMTokenUsage | undefined {
  return parseTokenUsage(body, providerId);
}
