import type { ToolDefinition } from '../protocol';
import {
  DEFAULT_ANALYTICS_HOURS,
  DEFAULT_HOURS,
  DEFAULT_LIMIT,
  DEFAULT_SPAN_LIMIT,
  MAX_ANALYTICS_HOURS,
  MAX_HOURS,
  MAX_LIMIT,
} from './shared';

const API_KEY_IDS_PROPERTY = {
  type: 'array',
  items: { type: 'string' },
  description: 'Filter by specific API key IDs (from list_api_keys). Omit to use all keys.',
} as const;

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'list_api_keys',
    description:
      'List available API keys. Returns key names and IDs (not raw values). Use the returned IDs with api_key_ids on other tools to filter traces to a specific app.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'list_traces',
    description:
      'List recent LLM trace rows with optional filtering by provider, model, or status. Rows are span/model-call level, so a single trace_id may appear more than once.',
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
        sort_by: {
          type: 'string',
          enum: ['timestamp', 'duration_ms', 'cost_usd', 'tokens'],
          description: 'Field to sort by. Default: timestamp',
        },
        order: {
          type: 'string',
          enum: ['asc', 'desc'],
          description: 'Sort direction. Default: desc',
        },
        api_key_ids: API_KEY_IDS_PROPERTY,
      },
    },
  },
  {
    name: 'list_trace_summaries',
    description:
      'List unique traces with aggregated rollup fields. Use this when you want one row per trace_id instead of the span/model-call rows returned by list_traces.',
    inputSchema: {
      type: 'object',
      properties: {
        provider: {
          type: 'string',
          description:
            'Filter to traces that include this provider (e.g., openai, anthropic, groq)',
        },
        model: {
          type: 'string',
          description: 'Filter to traces that include this model name',
        },
        status: {
          type: 'string',
          enum: ['STATUS_CODE_OK', 'STATUS_CODE_ERROR'],
          description: 'Filter to traces with or without any error spans',
        },
        operation: {
          type: 'string',
          description:
            'Filter by baggage.operation / workflow label (for example chat, heartbeat, or key-art)',
        },
        trace_id: {
          type: 'string',
          description: 'Exact trace_id lookup. Bypasses other filters when set.',
        },
        limit: {
          type: 'number',
          description: 'Max traces per page (default 20, max 100)',
        },
        hours: {
          type: 'number',
          description: `Look back period in hours (default ${DEFAULT_ANALYTICS_HOURS}, max ${MAX_ANALYTICS_HOURS})`,
        },
        cursor: {
          type: 'string',
          description: 'Pagination cursor from previous response',
        },
        sort_by: {
          type: 'string',
          enum: ['timestamp', 'duration_ms', 'cost_usd', 'tokens'],
          description: 'Field to sort by. Default: timestamp',
        },
        order: {
          type: 'string',
          enum: ['asc', 'desc'],
          description: 'Sort direction. Default: desc',
        },
        api_key_ids: API_KEY_IDS_PROPERTY,
      },
    },
  },
  {
    name: 'get_trace',
    description:
      'Get trace summary with aggregate statistics. Top-level duration_ms is end-to-end wall time, while summary.totals.duration_ms is summed span time across the trace.',
    inputSchema: {
      type: 'object',
      properties: {
        trace_id: {
          type: 'string',
          description: '32-character hex trace ID',
        },
        api_key_ids: API_KEY_IDS_PROPERTY,
      },
      required: ['trace_id'],
    },
  },
  {
    name: 'get_trace_spans',
    description:
      'Get paginated spans from a trace. Supports filtering by name and sorting by duration, cost, or tokens. Base fields: span_id, name, duration_ms, status, timestamp. Use expand for additional fields.',
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
              'operation',
            ],
          },
          description:
            'Additional fields to include: provider, model, tokens, costs, ttft (time to first token), parent (parent_span_id), url (target_url), http (http_status), status_message, baggage (user context), operation (gen_ai.operation.name).',
        },
        span_names: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Filter by span names. Supports trailing-* prefixes (for example "chat *", "embeddings *", or "gen_ai.response.*").',
        },
        exclude_span_names: {
          type: 'array',
          items: { type: 'string' },
          description: 'Exclude spans matching these names.',
        },
        min_duration_ms: {
          type: 'number',
          description: 'Exclude spans below this duration (in milliseconds).',
        },
        sort_by: {
          type: 'string',
          enum: ['timestamp', 'duration_ms', 'cost_usd', 'tokens'],
          description: 'Sort order. Defaults to timestamp.',
        },
        order: {
          type: 'string',
          enum: ['asc', 'desc'],
          description: 'Sort direction. Default: asc (desc when using sort_by or top_n).',
        },
        top_n: {
          type: 'number',
          description: 'Return only top N spans by sort_by metric.',
        },
        limit: {
          type: 'number',
          description: `Max spans per page (default ${DEFAULT_SPAN_LIMIT}, max 100).`,
        },
        cursor: {
          type: 'string',
          description: 'Pagination cursor from previous response.',
        },
        api_key_ids: API_KEY_IDS_PROPERTY,
      },
      required: ['trace_id'],
    },
  },
  {
    name: 'get_trace_events',
    description:
      'Get paginated events from a trace. Events return safe metadata only (for example role, message index, content type, tool name, and tool id) without prompt or response bodies.',
    inputSchema: {
      type: 'object',
      properties: {
        trace_id: {
          type: 'string',
          description: '32-character hex trace ID',
        },
        span_id: {
          type: 'string',
          description: 'Filter to events from a specific span.',
        },
        span_names: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Filter to events from spans matching these names (for example ["chat *"] or ["gen_ai.response.*"]).',
        },
        event_names: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Filter by event type (e.g., ["input.thinking", "output.text", "input.tool_use"]).',
        },
        order: {
          type: 'string',
          enum: ['asc', 'desc'],
          description: 'Sort direction by timestamp. Default: asc.',
        },
        limit: {
          type: 'number',
          description: 'Max events per page (default 20, max 100).',
        },
        cursor: {
          type: 'string',
          description: 'Pagination cursor from previous response.',
        },
        api_key_ids: API_KEY_IDS_PROPERTY,
      },
      required: ['trace_id'],
    },
  },
  {
    name: 'get_usage_summary',
    description:
      'Get aggregated usage, cost, latency, and error totals for a time range. Use this for top-level KPI checks before drilling into traces.',
    inputSchema: {
      type: 'object',
      properties: {
        hours: {
          type: 'number',
          description: `Look back period in hours (default ${DEFAULT_ANALYTICS_HOURS}, max ${MAX_ANALYTICS_HOURS})`,
        },
        provider: {
          type: 'string',
          description: 'Filter by provider',
        },
        model: {
          type: 'string',
          description: 'Filter by model',
        },
        operation: {
          type: 'string',
          description: 'Filter by baggage.operation / workflow label',
        },
        status: {
          type: 'string',
          enum: ['STATUS_CODE_OK', 'STATUS_CODE_ERROR'],
          description: 'Filter by status code',
        },
        api_key_ids: API_KEY_IDS_PROPERTY,
      },
    },
  },
  {
    name: 'list_operation_usage',
    description:
      'List operation-level usage rollups for a time range. Use this for top cost, p95 latency, cache hit rate, and unique-user impact by workflow/operation.',
    inputSchema: {
      type: 'object',
      properties: {
        hours: {
          type: 'number',
          description: `Look back period in hours (default ${DEFAULT_ANALYTICS_HOURS}, max ${MAX_ANALYTICS_HOURS})`,
        },
        provider: {
          type: 'string',
          description: 'Filter by provider',
        },
        model: {
          type: 'string',
          description: 'Filter by model',
        },
        operation: {
          type: 'string',
          description: 'Filter by baggage.operation / workflow label',
        },
        status: {
          type: 'string',
          enum: ['STATUS_CODE_OK', 'STATUS_CODE_ERROR'],
          description: 'Filter by status code',
        },
        limit: {
          type: 'number',
          description: 'Max operations to return (default 20, max 100)',
        },
        api_key_ids: API_KEY_IDS_PROPERTY,
      },
    },
  },
  {
    name: 'list_model_usage',
    description:
      'List model-level usage rollups for a time range. Use this for top cost, p95 latency, and cost efficiency by model.',
    inputSchema: {
      type: 'object',
      properties: {
        hours: {
          type: 'number',
          description: `Look back period in hours (default ${DEFAULT_ANALYTICS_HOURS}, max ${MAX_ANALYTICS_HOURS})`,
        },
        provider: {
          type: 'string',
          description: 'Filter by provider',
        },
        operation: {
          type: 'string',
          description: 'Filter by baggage.operation / workflow label',
        },
        status: {
          type: 'string',
          enum: ['STATUS_CODE_OK', 'STATUS_CODE_ERROR'],
          description: 'Filter by status code',
        },
        limit: {
          type: 'number',
          description: 'Max models to return (default 20, max 100)',
        },
        api_key_ids: API_KEY_IDS_PROPERTY,
      },
    },
  },
];
