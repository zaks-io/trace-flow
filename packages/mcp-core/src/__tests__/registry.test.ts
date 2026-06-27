import { describe, expect, it } from 'vitest';
import {
  TOOL_DEFINITIONS,
  getTraceFlowToolDefinitions,
  isTraceFlowToolAvailableOnSurface,
} from '../index';

describe('Trace Flow tool surface registry', () => {
  it('keeps MCP output unchanged', () => {
    expect(getTraceFlowToolDefinitions('mcp')).toEqual(TOOL_DEFINITIONS);
  });

  it('exposes product data through the sandbox data API surface only', () => {
    const analystNames = new Set(getTraceFlowToolDefinitions('analyst').map((tool) => tool.name));
    const listTracesTool = getTraceFlowToolDefinitions('analyst').find(
      (tool) => tool.name === 'list_traces',
    );

    expect(analystNames.has('list_traces')).toBe(true);
    expect(analystNames.has('list_api_keys')).toBe(false);
    expect(analystNames.has('describe_agent_analytics')).toBe(true);
    expect(analystNames.has('query_agent_analytics')).toBe(true);
    expect(listTracesTool?.inputSchema.properties).not.toHaveProperty('api_key_ids');
    expect(isTraceFlowToolAvailableOnSurface('not_a_tool', 'analyst')).toBe(false);
  });
});
