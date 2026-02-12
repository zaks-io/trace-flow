import { createParser } from 'eventsource-parser';

export function generateId(): string {
  return crypto.randomUUID();
}

export function getCurrentTimestamp(): number {
  return Date.now();
}

export function extractProviderFromUrl(url: string): string {
  try {
    const hostname = new URL(url).hostname.toLowerCase();

    if (hostname.includes('openai.com')) return 'openai';
    if (hostname.includes('anthropic.com')) return 'anthropic';
    if (hostname.includes('openrouter.ai')) return 'openrouter';
    if (hostname.includes('groq.com')) return 'groq';
    if (hostname.includes('generativelanguage.googleapis.com')) return 'google';
    if (hostname.includes('api.mistral.ai')) return 'mistral';
    if (hostname.includes('api.cohere.ai')) return 'cohere';
    if (hostname.includes('api.perplexity.ai')) return 'perplexity';

    return hostname;
  } catch {
    return 'unknown';
  }
}

/**
 * Derives the gen_ai.operation.name from the API endpoint path.
 * Per OpenTelemetry GenAI semantic conventions:
 * https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-spans/
 */
export function deriveOperationName(path: string): string {
  const normalizedPath = path.toLowerCase();

  // OpenAI / Groq / OpenRouter patterns
  if (normalizedPath.includes('/chat/completions')) return 'chat';
  if (normalizedPath.includes('/completions') && !normalizedPath.includes('/chat/'))
    return 'text_completion';
  if (normalizedPath.includes('/embeddings')) return 'embeddings';

  // Anthropic patterns
  if (normalizedPath.includes('/messages')) return 'chat';

  // Google Gemini patterns
  if (normalizedPath.includes(':generatecontent')) return 'generate_content';
  if (normalizedPath.includes(':embedcontent')) return 'embeddings';

  return 'chat';
}

export function generateSpanId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function generateTraceId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function validateTraceId(traceId: string | null | undefined): string | null {
  if (!traceId) return null;
  const normalized = traceId.toLowerCase();
  return /^[0-9a-f]{32}$/.test(normalized) ? normalized : null;
}

export function validateSpanId(spanId: string | null | undefined): string | null {
  if (!spanId) return null;
  const normalized = spanId.toLowerCase();
  return /^[0-9a-f]{16}$/.test(normalized) ? normalized : null;
}

// W3C Trace Context types and utilities
// https://www.w3.org/TR/trace-context/

export interface TraceparentData {
  version: string;
  traceId: string;
  parentId: string;
  flags: number;
}

const TRACEPARENT_REGEX = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

export function parseTraceparent(header: string | null | undefined): TraceparentData | null {
  if (!header) return null;

  const match = TRACEPARENT_REGEX.exec(header.toLowerCase());
  if (!match) return null;

  // Regex guarantees all 4 capture groups exist when matched
  const version = match[1]!;
  const traceId = match[2]!;
  const parentId = match[3]!;
  const flags = match[4]!;

  // Reject invalid all-zero trace-id or parent-id per spec
  if (traceId === '00000000000000000000000000000000') return null;
  if (parentId === '0000000000000000') return null;

  return {
    version,
    traceId,
    parentId,
    flags: parseInt(flags, 16),
  };
}

export function formatTraceparent(traceId: string, parentId: string, flags = 0x01): string {
  const version = '00';
  const flagsHex = flags.toString(16).padStart(2, '0');
  return `${version}-${traceId.toLowerCase()}-${parentId.toLowerCase()}-${flagsHex}`;
}

// W3C Baggage utilities
// https://www.w3.org/TR/baggage/

export function parseBaggage(header: string | null | undefined): Record<string, string> {
  if (!header) return {};

  const result: Record<string, string> = {};

  for (const item of header.split(',')) {
    const trimmed = item.trim();
    if (!trimmed) continue;

    // Split on first '=' only, value may contain '='
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;

    const key = trimmed.slice(0, eqIndex).trim();
    const value = trimmed.slice(eqIndex + 1).trim();

    if (key) {
      // Decode percent-encoded values per spec
      try {
        result[key] = decodeURIComponent(value);
      } catch {
        result[key] = value;
      }
    }
  }

  return result;
}

export function formatBaggage(entries: Record<string, string>): string {
  return Object.entries(entries)
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join(',');
}

