import { internalAction } from '../_generated/server';
import { internal } from '../_generated/api';
import { v } from 'convex/values';
import type { ToolDefinition, ToolCallResult } from './protocol';

const TRACE_ID_PATTERN = /^[a-f0-9]{32}$/i;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 25;
const DEFAULT_HOURS = 24;
const MAX_HOURS = 168;

function escapeSQL(value: string): string {
  return value.replace(/'/g, "''");
}

function buildApiKeyFilter(apiKeys: string[]): string {
  if (apiKeys.length === 0) return '';
  const escaped = apiKeys.map((k) => `'${escapeSQL(k)}'`).join(', ');
  return `ApiKey IN (${escaped})`;
}

interface TinybirdResponse {
  data?: Record<string, unknown>[];
}

async function queryTinybird(token: string, sql: string): Promise<Record<string, unknown>[]> {
  const apiUrl = process.env.TINYBIRD_API_URL ?? 'https://api.tinybird.co';
  const url = new URL(`${apiUrl}/v0/sql`);
  url.searchParams.set('q', sql);

  const response = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`TinyBird query failed: ${response.status} - ${text}`);
  }

  const result: TinybirdResponse = await response.json();
  return result.data ?? [];
}

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'list_traces',
    description:
      'List recent LLM traces with optional filtering by provider, model, or status. Returns paginated results.',
    inputSchema: {
      type: 'object',
      properties: {
        provider: {
          type: 'string',
          description: 'Filter by AI provider (e.g., openai, anthropic, google)',
        },
        model: {
          type: 'string',
          description: 'Filter by model name (e.g., gpt-5, claude-4-5-sonnet)',
        },
        status: {
          type: 'string',
          enum: ['STATUS_CODE_OK', 'STATUS_CODE_ERROR'],
          description: 'Filter by status code',
        },
        limit: {
          type: 'number',
          description: `Max results to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT})`,
        },
        hours: {
          type: 'number',
          description: `Look back period in hours (default ${DEFAULT_HOURS}, max ${MAX_HOURS})`,
        },
        cursor: {
          type: 'string',
          description: 'Pagination cursor from previous response',
        },
      },
    },
  },
  {
    name: 'get_trace',
    description:
      'Get detailed information about a specific trace including all spans, tokens, costs, and timing.',
    inputSchema: {
      type: 'object',
      properties: {
        trace_id: {
          type: 'string',
          description: '32-character hex trace ID',
        },
      },
      required: ['trace_id'],
    },
  },
];

