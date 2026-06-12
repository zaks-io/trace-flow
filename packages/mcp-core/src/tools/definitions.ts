import type { ToolDefinition } from '../protocol';
import {
  DEFAULT_ANALYTICS_HOURS,
  DEFAULT_ANALYTICS_LIMIT,
  DEFAULT_EVENT_LIMIT,
  DEFAULT_HOURS,
  DEFAULT_LIMIT,
  DEFAULT_SPAN_LIMIT,
  DEFAULT_TRACE_SUMMARY_LIMIT,
  MAX_ANALYTICS_HOURS,
  MAX_ANALYTICS_LIMIT,
  MAX_EVENT_LIMIT,
  MAX_LIMIT,
  MAX_SPAN_LIMIT,
  MAX_TRACE_SUMMARY_LIMIT,
} from './shared';

const API_KEY_IDS_PROPERTY = {
  type: 'array',
  items: { type: 'string' },
  description: 'Filter by specific API key IDs (from list_api_keys). Omit to use all keys.',
} as const;

const PROVIDER_PROPERTY = {
  type: 'string',
  description: 'Filter by provider',
} as const;

const MODEL_PROPERTY = {
  type: 'string',
  description: 'Filter by model',
} as const;

const STATUS_PROPERTY = {
  type: 'string',
  enum: ['STATUS_CODE_OK', 'STATUS_CODE_ERROR'],
  description: 'Filter by status code',
} as const;

const CURSOR_PROPERTY = {
  type: 'string',
  description: 'Pagination cursor from previous response',
} as const;

const TRACE_SORT_BY_PROPERTY = {
  type: 'string',
  enum: ['timestamp', 'duration_ms', 'cost_usd', 'tokens'],
  description: 'Field to sort by. Default: timestamp',
} as const;

const SORT_DESC_PROPERTY = {
  type: 'string',
  enum: ['asc', 'desc'],
  description: 'Sort direction. Default: desc',
} as const;

const OPERATION_PROPERTY = {
  type: 'string',
  description: 'Filter by baggage.operation / workflow label',
} as const;

const AGENT_FILTERS_PROPERTY = {
  type: 'object',
  description: 'Optional filters applied to agent analytics views.',
  properties: {
    sources: {
      type: 'array',
      items: { type: 'string', enum: ['claude', 'codex', 'cursor'] },
      description: 'Agent sources to include.',
    },
    models: {
      type: 'array',
      items: { type: 'string' },
      description: 'Model names to include.',
    },
    repo_fingerprints: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Repo/project fingerprints to include. Use view="projects" to discover available values.',
    },
  },
} as const;

function limitProperty(defaultLimit: number, maxLimit: number, subject = 'results') {
  return {
    type: 'number',
    description: `Max ${subject} to return (default ${defaultLimit}, max ${maxLimit})`,
  } as const;
}

function hoursProperty(defaultHours: number, maxHours: number) {
  return {
    type: 'number',
    description: `Look back period in hours (default ${defaultHours}, max ${maxHours})`,
  } as const;
}

