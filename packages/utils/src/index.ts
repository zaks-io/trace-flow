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