/**
 * Safely parses span attributes from either a JSON string (database) or
 * an already-parsed object (Tinybird API) into a string record.
 */
export function parseSpanAttributes(
  attributes: string | Record<string, string>,
): Record<string, string> {
  try {
    return typeof attributes === 'string'
      ? (JSON.parse(attributes) as Record<string, string>)
      : attributes;
  } catch {
    return {};
  }
}

export function hashString(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash + char) | 0;
  }
  return Math.abs(hash);
}

export type BodyFormat = 'json' | 'sse' | 'text';

export interface ParsedSSEEvent {
  event: string | null;
  data: string;
  id?: string;
}

export interface FormattedBody {
  format: BodyFormat;
  content: string | object | ParsedSSEEvent[];
  raw: string;
}

function detectBodyFormat(body: string): BodyFormat {
  const trimmed = body?.trim();

  if (!trimmed?.length) {
    return 'text';
  }

  if (
    (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']'))
  ) {
    try {
      JSON.parse(trimmed);
      return 'json';
    } catch {
      // Not valid JSON, continue checking
    }
  }

  if (trimmed.includes('event:') || trimmed.includes('data:')) {
    return 'sse';
  }

  return 'text';
}

function parseSSE(body: string): ParsedSSEEvent[] {
  const events: ParsedSSEEvent[] = [];
  const parser = createParser({
    onEvent(event) {
      events.push({
        event: event.event ?? null,
        data: event.data,
        id: event.id,
      });
    },
  });
  parser.feed(body);
  return events;
}

export function formatBodyForDisplay(body: string | null): FormattedBody | null {
  if (body === null || body === undefined) {
    return null;
  }

  const format = detectBodyFormat(body);

  switch (format) {
    case 'json':
      try {
        const parsed = JSON.parse(body) as object;
        return {
          format: 'json',
          content: parsed,
          raw: body,
        };
      } catch {
        return {
          format: 'text',
          content: body,
          raw: body,
        };
      }

    case 'sse':
      try {
        const events = parseSSE(body);
        return {
          format: 'sse',
          content: events,
          raw: body,
        };
      } catch {
        return {
          format: 'text',
          content: body,
          raw: body,
        };
      }

    case 'text':
    default:
      return {
        format: 'text',
        content: body,
        raw: body,
      };
  }
}