function analyticsProperties(options: { includeModel?: boolean; limitSubject?: string } = {}) {
  return {
    hours: hoursProperty(DEFAULT_ANALYTICS_HOURS, MAX_ANALYTICS_HOURS),
    provider: PROVIDER_PROPERTY,
    ...(options.includeModel === false ? {} : { model: MODEL_PROPERTY }),
    operation: OPERATION_PROPERTY,
    status: STATUS_PROPERTY,
    ...(options.limitSubject
      ? { limit: limitProperty(DEFAULT_ANALYTICS_LIMIT, MAX_ANALYTICS_LIMIT, options.limitSubject) }
      : {}),
    api_key_ids: API_KEY_IDS_PROPERTY,
  } as const;
}

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
          description: 'Filter by model name as captured in trace data.',
        },
        status: STATUS_PROPERTY,
        limit: limitProperty(DEFAULT_LIMIT, MAX_LIMIT),
        hours: {
          type: 'number',
          description: `Look back period in hours (default ${DEFAULT_HOURS}, capped by your plan's retention period)`,
        },
        cursor: CURSOR_PROPERTY,
        sort_by: TRACE_SORT_BY_PROPERTY,
        order: SORT_DESC_PROPERTY,
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
          ...STATUS_PROPERTY,
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
        limit: limitProperty(
          DEFAULT_TRACE_SUMMARY_LIMIT,
          MAX_TRACE_SUMMARY_LIMIT,
          'traces per page',
        ),
        hours: hoursProperty(DEFAULT_ANALYTICS_HOURS, MAX_ANALYTICS_HOURS),
        cursor: CURSOR_PROPERTY,
        sort_by: TRACE_SORT_BY_PROPERTY,
        order: SORT_DESC_PROPERTY,
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
            'Filter by span names. Supports prefix patterns with trailing wildcards (for example "chat *", "embeddings *", or "gen_ai.response.*").',
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
          ...TRACE_SORT_BY_PROPERTY,
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
        limit: limitProperty(DEFAULT_SPAN_LIMIT, MAX_SPAN_LIMIT, 'spans per page'),
        cursor: { ...CURSOR_PROPERTY, description: 'Pagination cursor from previous response.' },
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
        limit: limitProperty(DEFAULT_EVENT_LIMIT, MAX_EVENT_LIMIT, 'events per page'),
        cursor: { ...CURSOR_PROPERTY, description: 'Pagination cursor from previous response.' },
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
        ...analyticsProperties(),
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
        ...analyticsProperties({ limitSubject: 'operations' }),
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
        ...analyticsProperties({ includeModel: false, limitSubject: 'models' }),
      },
    },
  },
  {
    name: 'describe_agent_analytics',
    description:
      'Describe the agent analytics query contract and list discovered filter values for the authenticated org. Use this before query_agent_analytics so agents do not invent repo fingerprints, model names, or view-specific parameters.',
    inputSchema: {
      type: 'object',
      properties: {
        hours: hoursProperty(DEFAULT_ANALYTICS_HOURS, MAX_ANALYTICS_HOURS),
        start_time: {
          type: 'string',
          description:
            'Inclusive ISO date/time window start for discovered values. Example: 2026-06-04T00:00:00Z.',
        },
        end_time: {
          type: 'string',
          description: 'Exclusive ISO date/time window end for discovered values. Defaults to now.',
        },
        start_time_ms: {
          type: 'number',
          description: 'Inclusive Unix epoch millisecond window start. If omitted, hours is used.',
        },
        end_time_ms: {
          type: 'number',
          description: 'Exclusive Unix epoch millisecond window end. Defaults to now.',
        },
        filters: AGENT_FILTERS_PROPERTY,
        include_values: {
          type: 'boolean',
          description:
            'When false, returns only static allowed views, filters, and view parameters. Defaults to true.',
        },
        limit: limitProperty(DEFAULT_ANALYTICS_LIMIT, MAX_ANALYTICS_LIMIT, 'discovered values'),
      },
    },
  },
  {
    name: 'query_agent_analytics',
    description:
      'Query org-scoped agent conversation analytics from allowlisted views. Use this for project/repo, model, source, token, cost, session, and tool-failure metrics without reading raw transcripts.',
    inputSchema: {
      type: 'object',
      properties: {
        view: {
          type: 'string',
          enum: [
            'summary',
            'timeseries',
            'breakdown',
            'sessions',
            'tool_failures',
            'tool_deltas',
            'projects',
          ],
          description:
            'Analytics view to query. summary is a KPI row; timeseries returns buckets; breakdown ranks source/model/repo; sessions lists sessions; projects lists repo fingerprints.',
        },
        hours: hoursProperty(DEFAULT_ANALYTICS_HOURS, MAX_ANALYTICS_HOURS),
        start_time: {
          type: 'string',
          description:
            'Inclusive ISO date/time window start. Example: 2026-06-04T00:00:00Z. start_time_ms takes precedence when both are set.',
        },
        end_time: {
          type: 'string',
          description:
            'Exclusive ISO date/time window end. Defaults to now. end_time_ms takes precedence when both are set.',
        },
        start_time_ms: {
          type: 'number',
          description: 'Inclusive Unix epoch millisecond window start. If omitted, hours is used.',
        },
        end_time_ms: {
          type: 'number',
          description: 'Exclusive Unix epoch millisecond window end. Defaults to now.',
        },
        filters: AGENT_FILTERS_PROPERTY,
        group_by: {
          type: 'string',
          enum: ['none', 'source', 'model', 'repo'],
          description: 'For view="timeseries", split buckets by this dimension.',
        },
        granularity: {
          type: 'string',
          enum: ['auto', 'hour', 'day'],
          description: 'For view="timeseries", bucket size.',
        },
        dimension: {
          type: 'string',
          enum: ['source', 'model', 'repo'],
          description: 'For view="breakdown", dimension to rank.',
        },
        order_by: {
          type: 'string',
          enum: ['cost_usd', 'total_tokens', 'message_count', 'session_count'],
          description: 'For view="breakdown", metric to rank by.',
        },
        sort: {
          type: 'string',
          enum: ['recent', 'cost', 'files', 'duration', 'messages'],
          description: 'For view="sessions", descending sort key.',
        },
        min_events: {
          type: 'number',
          description: 'For view="tool_failures", minimum tool events before a row is returned.',
        },
        limit: limitProperty(DEFAULT_ANALYTICS_LIMIT, MAX_ANALYTICS_LIMIT, 'rows'),
        offset: {
          type: 'number',
          description: 'For paged multi-row views, zero-based row offset.',
        },
      },
      required: ['view'],
    },
  },
];
