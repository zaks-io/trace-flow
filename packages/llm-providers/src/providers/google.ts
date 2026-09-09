import type {
  InputMessage,
  InputContentBlock,
  LLMResponseMetadataSummary,
  LLMTokenUsage,
  SSEStreamData,
} from '@trace-flow/types';
import { createTokenAccumulator } from '../accumulator';
import { parseGoogleModelFromPath } from '../googlePath';
import { parseTokenUsage } from '../parseTokenUsage';
import { PROVIDER_SCHEMAS } from '../schemas';
import type { RawTokenUsage } from '../types';
import type { ParsedSSEEvent, Provider } from './types';
import {
  addSSEMessage,
  appendSSEEvent,
  appendSSEMetadata,
  boundedSSEMetadataValue,
  isBoundedSSEEventData,
  reportSSEHandlerFailure,
} from './sse-state';

interface GoogleRequestBody {
  contents?: {
    role?: 'user' | 'model';
    parts: {
      text?: string;
      inlineData?: unknown;
      functionCall?: { id?: string; name: string; args: unknown };
      functionResponse?: { id?: string; name: string; response: unknown };
    }[];
  }[];
  systemInstruction?: {
    parts: { text: string }[];
  };
  tools?: unknown[];
}

function parseGoogleRequestBody(body: string): InputMessage[] | null {
  try {
    const parsed = JSON.parse(body) as GoogleRequestBody;
    if (!parsed.contents || !Array.isArray(parsed.contents)) return null;

    const inputMessages: InputMessage[] = [];
    let messageIndex = 0;

    if (parsed.systemInstruction?.parts) {
      inputMessages.push({
        role: 'system',
        index: messageIndex++,
        contentBlocks: [{ index: 0, type: 'text' }],
      });
    }

    for (const content of parsed.contents) {
      const contentBlocks: InputContentBlock[] = [];
      const role = content.role === 'model' ? 'assistant' : 'user';

      for (let partIndex = 0; partIndex < content.parts.length; partIndex++) {
        const part = content.parts[partIndex];
        if (!part) continue;

        if (part.text !== undefined) {
          contentBlocks.push({ index: partIndex, type: 'text' });
        } else if (part.inlineData) {
          contentBlocks.push({ index: partIndex, type: 'image' });
        } else if (part.functionCall) {
          contentBlocks.push({
            index: partIndex,
            type: 'tool_call',
            toolUseId: part.functionCall.id ?? part.functionCall.name,
            toolName: part.functionCall.name,
          });
        } else if (part.functionResponse) {
          contentBlocks.push({
            index: partIndex,
            type: 'tool_result',
            toolResultId: part.functionResponse.id ?? part.functionResponse.name,
          });
        }
      }

      if (contentBlocks.length > 0) {
        inputMessages.push({ role, index: messageIndex++, contentBlocks });
      }
    }

    return inputMessages.length > 0 ? inputMessages : null;
  } catch {
    return null;
  }
}

const RESPONSE_ID_PATTERN = /"responseId"\s*:\s*"([^"]{1,256})"/;
const MODEL_VERSION_PATTERN = /"modelVersion"\s*:\s*"([^"]{1,256})"/;
const FINISH_REASON_PATTERN = /"finishReason"\s*:\s*"([^"]{1,256})"/;

const PROMPT_TOKEN_COUNT_PATTERN = /"promptTokenCount"\s*:\s*(\d{1,20})(?!\d)/;
const CANDIDATES_TOKEN_COUNT_PATTERN = /"candidatesTokenCount"\s*:\s*(\d{1,20})(?!\d)/;
const CACHED_CONTENT_TOKEN_COUNT_PATTERN = /"cachedContentTokenCount"\s*:\s*(\d{1,20})(?!\d)/;
const TOTAL_TOKEN_COUNT_PATTERN = /"totalTokenCount"\s*:\s*(\d{1,20})(?!\d)/;
const THOUGHTS_TOKEN_COUNT_PATTERN = /"thoughtsTokenCount"\s*:\s*(\d{1,20})(?!\d)/;

function extractMetadata(
  data: string,
  existing: LLMResponseMetadataSummary = {},
): LLMResponseMetadataSummary {
  const metadata: LLMResponseMetadataSummary = { ...existing };

  const responseIdMatch = RESPONSE_ID_PATTERN.exec(data);
  const responseId = boundedSSEMetadataValue(responseIdMatch?.[1]);
  if (responseId && !metadata.id) metadata.id = responseId;

  const modelVersionMatch = MODEL_VERSION_PATTERN.exec(data);
  const modelVersion = boundedSSEMetadataValue(modelVersionMatch?.[1]);
  if (modelVersion && !metadata.model) metadata.model = modelVersion;

  const finishReasonMatch = FINISH_REASON_PATTERN.exec(data);
  const finishReason = boundedSSEMetadataValue(finishReasonMatch?.[1]);
  if (finishReason) metadata.finishReason = finishReason;

  return metadata;
}