export const listTraces = internalAction({
  args: {
    apiKeys: v.array(v.string()),
    params: v.object({
      provider: v.optional(v.string()),
      model: v.optional(v.string()),
      status: v.optional(v.string()),
      limit: v.optional(v.number()),
      hours: v.optional(v.number()),
      cursor: v.optional(v.string()),
    }),
  },
  handler: async (ctx, args): Promise<ToolCallResult> => {
    const { apiKeys, params } = args;

    if (apiKeys.length === 0) {
      return {
        content: [
          { type: 'text', text: 'No API keys configured. Please create an API key first.' },
        ],
        isError: true,
      };
    }

    // Generate token using the shared implementation
    const token = await ctx.runAction(internal.tinybird.generateTokenInternal, {
      scopes: [{ type: 'PIPES:READ', resource: 'otel_traces' }],
    });

    const limit = Math.min(params.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
    const hours = Math.min(params.hours ?? DEFAULT_HOURS, MAX_HOURS);
    const startTimeNs = (Date.now() - hours * 60 * 60 * 1000) * 1_000_000;

    const conditions: string[] = [
      "SpanName = 'ai.request'",
      buildApiKeyFilter(apiKeys),
      `ReceivedAt >= ${startTimeNs}`,
    ];

    if (params.provider) {
      conditions.push(
        `JSONExtractString(SpanAttributes, 'ai.provider') = '${escapeSQL(params.provider)}'`,
      );
    }
    if (params.model) {
      conditions.push(
        `JSONExtractString(SpanAttributes, 'ai.model') = '${escapeSQL(params.model)}'`,
      );
    }
    if (params.status) {
      conditions.push(`StatusCode = '${escapeSQL(params.status)}'`);
    }

    let offsetClause = '';
    if (params.cursor) {
      const offset = parseInt(params.cursor, 10);
      if (!isNaN(offset) && offset > 0) {
        offsetClause = `OFFSET ${offset}`;
      }
    }

    const sql = `SELECT
      TraceId,
      ReceivedAt,
      Duration / 1000000 as duration_ms,
      StatusCode,
      JSONExtractString(SpanAttributes, 'ai.provider') as provider,
      JSONExtractString(SpanAttributes, 'ai.model') as model,
      JSONExtractInt(SpanAttributes, 'ai.tokens.prompt') as prompt_tokens,
      JSONExtractInt(SpanAttributes, 'ai.tokens.completion') as completion_tokens,
      JSONExtractInt(SpanAttributes, 'ai.tokens.total') as total_tokens,
      JSONExtractFloat(SpanAttributes, 'ai.cost.total') / 1000000 as cost_usd
    FROM otel_traces
    WHERE ${conditions.join(' AND ')}
    ORDER BY ReceivedAt DESC
    LIMIT ${limit + 1}
    ${offsetClause}
    FORMAT JSON`;

    const data = await queryTinybird(token, sql);

    const hasMore = data.length > limit;
    const traces = hasMore ? data.slice(0, limit) : data;

    const currentOffset = params.cursor ? parseInt(params.cursor, 10) : 0;
    const nextCursor = hasMore ? String(currentOffset + limit) : undefined;

    const result = {
      traces: traces.map((t) => ({
        trace_id: t.TraceId,
        timestamp: new Date(Number(t.ReceivedAt) / 1_000_000).toISOString(),
        duration_ms: t.duration_ms,
        status: t.StatusCode === 'STATUS_CODE_OK' ? 'ok' : 'error',
        provider: t.provider,
        model: t.model,
        tokens: {
          prompt: t.prompt_tokens,
          completion: t.completion_tokens,
          total: t.total_tokens,
        },
        cost_usd: t.cost_usd,
      })),
      pagination: {
        has_more: hasMore,
        next_cursor: nextCursor,
        limit,
      },
    };

    return {
      content: [{ type: 'text', text: JSON.stringify(result) }],
    };
  },
});

export const getTrace = internalAction({
  args: {
    apiKeys: v.array(v.string()),
    params: v.object({
      trace_id: v.string(),
    }),
  },
  handler: async (ctx, args): Promise<ToolCallResult> => {
    const { apiKeys, params } = args;

    if (apiKeys.length === 0) {
      return {
        content: [
          { type: 'text', text: 'No API keys configured. Please create an API key first.' },
        ],
        isError: true,
      };
    }

    if (!TRACE_ID_PATTERN.test(params.trace_id)) {
      return {
        content: [
          { type: 'text', text: 'Invalid trace ID format. Must be a 32-character hex string.' },
        ],
        isError: true,
      };
    }

    // Generate token using the shared implementation
    const token = await ctx.runAction(internal.tinybird.generateTokenInternal, {
      scopes: [{ type: 'PIPES:READ', resource: 'otel_traces' }],
    });

    const sql = `SELECT
      ReceivedAt, Timestamp, TraceId, SpanId, ParentSpanId, SpanName,
      Duration, StatusCode, StatusMessage, SpanAttributes,
      Events.Timestamp as EventTimestamps, Events.Name as EventNames, Events.Attributes as EventAttributes
    FROM otel_traces
    WHERE TraceId = '${escapeSQL(params.trace_id)}' AND ${buildApiKeyFilter(apiKeys)}
    ORDER BY Timestamp ASC
    FORMAT JSON`;

    const data = await queryTinybird(token, sql);

    if (data.length === 0) {
      return {
        content: [{ type: 'text', text: `Trace not found: ${params.trace_id}` }],
        isError: true,
      };
    }

    const spans = data.map((span) => {
      const attrs =
        typeof span.SpanAttributes === 'string'
          ? JSON.parse(span.SpanAttributes)
          : span.SpanAttributes;

      return {
        span_id: span.SpanId,
        parent_span_id: span.ParentSpanId ?? null,
        name: span.SpanName,
        timestamp: new Date(Number(span.Timestamp) / 1_000_000).toISOString(),
        duration_ms: Number(span.Duration) / 1_000_000,
        status: span.StatusCode === 'STATUS_CODE_OK' ? 'ok' : 'error',
        status_message: span.StatusMessage ?? null,
        attributes: {
          provider: attrs['ai.provider'],
          model: attrs['ai.model'],
          target_url: attrs['ai.target_url'],
          http_status: attrs['http.status_code'],
          tokens: {
            prompt: Number(attrs['ai.tokens.prompt']) || 0,
            completion: Number(attrs['ai.tokens.completion']) || 0,
            total: Number(attrs['ai.tokens.total']) || 0,
            cached: Number(attrs['ai.tokens.cached']) || 0,
            reasoning: Number(attrs['ai.tokens.reasoning']) || 0,
          },
          cost_usd: {
            input: (Number(attrs['ai.cost.input']) || 0) / 1_000_000,
            output: (Number(attrs['ai.cost.output']) || 0) / 1_000_000,
            total: (Number(attrs['ai.cost.total']) || 0) / 1_000_000,
          },
          time_to_first_token_ms: Number(attrs['ai.time_to_first_token_ms']) || null,
        },
      };
    });

    const rootSpan = spans.find((s) => !s.parent_span_id);

    const result = {
      trace_id: params.trace_id,
      root_span: rootSpan
        ? {
            provider: rootSpan.attributes.provider,
            model: rootSpan.attributes.model,
            duration_ms: rootSpan.duration_ms,
            status: rootSpan.status,
            tokens: rootSpan.attributes.tokens,
            cost_usd: rootSpan.attributes.cost_usd,
          }
        : null,
      spans,
      span_count: spans.length,
    };

    return {
      content: [{ type: 'text', text: JSON.stringify(result) }],
    };
  },
});
