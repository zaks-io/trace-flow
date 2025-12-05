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
    if (hostname.includes('generativelanguage.googleapis.com')) return 'google';
    if (hostname.includes('api.mistral.ai')) return 'mistral';
    if (hostname.includes('api.cohere.ai')) return 'cohere';
    if (hostname.includes('api.perplexity.ai')) return 'perplexity';

    return hostname;
  } catch {
    return 'unknown';
  }
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
