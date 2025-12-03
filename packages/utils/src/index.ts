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
  let currentEvent: Partial<ParsedSSEEvent> = {};

  const lines = body.split('\n');

  for (const line of lines) {
    if (line.trim() === '') {
      if (currentEvent.data !== undefined) {
        events.push({
          event: currentEvent.event ?? null,
          data: currentEvent.data,
          id: currentEvent.id,
        });
        currentEvent = {};
      }
      continue;
    }

    const colonIndex = line.indexOf(':');
    if (colonIndex === -1) continue;

    const field = line.slice(0, colonIndex).trim();
    const value = line.slice(colonIndex + 1).trim();

    if (field === 'event') {
      currentEvent.event = value;
    } else if (field === 'data') {
      currentEvent.data = value;
    } else if (field === 'id') {
      currentEvent.id = value;
    }
  }

  if (currentEvent.data !== undefined) {
    events.push({
      event: currentEvent.event ?? null,
      data: currentEvent.data,
      id: currentEvent.id,
    });
  }

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
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
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

    if (parsed.id && !result.id) {
      result.id = parsed.id as string;
    }
    if (parsed.created && !result.created) {
      result.created = parsed.created as number;
    }
    if (parsed.model && !result.model) {
      result.model = parsed.model as string;
    }
    if (parsed.usage) {
      result.usage = parsed.usage as MergedSSEResponse['usage'];
    }

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

    if (!choices) continue;

    for (const choice of choices) {
      const index = choice.index ?? 0;
      const delta = choice.delta;

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

      if (delta?.role) {
        choiceData.role = delta.role;
      }
      if (delta?.content) {
        choiceData.content += delta.content;
      }
      if (choice.finish_reason) {
        choiceData.finish_reason = choice.finish_reason;
      }

      if (delta?.tool_calls) {
        for (const toolCall of delta.tool_calls) {
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