export interface MergedSSEResponse {
  id: string | null;
  object: string | null;
  created: number | null;
  model: string | null;
  choices: {
    index: number;
    message: {
      role: string;
      content: string;
      tool_calls?: {
        id: string;
        type: string;
        function: {
          name: string;
          arguments: string;
        };
      }[];
    };
    finish_reason: string | null;
  }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

export function mergeSSEEvents(events: ParsedSSEEvent[]): MergedSSEResponse {
  const result: MergedSSEResponse = {
    id: null,
    object: 'chat.completion',
    created: null,
    model: null,
    choices: [],
  };

  const choicesMap = new Map<
    number,
    {
      index: number;
      role: string;
      content: string;
      tool_calls: Map<
        number,
        {
          id: string;
          type: string;
          function: { name: string; arguments: string };
        }
      >;
      finish_reason: string | null;
    }
  >();

  for (const event of events) {
    if (event.event === 'done' || event.data === '[DONE]') {
      continue;
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(event.data) as Record<string, unknown>;
    } catch {
      continue;
    }

    // Extract metadata from top-level (OpenAI) or message object (Anthropic)
    const message = parsed.message as Record<string, unknown> | undefined;
    if (parsed.id && !result.id) {
      result.id = parsed.id as string;
    } else if (message?.id && !result.id) {
      result.id = message.id as string;
    }
    if (parsed.created && !result.created) {
      result.created = parsed.created as number;
    }
    if (parsed.model && !result.model) {
      result.model = parsed.model as string;
    } else if (message?.model && !result.model) {
      result.model = message.model as string;
    }

    // Merge usage from any event that has it
    if (parsed.usage) {
      result.usage = { ...result.usage, ...(parsed.usage as MergedSSEResponse['usage']) };
    }
    if (message?.usage) {
      result.usage = { ...result.usage, ...(message.usage as MergedSSEResponse['usage']) };
    }

    // Extract stop_reason from delta (Anthropic message_delta)
    const delta = parsed.delta as Record<string, unknown> | undefined;
    if (delta?.stop_reason && choicesMap.size > 0) {
      const firstChoice = choicesMap.get(0);
      if (firstChoice) {
        firstChoice.finish_reason = delta.stop_reason as string;
      }
    }

    // Handle Anthropic content_block_delta: delta.text
    if (delta?.text) {
      const index = (parsed.index as number) ?? 0;
      if (!choicesMap.has(index)) {
        choicesMap.set(index, {
          index,
          role: 'assistant',
          content: '',
          tool_calls: new Map(),
          finish_reason: null,
        });
      }
      choicesMap.get(index)!.content += delta.text as string;
    }

    // Handle OpenAI format: choices[].delta
    const choices = parsed.choices as
      | {
          index?: number;
          delta?: {
            role?: string;
            content?: string;
            tool_calls?: {
              index?: number;
              id?: string;
              type?: string;
              function?: { name?: string; arguments?: string };
            }[];
          };
          finish_reason?: string;
        }[]
      | undefined;

    if (choices) {
      for (const choice of choices) {
        const index = choice.index ?? 0;
        const choiceDelta = choice.delta;

        if (!choicesMap.has(index)) {
          choicesMap.set(index, {
            index,
            role: '',
            content: '',
            tool_calls: new Map(),
            finish_reason: null,
          });
        }

        const choiceData = choicesMap.get(index)!;

        if (choiceDelta?.role) {
          choiceData.role = choiceDelta.role;
        }
        if (choiceDelta?.content) {
          choiceData.content += choiceDelta.content;
        }
        if (choice.finish_reason) {
          choiceData.finish_reason = choice.finish_reason;
        }

        if (choiceDelta?.tool_calls) {
          for (const toolCall of choiceDelta.tool_calls) {
            const toolIndex = toolCall.index ?? 0;
            if (!choiceData.tool_calls.has(toolIndex)) {
              choiceData.tool_calls.set(toolIndex, {
                id: '',
                type: 'function',
                function: { name: '', arguments: '' },
              });
            }
            const existingTool = choiceData.tool_calls.get(toolIndex)!;
            if (toolCall.id) existingTool.id = toolCall.id;
            if (toolCall.type) existingTool.type = toolCall.type;
            if (toolCall.function?.name) existingTool.function.name += toolCall.function.name;
            if (toolCall.function?.arguments)
              existingTool.function.arguments += toolCall.function.arguments;
          }
        }
      }
    }
  }

  result.choices = Array.from(choicesMap.values())
    .sort((a, b) => a.index - b.index)
    .map((choice) => ({
      index: choice.index,
      message: {
        role: choice.role || 'assistant',
        content: choice.content,
        ...(choice.tool_calls.size > 0 && {
          tool_calls: Array.from(choice.tool_calls.values()).sort(
            (a, b) => parseInt(a.id || '0') - parseInt(b.id || '0'),
          ),
        }),
      },
      finish_reason: choice.finish_reason,
    }));

  if (result.choices.length === 0) {
    result.choices.push({
      index: 0,
      message: { role: 'assistant', content: '' },
      finish_reason: null,
    });
  }

  return result;
}

export function computePeriod(now: Date): { periodStart: number; periodEnd: number } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { periodStart: start.getTime(), periodEnd: end.getTime() };
}

// Token estimation utilities for message breakdown

/**
 * Estimate token count using character count heuristic.
 * ~4 characters per token for English text is a reasonable approximation.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

export interface ParsedMessage {
  index: number;
  role: string;
  content: string;
  contentPreview: string;
  estimatedTokens: number;
  isImage?: boolean;
  isToolCall?: boolean;
  isToolResult?: boolean;
  toolName?: string;
}

export interface MessageBreakdownData {
  messages: ParsedMessage[];
  totalEstimatedTokens: number;
  provider: string;
}

/**
 * Extracts text content from a message content field.
 * Handles various formats:
 * - Simple string
 * - Array of content blocks (Anthropic multimodal: text, image, tool_use, tool_result)
 */
