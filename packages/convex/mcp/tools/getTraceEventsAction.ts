import type { ToolCallResult } from '../protocol';
import {
  jsonReplacer,
  stripNulls,
  queryTinybirdPipe,
  noApiKeysError,
  invalidTraceIdError,
  generateTinybirdToken,
  TRACE_ID_PATTERN,
  splitPatterns,
} from './shared';

const DEFAULT_EVENT_LIMIT = 20;
const MAX_EVENT_LIMIT = 100;

export interface EventRow {
  TraceId: string;
  SpanId: string;
  SpanName: string;
  event_name: string;
  event_timestamp: number;
  event_attributes: string;
  total_count: number;
}

interface FormattedEvent {
  span_id: string;
  span_name: string;
  event_name: string;
  timestamp: string;
  attributes: Record<string, string>;
}

const SAFE_EVENT_ATTRIBUTE_KEYS = new Set([
  'gen_ai.content.type',
  'gen_ai.message.index',
  'gen_ai.message.role',
  'gen_ai.response.streaming',
  'gen_ai.server.time_to_first_token',
  'gen_ai.tool.id',
  'gen_ai.tool.name',
]);

function sanitizeEventAttributes(attributes: Record<string, unknown>): Record<string, string> {
  const sanitized: Record<string, string> = {};

  for (const [key, value] of Object.entries(attributes)) {
    if (!SAFE_EVENT_ATTRIBUTE_KEYS.has(key) || value == null) {
      continue;
    }

    sanitized[key] =
      typeof value === 'string'
        ? value
        : typeof value === 'number' || typeof value === 'boolean'
          ? String(value)
          : JSON.stringify(value);
  }

  return sanitized;
}

export function formatEventRow(row: EventRow): FormattedEvent {
  let attributes: Record<string, unknown> = {};
  try {
    attributes = JSON.parse(row.event_attributes) as Record<string, unknown>;
  } catch {
    attributes = {};
  }

  return {
    span_id: row.SpanId,
    span_name: row.SpanName,
    event_name: row.event_name,
    timestamp: new Date(row.event_timestamp / 1_000_000).toISOString(),
    attributes: sanitizeEventAttributes(attributes),
  };
}

interface GetTraceEventsParams {
  trace_id: string;
  span_id?: string;
  span_names?: string[];
  event_names?: string[];
  order?: string;
  limit?: number;
  cursor?: string;
}

export async function getTraceEvents(
  apiKeys: string[],
  params: GetTraceEventsParams,
): Promise<ToolCallResult> {
  if (apiKeys.length === 0) {
    return noApiKeysError();
  }

  if (!TRACE_ID_PATTERN.test(params.trace_id)) {
    return invalidTraceIdError();
  }

  const token = await generateTinybirdToken(
    [{ type: 'PIPES:READ', resource: 'mcp_trace_events' }],
    apiKeys,
  );

  const limit = Math.min(params.limit ?? DEFAULT_EVENT_LIMIT, MAX_EVENT_LIMIT);
  const offset = params.cursor ? parseInt(params.cursor, 10) || 0 : 0;

  const pipeParams: Record<string, string | number | undefined> = {
    trace_id: params.trace_id,
    limit,
    offset,
  };

  if (params.span_id) {
    pipeParams.span_id = params.span_id;
  }

  if (params.span_names && params.span_names.length > 0) {
    const { exact, prefixes } = splitPatterns(params.span_names);
    if (exact.length > 0) pipeParams.span_names = exact.join(',');
    if (prefixes.length > 0) pipeParams.span_name_prefixes = prefixes.join(',');
  }

  if (params.event_names && params.event_names.length > 0) {
    pipeParams.event_names = params.event_names.join(',');
  }

  if (params.order) {
    pipeParams.order = params.order;
  }

  const data = await queryTinybirdPipe(token, 'mcp_trace_events', pipeParams);

  const totalCount = data.length > 0 ? (data[0] as unknown as EventRow).total_count : 0;
  const hasMore = totalCount > offset + data.length;
  const formattedEvents = data.map((row) => formatEventRow(row as unknown as EventRow));

  const result = {
    trace_id: params.trace_id,
    events: formattedEvents,
    pagination: {
      has_more: hasMore,
      next_cursor: hasMore ? String(offset + limit) : undefined,
    },
  };

  return {
    content: [{ type: 'text', text: JSON.stringify(stripNulls(result), jsonReplacer) }],
  };
}
