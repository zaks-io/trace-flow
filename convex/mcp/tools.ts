import { internalAction } from '../_generated/server';
import { internal } from '../_generated/api';
import { v } from 'convex/values';
import type { ToolDefinition, ToolCallResult } from './protocol';
import { escapeSQL, buildApiKeyFilter, jsonReplacer, stripNulls } from './utils';

const TRACE_ID_PATTERN = /^[a-f0-9]{32}$/i;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 25;
const DEFAULT_HOURS = 24;
const MAX_HOURS = 168;

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
      'Get trace details with paginated spans. Returns base span fields (span_id, name, duration_ms, status, timestamp) by default. Use expand to include additional fields like costs, tokens, model, provider, baggage. Includes aggregate summary statistics (totals by provider/model) by default.',
    inputSchema: {
      type: 'object',
      properties: {
        trace_id: {
          type: 'string',
          description: '32-character hex trace ID',
        },
        expand: {
          type: 'array',
          items: {
            type: 'string',
            enum: [
              'provider',
              'model',
              'tokens',
              'costs',
              'ttft',
              'parent',
              'url',
              'http',
              'status_message',
              'baggage',
            ],
          },
          description:
            'Fields to include in spans beyond base fields. Options: provider, model, tokens, costs, ttft (time to first token), parent (parent_span_id), url (target_url), http (http_status), status_message, baggage (user context).',
        },
        limit: {
          type: 'number',
          description: 'Max spans per page (default 10, max 100)',
        },
        cursor: {
          type: 'string',
          description: 'Pagination cursor (offset) from previous response',
        },
        span_names: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Filter to only include spans matching these names. Supports wildcard suffix (e.g., "ai.*" matches ai.request, ai.embedding). Multiple patterns are OR\'d together.',
        },
        top_n: {
          type: 'number',
          description:
            'Return only the top N spans sorted by the sort_by field. Useful for finding slowest or most expensive calls.',
        },
        sort_by: {
          type: 'string',
          enum: ['duration_ms', 'cost_usd', 'tokens'],
          description:
            'Sort spans by this metric (descending). Use with top_n. Defaults to duration_ms.',
        },
        min_duration_ms: {
          type: 'number',
          description:
            'Exclude spans with duration below this threshold (in milliseconds). Useful for filtering out 0ms marker spans.',
        },
        exclude_span_names: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Span names to exclude from results. Supports wildcard suffix (e.g., "ai.request.*" excludes ai.request.user, ai.request.assistant, etc.)',
        },
        include_summary: {
          type: 'boolean',
          description:
            'Include aggregate summary statistics with totals (count, duration_ms, cost_usd, tokens) broken down by provider and model. Enabled by default. Set to false to reduce response size when only individual spans are needed.',
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
      JSONExtractFloat(SpanAttributes, 'ai.cost.total') as cost_usd
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
      content: [{ type: 'text', text: JSON.stringify(result, jsonReplacer) }],
    };
  },
});

const DEFAULT_SPAN_LIMIT = 10;
const MAX_SPAN_LIMIT = 100;

