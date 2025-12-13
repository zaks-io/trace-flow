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
              'events',
            ],
          },
          description:
            'Fields to include in spans beyond base fields. Options: provider, model, tokens, costs, ttft (time to first token), parent (parent_span_id), url (target_url), http (http_status), status_message, baggage (user context), events (input/output events like input.text, output.text).',
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
            'Filter to only include spans matching these names. Supports wildcard suffix (e.g., "ai.*" matches ai.request, ai.embedding). Multiple patterns are OR\'d together. Use "ai.request" to filter to just Trace Flow\'s main LLM request spans.',
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