function extractUsage(data: string): RawTokenUsage {
  const usage: RawTokenUsage = {};

  const promptMatch = PROMPT_TOKEN_COUNT_PATTERN.exec(data);
  if (promptMatch?.[1]) usage.prompt_token_count = parseInt(promptMatch[1], 10);

  const candidatesMatch = CANDIDATES_TOKEN_COUNT_PATTERN.exec(data);
  if (candidatesMatch?.[1]) usage.candidates_token_count = parseInt(candidatesMatch[1], 10);

  const cachedMatch = CACHED_CONTENT_TOKEN_COUNT_PATTERN.exec(data);
  if (cachedMatch?.[1]) usage.cached_content_token_count = parseInt(cachedMatch[1], 10);

  const totalMatch = TOTAL_TOKEN_COUNT_PATTERN.exec(data);
  if (totalMatch?.[1]) usage.total_token_count = parseInt(totalMatch[1], 10);

  const thoughtsMatch = THOUGHTS_TOKEN_COUNT_PATTERN.exec(data);
  if (thoughtsMatch?.[1]) usage.thoughts_token_count = parseInt(thoughtsMatch[1], 10);

  return usage;
}

function hasUsageData(usage: RawTokenUsage): boolean {
  return (
    usage.prompt_token_count !== undefined ||
    usage.candidates_token_count !== undefined ||
    usage.cached_content_token_count !== undefined ||
    usage.total_token_count !== undefined ||
    usage.thoughts_token_count !== undefined
  );
}

/**
 * Google's streaming Gemini API uses the OpenAI SSE shape (no event type, just
 * JSON data lines) but ships cumulative usageMetadata in every chunk — the
 * final chunk has the totals. There's no `[DONE]` terminator, so the message
 * stop timestamp is stamped by `drainCapture` after the stream drains.
 */
function handleSSEEvent(event: ParsedSSEEvent, timestamp: number, state: SSEStreamData): void {
  try {
    if (event.event) return;
    if (!event.data || event.data.trim().length === 0) return;

    if (isBoundedSSEEventData(event.data)) {
      try {
        JSON.parse(event.data);
      } catch {
        return;
      }
    }

    if (state.messages.length === 0) {
      const metadata = extractMetadata(event.data);
      addSSEMessage(state, { messageStart: timestamp, events: [], metadata });
    }

    const current = state.messages[state.messages.length - 1];
    if (!current) return;

    appendSSEEvent(current, 'content_block_delta', timestamp);

    const eventMetadata = extractMetadata(event.data, current.metadata);
    appendSSEMetadata(current, eventMetadata);

    const extracted = extractUsage(event.data);
    if (hasUsageData(extracted)) {
      current.usage = { ...current.usage, ...extracted };
    }
  } catch {
    reportSSEHandlerFailure(state);
  }
}

function aggregateSSETokens(streamData: SSEStreamData): LLMTokenUsage | undefined {
  if (!streamData.messages || streamData.messages.length === 0) return undefined;

  const accumulator = createTokenAccumulator('google');
  for (const message of streamData.messages) {
    if (message.usage) accumulator.acceptEvent(message.usage);
  }
  return accumulator.finalize();
}

/**
 * Gemini's `embedContent` and `batchEmbedContents` responses don't include
 * `modelVersion` in the body — only the URL path carries the model. The
 * adapter falls back to path parsing when the body extract comes up empty so
 * traces don't show 'unknown' for embeddings.
 */
function modelFromTargetUrl(targetUrl: string): string | undefined {
  try {
    const { pathname } = new URL(targetUrl);
    return parseGoogleModelFromPath(pathname);
  } catch {
    return undefined;
  }
}

export const google: Provider = {
  id: 'google',
  baseUrl: 'https://generativelanguage.googleapis.com',
  tokenSchema: PROVIDER_SCHEMAS.google,

  parseRequestBody: parseGoogleRequestBody,
  parseResponseMetadata: (body, ctx) => {
    const metadata = extractMetadata(body);
    if (!metadata.model && ctx?.targetUrl) {
      const pathModel = modelFromTargetUrl(ctx.targetUrl);
      if (pathModel) metadata.model = pathModel;
    }
    return Object.keys(metadata).length > 0 ? metadata : undefined;
  },
  parseResponseTokenUsage: (body) => parseTokenUsage(body, 'google'),

  handleSSEEvent,
  aggregateSSETokens,
};