function extractTextFromContent(content: unknown): {
  text: string;
  textForTokenCount: string;
  isImage: boolean;
  isToolCall: boolean;
  isToolResult: boolean;
  toolName?: string;
} {
  if (typeof content === 'string') {
    return {
      text: content,
      textForTokenCount: content,
      isImage: false,
      isToolCall: false,
      isToolResult: false,
    };
  }

  if (Array.isArray(content)) {
    const displayParts: string[] = [];
    const tokenParts: string[] = [];
    let hasImage = false;
    let hasToolCall = false;
    let hasToolResult = false;
    let toolName: string | undefined;

    for (const block of content) {
      if (typeof block === 'string') {
        displayParts.push(block);
        tokenParts.push(block);
        continue;
      }
      if (typeof block !== 'object' || block === null) {
        continue;
      }

      const typedBlock = block as {
        type?: string;
        text?: string;
        name?: string;
        content?: unknown;
        input?: unknown;
      };

      if (typedBlock.type === 'text' && typeof typedBlock.text === 'string') {
        displayParts.push(typedBlock.text);
        tokenParts.push(typedBlock.text);
      } else if (typedBlock.type === 'image' || typedBlock.type === 'image_url') {
        hasImage = true;
        displayParts.push('[Image]');
        // Don't add to tokenParts - images don't count towards text tokens
      } else if (typedBlock.type === 'tool_use') {
        hasToolCall = true;
        toolName = typedBlock.name;
        const toolText = `[Tool: ${typedBlock.name ?? 'unknown'}]`;
        displayParts.push(toolText);
        tokenParts.push(toolText);
        if (typedBlock.input) {
          const inputStr = JSON.stringify(typedBlock.input);
          displayParts.push(inputStr);
          tokenParts.push(inputStr);
        }
      } else if (typedBlock.type === 'tool_result') {
        hasToolResult = true;
        if (typeof typedBlock.content === 'string') {
          displayParts.push(typedBlock.content);
          tokenParts.push(typedBlock.content);
        } else if (typedBlock.content) {
          const contentStr = JSON.stringify(typedBlock.content);
          displayParts.push(contentStr);
          tokenParts.push(contentStr);
        }
      }
    }

    return {
      text: displayParts.join('\n'),
      textForTokenCount: tokenParts.join('\n'),
      isImage: hasImage,
      isToolCall: hasToolCall,
      isToolResult: hasToolResult,
      toolName,
    };
  }

  const jsonStr = JSON.stringify(content);
  return {
    text: jsonStr,
    textForTokenCount: jsonStr,
    isImage: false,
    isToolCall: false,
    isToolResult: false,
  };
}

/**
 * Creates a preview of the content (first 150 chars with ellipsis if truncated)
 */
