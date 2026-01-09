import type { ToolDefinition } from '../protocol';
import { DEFAULT_LIMIT, MAX_LIMIT, DEFAULT_HOURS, MAX_HOURS } from './shared';

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
      },
    },
  },
  {
    name: 'get_trace',
    description:
      'Get trace summary with aggregate statistics. Returns totals and breakdowns by provider/model. Use get_trace_spans for individual spans and get_trace_events for event details.',
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
            'Filter by span names. Supports wildcard suffix (e.g., "gen_ai.*" matches gen_ai.request, gen_ai.embedding).',
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
          description: 'Max spans per page (default 10, max 100).',
        },
        cursor: {
          type: 'string',
          description: 'Pagination cursor from previous response.',
        },
      },
      required: ['trace_id'],
    },
  },
  {
    name: 'get_trace_events',
    description:
      'Get paginated events from a trace. Events are metadata only (event type, role, tool name) - no message content or bodies. Filter by span or event type.',
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
            'Filter to events from spans matching these names (e.g., ["gen_ai.request"]).',
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
      },
      required: ['trace_id'],
    },
  },
];
