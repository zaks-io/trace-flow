import type {
  InputMessage,
  InputContentBlock,
  LLMResponseMetadata,
  LLMTokenUsage,
  SSEStreamData,
} from '@trace-flow/types';
import { createTokenAccumulator } from '../accumulator';
import { parseGoogleModelFromPath } from '../googlePath';
import { parseTokenUsage } from '../parseTokenUsage';
import { PROVIDER_SCHEMAS } from '../schemas';
import type { RawTokenUsage } from '../types';
import type { ParsedSSEEvent, Provider } from './types';

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

const RESPONSE_ID_PATTERN = /"responseId"\s*:\s*"([^"]+)"/;
const MODEL_VERSION_PATTERN = /"modelVersion"\s*:\s*"([^"]+)"/;
const FINISH_REASON_PATTERN = /"finishReason"\s*:\s*"([^"]+)"/;

const PROMPT_TOKEN_COUNT_PATTERN = /"promptTokenCount"\s*:\s*(\d+)/;
const CANDIDATES_TOKEN_COUNT_PATTERN = /"candidatesTokenCount"\s*:\s*(\d+)/;
const CACHED_CONTENT_TOKEN_COUNT_PATTERN = /"cachedContentTokenCount"\s*:\s*(\d+)/;
const TOTAL_TOKEN_COUNT_PATTERN = /"totalTokenCount"\s*:\s*(\d+)/;
const THOUGHTS_TOKEN_COUNT_PATTERN = /"thoughtsTokenCount"\s*:\s*(\d+)/;

function extractMetadata(
  data: string,
  existing: Partial<LLMResponseMetadata> = {},
): Partial<LLMResponseMetadata> {
  const metadata: Partial<LLMResponseMetadata> = { ...existing };

  const responseIdMatch = RESPONSE_ID_PATTERN.exec(data);
  if (responseIdMatch && !metadata.id) metadata.id = responseIdMatch[1];

  const modelVersionMatch = MODEL_VERSION_PATTERN.exec(data);
  if (modelVersionMatch && !metadata.model) metadata.model = modelVersionMatch[1];

  const finishReasonMatch = FINISH_REASON_PATTERN.exec(data);
  if (finishReasonMatch && !metadata.finishReason) metadata.finishReason = finishReasonMatch[1];

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
 * stop timestamp is set by capture.ts after the stream drains.
 */
function handleSSEEvent(event: ParsedSSEEvent, timestamp: number, state: SSEStreamData): void {
  try {
    if (event.event) return;
    if (!event.data || event.data.trim().length === 0) return;

    try {
      JSON.parse(event.data);
    } catch {
      return;
    }

    if (state.messages.length === 0) {
      const metadata = extractMetadata(event.data);
      state.messages.push({ messageStart: timestamp, events: [], metadata });
    }

    const current = state.messages[state.messages.length - 1];
    if (!current) return;

    current.events.push({ type: 'content_block_delta', timestamp, data: event.data });

    const eventMetadata = extractMetadata(event.data, current.metadata);
    current.metadata = { ...current.metadata, ...eventMetadata };

    const extracted = extractUsage(event.data);
    if (hasUsageData(extracted)) {
      current.usage = { ...current.usage, ...extracted };
    }
  } catch (e) {
    console.error('Error parsing SSE event:', {
      error: e,
      eventType: event.event,
      timestamp,
    });
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

export const google: Provider = {
  id: 'google',
  baseUrl: 'https://generativelanguage.googleapis.com',
  tokenSchema: PROVIDER_SCHEMAS.google,

  parseRequestBody: parseGoogleRequestBody,
  parseResponseMetadata: (body) => {
    const metadata = extractMetadata(body);
    return Object.keys(metadata).length > 0 ? metadata : undefined;
  },
  parseResponseTokenUsage: (body) => parseTokenUsage(body, 'google'),

  handleSSEEvent,
  aggregateSSETokens,

  resolveModelFromUrl: (targetUrl) => {
    try {
      const { pathname } = new URL(targetUrl);
      return parseGoogleModelFromPath(pathname);
    } catch {
      return undefined;
    }
  },
};