function createPreview(text: string, maxLength = 150): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}...`;
}

/**
 * Parse messages from an LLM API request body.
 * Supports OpenAI, Anthropic, Groq, and OpenRouter formats.
 */
export function parseMessagesFromBody(
  body: unknown,
  provider: string,
): MessageBreakdownData | null {
  if (!body || typeof body !== 'object') {
    return null;
  }

  const messages: ParsedMessage[] = [];

  // Handle Anthropic format: system is a separate field
  if (provider === 'anthropic') {
    const anthropicBody = body as {
      system?: string | { type: string; text?: string }[];
      messages?: { role: string; content: unknown }[];
    };

    // Add system message if present
    if (anthropicBody.system) {
      let systemText: string;
      if (typeof anthropicBody.system === 'string') {
        systemText = anthropicBody.system;
      } else if (Array.isArray(anthropicBody.system)) {
        systemText = anthropicBody.system.map((b) => b.text ?? '').join('\n');
      } else {
        systemText = JSON.stringify(anthropicBody.system);
      }

      const estimatedTokens = estimateTokens(systemText);
      messages.push({
        index: 0,
        role: 'system',
        content: systemText,
        contentPreview: createPreview(systemText),
        estimatedTokens,
      });
    }

    // Add messages
    if (anthropicBody.messages && Array.isArray(anthropicBody.messages)) {
      for (const msg of anthropicBody.messages) {
        if (!msg) continue;

        const { text, textForTokenCount, isImage, isToolCall, isToolResult, toolName } =
          extractTextFromContent(msg.content);
        const estimatedTokens = estimateTokens(textForTokenCount);

        // Determine display role: Anthropic uses role "user" for tool_result content blocks
        // We want to show these as "tool_result" for clarity
        let displayRole = msg.role;
        if (isToolResult && msg.role === 'user') {
          displayRole = 'tool_result';
        }

        messages.push({
          index: messages.length,
          role: displayRole,
          content: text,
          contentPreview: createPreview(text),
          estimatedTokens,
          isImage,
          isToolCall,
          isToolResult,
          toolName,
        });
      }
    }
  } else {
    // OpenAI, Groq, OpenRouter format: all messages in messages array
    const openaiBody = body as {
      messages?: { role: string; content: unknown; name?: string; tool_calls?: unknown[] }[];
    };

    if (!openaiBody.messages || !Array.isArray(openaiBody.messages)) {
      return null;
    }

    for (const msg of openaiBody.messages) {
      if (!msg) continue;

      const { text, textForTokenCount, isImage, isToolCall, isToolResult, toolName } =
        extractTextFromContent(msg.content);
      const estimatedTokens = estimateTokens(textForTokenCount);

      // Check for tool_calls in the message (OpenAI assistant messages can have tool_calls array)
      const hasToolCalls =
        msg.tool_calls && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0;

      // OpenAI uses role "tool" for tool results, so no role override needed
      messages.push({
        index: messages.length,
        role: msg.role,
        content: text,
        contentPreview: createPreview(text),
        estimatedTokens,
        isImage,
        isToolCall: isToolCall || hasToolCalls,
        isToolResult: isToolResult || msg.role === 'tool',
        toolName,
      });
    }
  }

  if (messages.length === 0) {
    return null;
  }

  const totalEstimatedTokens = messages.reduce((sum, m) => sum + m.estimatedTokens, 0);

  return {
    messages,
    totalEstimatedTokens,
    provider,
  };
}

/**
 * Parse the response body from an LLM API response.
 * Extracts the assistant's message(s) from OpenAI or Anthropic format.
 */
export function parseResponseBody(body: unknown, provider: string): MessageBreakdownData | null {
  if (!body || typeof body !== 'object') {
    return null;
  }

  const messages: ParsedMessage[] = [];

  if (provider === 'anthropic') {
    // Anthropic format: { content: [...], role: "assistant", ... }
    const anthropicResponse = body as {
      content?: unknown[];
      role?: string;
      stop_reason?: string;
    };

    if (anthropicResponse.content && Array.isArray(anthropicResponse.content)) {
      const { text, textForTokenCount, isImage, isToolCall, toolName } = extractTextFromContent(
        anthropicResponse.content,
      );
      const estimatedTokens = estimateTokens(textForTokenCount);

      messages.push({
        index: 0,
        role: anthropicResponse.role ?? 'assistant',
        content: text,
        contentPreview: createPreview(text),
        estimatedTokens,
        isImage,
        isToolCall,
        toolName,
      });
    }
  } else {
    // OpenAI format: { choices: [{ message: { role, content }, ... }], ... }
    const openaiResponse = body as {
      choices?: {
        message?: {
          role?: string;
          content?: string | null;
          tool_calls?: { function?: { name?: string; arguments?: string } }[];
        };
        index?: number;
      }[];
    };

    if (openaiResponse.choices && Array.isArray(openaiResponse.choices)) {
      for (const choice of openaiResponse.choices) {
        if (!choice.message) continue;

        const msg = choice.message;
        let content = msg.content ?? '';
        let isToolCall = false;
        let toolName: string | undefined;

        // Handle tool calls in response
        if (msg.tool_calls && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
          isToolCall = true;
          const toolParts: string[] = [];
          if (content) toolParts.push(content);

          for (const tc of msg.tool_calls) {
            const name = tc.function?.name ?? 'unknown';
            toolName = toolName ?? name;
            toolParts.push(`[Tool: ${name}]`);
            if (tc.function?.arguments) {
              toolParts.push(tc.function.arguments);
            }
          }
          content = toolParts.join('\n');
        }

        const estimatedTokens = estimateTokens(content);

        messages.push({
          index: choice.index ?? messages.length,
          role: msg.role ?? 'assistant',
          content,
          contentPreview: createPreview(content),
          estimatedTokens,
          isToolCall,
          toolName,
        });
      }
    }
  }

  if (messages.length === 0) {
    return null;
  }

  const totalEstimatedTokens = messages.reduce((sum, m) => sum + m.estimatedTokens, 0);

  return {
    messages,
    totalEstimatedTokens,
    provider,
  };
}
