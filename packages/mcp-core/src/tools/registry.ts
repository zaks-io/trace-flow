import type { ToolCallResult } from '../protocol';
import type { ToolDefinition } from '../protocol';
import type { ToolCtx } from '../tinybird';
import { TOOL_DEFINITIONS } from './definitions';
import { listTraces } from './listTracesAction';
import { getTrace } from './getTraceAction';
import { getTraceSpans } from './getTraceSpansAction';
import { getTraceEvents } from './getTraceEventsAction';
import { listTraceSummaries } from './listTraceSummaries';
import { getUsageSummary, listModelUsage, listOperationUsage } from './analytics';
import { describeAgentAnalytics, queryAgentAnalytics } from './agentAnalytics';

// "analyst" is the sandbox-local REST/OpenAPI data surface, not the main
// Analyst chat model's direct tool list.
export type TraceFlowToolSurface = 'mcp' | 'analyst';

export type ToolHandler = (
  ctx: ToolCtx,
  keys: string[],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  args: any,
  retentionDays: number,
) => Promise<ToolCallResult>;

const BOTH_SURFACES = ['mcp', 'analyst'] as const;
const MCP_ONLY = ['mcp'] as const;
const SANDBOX_DATA_API_BLOCKED_TOOLS = new Set(['list_api_keys']);

export const TRACE_FLOW_TOOL_SURFACES: Record<string, readonly TraceFlowToolSurface[]> =
  Object.fromEntries(
    TOOL_DEFINITIONS.map((definition) => [
      definition.name,
      SANDBOX_DATA_API_BLOCKED_TOOLS.has(definition.name) ? MCP_ONLY : BOTH_SURFACES,
    ]),
  );

export const TRACE_FLOW_TOOL_HANDLERS: Record<string, ToolHandler> = {
  list_traces: listTraces,
  list_trace_summaries: listTraceSummaries,
  get_trace: getTrace,
  get_trace_spans: getTraceSpans,
  get_trace_events: getTraceEvents,
  get_usage_summary: getUsageSummary,
  list_operation_usage: listOperationUsage,
  list_model_usage: listModelUsage,
  describe_agent_analytics: describeAgentAnalytics,
  query_agent_analytics: queryAgentAnalytics,
};

export function isTraceFlowToolAvailableOnSurface(
  name: string,
  surface: TraceFlowToolSurface,
): boolean {
  return TRACE_FLOW_TOOL_SURFACES[name]?.includes(surface) ?? false;
}

export function getTraceFlowToolDefinitions(surface: TraceFlowToolSurface) {
  const definitions = TOOL_DEFINITIONS.filter((definition) =>
    isTraceFlowToolAvailableOnSurface(definition.name, surface),
  );

  if (surface === 'mcp') return definitions;
  return definitions.map(stripAnalystOnlyToolMetadata);
}

export function getTraceFlowToolHandler(name: string): ToolHandler | undefined {
  return TRACE_FLOW_TOOL_HANDLERS[name];
}

function stripAnalystOnlyToolMetadata(definition: ToolDefinition): ToolDefinition {
  const properties = definition.inputSchema.properties;
  if (!properties || !('api_key_ids' in properties)) return definition;

  // The Analyst sandbox data API can query product data, but it should not
  // discover key inventory. MCP keeps api_key_ids because users may explicitly filter there.
  const { api_key_ids: _apiKeyIds, ...nextProperties } = properties;
  return {
    ...definition,
    inputSchema: {
      ...definition.inputSchema,
      properties: nextProperties,
    },
  };
}