export const getTrace = internalAction({
  args: {
    apiKeys: v.array(v.string()),
    params: v.object({
      trace_id: v.string(),
      expand: v.optional(v.array(v.string())),
      limit: v.optional(v.number()),
      cursor: v.optional(v.string()),
      span_names: v.optional(v.array(v.string())),
      top_n: v.optional(v.number()),
      sort_by: v.optional(v.string()),
      min_duration_ms: v.optional(v.number()),
      exclude_span_names: v.optional(v.array(v.string())),
      include_summary: v.optional(v.boolean()),
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

    // Parse expand options
    const expand = new Set(params.expand ?? []);

    // Parse all spans with full attributes for filtering/sorting
    const allSpans = data.map((span) => {
      const attrs =
        typeof span.SpanAttributes === 'string'
          ? JSON.parse(span.SpanAttributes)
          : span.SpanAttributes;

      // Parse token values
      const promptTokens = Number(attrs['ai.tokens.prompt']) || 0;
      const completionTokens = Number(attrs['ai.tokens.completion']) || 0;
      const totalTokens = Number(attrs['ai.tokens.total']) || 0;
      const cachedTokens = Number(attrs['ai.tokens.cached']) || 0;
      const reasoningTokens = Number(attrs['ai.tokens.reasoning']) || 0;

      // Parse cost values (stored as dollar strings, not microdollars)
      const inputCost = Number(attrs['ai.cost.input']) || 0;
      const outputCost = Number(attrs['ai.cost.output']) || 0;
      const totalCost = Number(attrs['ai.cost.total']) || 0;

      // Extract baggage attributes (prefixed with baggage.*)
      const baggage: Record<string, string> = {};
      for (const [key, value] of Object.entries(attrs)) {
        if (key.startsWith('baggage.') && value != null) {
          const strValue =
            typeof value === 'string'
              ? value
              : typeof value === 'number' || typeof value === 'boolean'
                ? String(value)
                : JSON.stringify(value);
          baggage[key.slice(8)] = strValue;
        }
      }

      return {
        span_id: span.SpanId as string,
        parent_span_id: span.ParentSpanId as string | undefined,
        name: span.SpanName as string,
        timestamp: new Date(Number(span.Timestamp) / 1_000_000).toISOString(),
        duration_ms: Number(span.Duration) / 1_000_000,
        status: span.StatusCode === 'STATUS_CODE_OK' ? 'ok' : 'error',
        status_message: span.StatusMessage as string | undefined,
        provider: attrs['ai.provider'] as string | undefined,
        model: attrs['ai.model'] as string | undefined,
        target_url: attrs['ai.target_url'] as string | undefined,
        http_status: attrs['http.status_code'] as string | undefined,
        tokens:
          totalTokens > 0 || promptTokens > 0 || completionTokens > 0
            ? {
                prompt: promptTokens,
                completion: completionTokens,
                total: totalTokens,
                cached: cachedTokens,
                reasoning: reasoningTokens,
              }
            : undefined,
        cost_usd:
          totalCost > 0 || inputCost > 0 || outputCost > 0
            ? { input: inputCost, output: outputCost, total: totalCost }
            : undefined,
        time_to_first_token_ms: Number(attrs['ai.time_to_first_token_ms']) || undefined,
        baggage: Object.keys(baggage).length > 0 ? baggage : undefined,
      };
    });

    // Apply span name inclusion filter if specified
    let filteredSpans =
      params.span_names && params.span_names.length > 0
        ? allSpans.filter((s) => {
            return params.span_names!.some((pattern) => {
              if (pattern.endsWith('.*')) {
                const prefix = pattern.slice(0, -1);
                return s.name.startsWith(prefix);
              }
              return s.name === pattern;
            });
          })
        : allSpans;

    // Apply min duration filter
    if (params.min_duration_ms !== undefined && params.min_duration_ms > 0) {
      filteredSpans = filteredSpans.filter((s) => s.duration_ms >= params.min_duration_ms!);
    }

    // Apply exclusion filter
    if (params.exclude_span_names && params.exclude_span_names.length > 0) {
      filteredSpans = filteredSpans.filter((s) => {
        return !params.exclude_span_names!.some((pattern) => {
          if (pattern.endsWith('.*')) {
            const prefix = pattern.slice(0, -1);
            return s.name.startsWith(prefix);
          }
          return s.name === pattern;
        });
      });
    }

    const totalFilteredCount = filteredSpans.length;

    // Generate summary by default (before top_n slice to aggregate all filtered spans)
    // Can be disabled with include_summary: false to reduce response size
    let summary: Record<string, unknown> | undefined;
    if (params.include_summary !== false) {
      const byProvider: Record<
        string,
        { count: number; duration_ms: number; cost_usd: number; tokens: number }
      > = {};
      const byModel: Record<
        string,
        { count: number; duration_ms: number; cost_usd: number; tokens: number }
      > = {};

      for (const span of filteredSpans) {
        if (span.provider) {
          byProvider[span.provider] ??= { count: 0, duration_ms: 0, cost_usd: 0, tokens: 0 };
          byProvider[span.provider].count++;
          byProvider[span.provider].duration_ms += span.duration_ms;
          byProvider[span.provider].cost_usd += span.cost_usd?.total ?? 0;
          byProvider[span.provider].tokens += span.tokens?.total ?? 0;
        }

        if (span.model) {
          byModel[span.model] ??= { count: 0, duration_ms: 0, cost_usd: 0, tokens: 0 };
          byModel[span.model].count++;
          byModel[span.model].duration_ms += span.duration_ms;
          byModel[span.model].cost_usd += span.cost_usd?.total ?? 0;
          byModel[span.model].tokens += span.tokens?.total ?? 0;
        }
      }

      const totals = filteredSpans.reduce(
        (acc, s) => ({
          count: acc.count + 1,
          duration_ms: acc.duration_ms + s.duration_ms,
          cost_usd: acc.cost_usd + (s.cost_usd?.total ?? 0),
          tokens: acc.tokens + (s.tokens?.total ?? 0),
        }),
        { count: 0, duration_ms: 0, cost_usd: 0, tokens: 0 },
      );

      summary = {
        totals,
        by_provider: Object.keys(byProvider).length > 0 ? byProvider : undefined,
        by_model: Object.keys(byModel).length > 0 ? byModel : undefined,
      };
    }

    // Apply top_n sorting if specified
    if (params.top_n && params.top_n > 0) {
      const sortBy = params.sort_by ?? 'duration_ms';

      filteredSpans = [...filteredSpans].sort((a, b) => {
        switch (sortBy) {
          case 'cost_usd':
            return (b.cost_usd?.total ?? 0) - (a.cost_usd?.total ?? 0);
          case 'tokens':
            return (b.tokens?.total ?? 0) - (a.tokens?.total ?? 0);
          case 'duration_ms':
          default:
            return b.duration_ms - a.duration_ms;
        }
      });

      filteredSpans = filteredSpans.slice(0, params.top_n);
    }

    // Apply pagination
    const limit = Math.min(params.limit ?? DEFAULT_SPAN_LIMIT, MAX_SPAN_LIMIT);
    const offset = params.cursor ? parseInt(params.cursor, 10) : 0;
    const paginatedSpans = filteredSpans.slice(offset, offset + limit);
    const hasMore = offset + limit < filteredSpans.length;

    // Calculate trace-level stats
    const timestamps = allSpans.map((s) => new Date(s.timestamp).getTime());
    const traceDuration =
      timestamps.length > 0 ? Math.max(...timestamps) - Math.min(...timestamps) : 0;
    const hasError = allSpans.some((s) => s.status === 'error');

    // Build output spans with only requested expand fields
    const outputSpans = paginatedSpans.map((s) => {
      const span: Record<string, unknown> = {
        span_id: s.span_id,
        name: s.name,
        duration_ms: s.duration_ms,
        status: s.status,
        timestamp: s.timestamp,
      };

      if (expand.has('parent') && s.parent_span_id) span.parent_span_id = s.parent_span_id;
      if (expand.has('status_message') && s.status_message) span.status_message = s.status_message;
      if (expand.has('provider') && s.provider) span.provider = s.provider;
      if (expand.has('model') && s.model) span.model = s.model;
      if (expand.has('url') && s.target_url) span.target_url = s.target_url;
      if (expand.has('http') && s.http_status) span.http_status = s.http_status;
      if (expand.has('tokens') && s.tokens) span.tokens = s.tokens;
      if (expand.has('costs') && s.cost_usd) span.cost_usd = s.cost_usd;
      if (expand.has('ttft') && s.time_to_first_token_ms)
        span.time_to_first_token_ms = s.time_to_first_token_ms;
      if (expand.has('baggage') && s.baggage) span.baggage = s.baggage;

      return span;
    });

    const result = {
      trace_id: params.trace_id,
      span_count: allSpans.length,
      duration_ms: traceDuration,
      status: hasError ? 'error' : 'ok',
      summary,
      spans: outputSpans,
      pagination: {
        has_more: hasMore,
        next_cursor: hasMore ? String(offset + limit) : undefined,
        total: totalFilteredCount,
      },
    };

    return {
      content: [{ type: 'text', text: JSON.stringify(stripNulls(result), jsonReplacer) }],
    };
  },
});
