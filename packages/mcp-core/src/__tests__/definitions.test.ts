import { describe, it, expect } from 'vitest';
import { TOOL_DEFINITIONS } from '../tools/definitions';

interface JsonSchemaProperty {
  type?: string;
  enum?: string[];
  items?: { enum?: string[] };
  description?: string;
}

describe('TOOL_DEFINITIONS', () => {
  it('exports an array of tools', () => {
    expect(Array.isArray(TOOL_DEFINITIONS)).toBe(true);
  });

  it('contains all expected tools', () => {
    const toolNames = TOOL_DEFINITIONS.map((t) => t.name);
    expect(toolNames).toContain('list_api_keys');
    expect(toolNames).toContain('list_traces');
    expect(toolNames).toContain('list_trace_summaries');
    expect(toolNames).toContain('get_trace');
    expect(toolNames).toContain('get_trace_spans');
    expect(toolNames).toContain('get_trace_events');
    expect(toolNames).toContain('get_usage_summary');
    expect(toolNames).toContain('list_operation_usage');
    expect(toolNames).toContain('list_model_usage');
  });
});

describe('list_api_keys tool definition', () => {
  const listApiKeysTool = TOOL_DEFINITIONS.find((t) => t.name === 'list_api_keys')!;

  it('has correct name', () => {
    expect(listApiKeysTool.name).toBe('list_api_keys');
  });

  it('has a description', () => {
    expect(listApiKeysTool.description).toBeDefined();
    expect(listApiKeysTool.description!.length).toBeGreaterThan(0);
  });

  it('has inputSchema with type object', () => {
    expect(listApiKeysTool.inputSchema.type).toBe('object');
  });

  it('has no required parameters', () => {
    expect(listApiKeysTool.inputSchema.required).toBeUndefined();
  });

  it('has empty properties', () => {
    expect(Object.keys(listApiKeysTool.inputSchema.properties as object)).toEqual([]);
  });
});

describe('list_traces tool definition', () => {
  const listTracesTool = TOOL_DEFINITIONS.find((t) => t.name === 'list_traces')!;

  it('has correct name', () => {
    expect(listTracesTool.name).toBe('list_traces');
  });

  it('has a description', () => {
    expect(listTracesTool.description).toBeDefined();
    expect(listTracesTool.description!.length).toBeGreaterThan(0);
  });

  it('has inputSchema with type object', () => {
    expect(listTracesTool.inputSchema.type).toBe('object');
  });

  it('has no required parameters', () => {
    expect(listTracesTool.inputSchema.required).toBeUndefined();
  });

  describe('parameters', () => {
    const props = listTracesTool.inputSchema.properties as Record<string, JsonSchemaProperty>;

    it('has provider parameter', () => {
      expect(props.provider).toBeDefined();
      expect(props.provider!.type).toBe('string');
    });

    it('has model parameter', () => {
      expect(props.model).toBeDefined();
      expect(props.model!.type).toBe('string');
    });

    it('has status parameter with enum', () => {
      expect(props.status).toBeDefined();
      expect(props.status!.type).toBe('string');
      expect(props.status!.enum).toContain('STATUS_CODE_OK');
      expect(props.status!.enum).toContain('STATUS_CODE_ERROR');
    });

    it('has limit parameter', () => {
      expect(props.limit).toBeDefined();
      expect(props.limit!.type).toBe('number');
    });

    it('has hours parameter', () => {
      expect(props.hours).toBeDefined();
      expect(props.hours!.type).toBe('number');
    });

    it('has cursor parameter', () => {
      expect(props.cursor).toBeDefined();
      expect(props.cursor!.type).toBe('string');
    });

    it('has api_key_ids parameter as array', () => {
      expect(props.api_key_ids).toBeDefined();
      expect(props.api_key_ids!.type).toBe('array');
    });
  });
});

describe('get_trace tool definition', () => {
  const getTraceTool = TOOL_DEFINITIONS.find((t) => t.name === 'get_trace')!;

  it('has correct name', () => {
    expect(getTraceTool.name).toBe('get_trace');
  });

  it('has a description', () => {
    expect(getTraceTool.description).toBeDefined();
    expect(getTraceTool.description!.length).toBeGreaterThan(0);
  });

  it('has inputSchema with type object', () => {
    expect(getTraceTool.inputSchema.type).toBe('object');
  });

  it('requires trace_id parameter', () => {
    expect(getTraceTool.inputSchema.required).toContain('trace_id');
  });

  describe('parameters', () => {
    const props = getTraceTool.inputSchema.properties as Record<string, JsonSchemaProperty>;

    it('has trace_id parameter', () => {
      expect(props.trace_id).toBeDefined();
      expect(props.trace_id!.type).toBe('string');
    });

    it('only has trace_id and api_key_ids parameters', () => {
      expect(Object.keys(props)).toEqual(['trace_id', 'api_key_ids']);
    });

    it('has api_key_ids parameter as array', () => {
      expect(props.api_key_ids).toBeDefined();
      expect(props.api_key_ids!.type).toBe('array');
    });
  });
});

describe('list_trace_summaries tool definition', () => {
  const listTraceSummariesTool = TOOL_DEFINITIONS.find((t) => t.name === 'list_trace_summaries')!;

  it('has correct name', () => {
    expect(listTraceSummariesTool.name).toBe('list_trace_summaries');
  });

  it('has a description', () => {
    expect(listTraceSummariesTool.description).toContain('one row per trace_id');
  });

  it('has inputSchema with type object', () => {
    expect(listTraceSummariesTool.inputSchema.type).toBe('object');
  });

  describe('parameters', () => {
    const props = listTraceSummariesTool.inputSchema.properties as Record<
      string,
      JsonSchemaProperty
    >;

    it('has operation filter parameter', () => {
      expect(props.operation).toBeDefined();
      expect(props.operation!.type).toBe('string');
    });

    it('has trace_id parameter', () => {
      expect(props.trace_id).toBeDefined();
      expect(props.trace_id!.type).toBe('string');
    });

    it('has sort_by parameter', () => {
      expect(props.sort_by).toBeDefined();
      expect(props.sort_by!.enum).toContain('duration_ms');
      expect(props.sort_by!.enum).toContain('cost_usd');
      expect(props.sort_by!.enum).toContain('tokens');
    });

    it('has api_key_ids parameter as array', () => {
      expect(props.api_key_ids).toBeDefined();
      expect(props.api_key_ids!.type).toBe('array');
    });
  });
});

describe('get_trace_spans tool definition', () => {
  const getTraceSpansTool = TOOL_DEFINITIONS.find((t) => t.name === 'get_trace_spans')!;

  it('has correct name', () => {
    expect(getTraceSpansTool.name).toBe('get_trace_spans');
  });

  it('has a description', () => {
    expect(getTraceSpansTool.description).toBeDefined();
    expect(getTraceSpansTool.description!.length).toBeGreaterThan(0);
  });

  it('has inputSchema with type object', () => {
    expect(getTraceSpansTool.inputSchema.type).toBe('object');
  });

  it('requires trace_id parameter', () => {
    expect(getTraceSpansTool.inputSchema.required).toContain('trace_id');
  });

  describe('parameters', () => {
    const props = getTraceSpansTool.inputSchema.properties as Record<string, JsonSchemaProperty>;

    it('has trace_id parameter', () => {
      expect(props.trace_id).toBeDefined();
      expect(props.trace_id!.type).toBe('string');
    });

    it('has expand parameter as array', () => {
      expect(props.expand).toBeDefined();
      expect(props.expand!.type).toBe('array');
    });

    it('expand has valid enum items', () => {
      const expandItems = props.expand!.items as { enum: string[] };
      expect(expandItems.enum).toContain('provider');
      expect(expandItems.enum).toContain('model');
      expect(expandItems.enum).toContain('tokens');
      expect(expandItems.enum).toContain('costs');
      expect(expandItems.enum).toContain('ttft');
      expect(expandItems.enum).toContain('parent');
      expect(expandItems.enum).toContain('url');
      expect(expandItems.enum).toContain('http');
      expect(expandItems.enum).toContain('status_message');
      expect(expandItems.enum).toContain('baggage');
    });

    it('has limit parameter', () => {
      expect(props.limit).toBeDefined();
      expect(props.limit!.type).toBe('number');
      expect(props.limit!.description).toContain('default 20');
    });

    it('has cursor parameter', () => {
      expect(props.cursor).toBeDefined();
      expect(props.cursor!.type).toBe('string');
    });

    it('has span_names parameter as array', () => {
      expect(props.span_names).toBeDefined();
      expect(props.span_names!.type).toBe('array');
      expect(props.span_names!.description).toContain('chat *');
    });

    it('has top_n parameter', () => {
      expect(props.top_n).toBeDefined();
      expect(props.top_n!.type).toBe('number');
    });

    it('has sort_by parameter with enum', () => {
      expect(props.sort_by).toBeDefined();
      expect(props.sort_by!.type).toBe('string');
      expect(props.sort_by!.enum).toContain('duration_ms');
      expect(props.sort_by!.enum).toContain('cost_usd');
      expect(props.sort_by!.enum).toContain('tokens');
    });

    it('has min_duration_ms parameter', () => {
      expect(props.min_duration_ms).toBeDefined();
      expect(props.min_duration_ms!.type).toBe('number');
    });

    it('has exclude_span_names parameter as array', () => {
      expect(props.exclude_span_names).toBeDefined();
      expect(props.exclude_span_names!.type).toBe('array');
    });

    it('has api_key_ids parameter as array', () => {
      expect(props.api_key_ids).toBeDefined();
      expect(props.api_key_ids!.type).toBe('array');
    });
  });
});

describe('get_trace_events tool definition', () => {
  const getTraceEventsTool = TOOL_DEFINITIONS.find((t) => t.name === 'get_trace_events')!;

  it('has correct name', () => {
    expect(getTraceEventsTool.name).toBe('get_trace_events');
  });

  it('has a description', () => {
    expect(getTraceEventsTool.description).toBeDefined();
    expect(getTraceEventsTool.description!.length).toBeGreaterThan(0);
    expect(getTraceEventsTool.description).toContain('without prompt or response bodies');
  });

  it('has inputSchema with type object', () => {
    expect(getTraceEventsTool.inputSchema.type).toBe('object');
  });

  it('requires trace_id parameter', () => {
    expect(getTraceEventsTool.inputSchema.required).toContain('trace_id');
  });

  describe('parameters', () => {
    const props = getTraceEventsTool.inputSchema.properties as Record<string, JsonSchemaProperty>;

    it('has trace_id parameter', () => {
      expect(props.trace_id).toBeDefined();
      expect(props.trace_id!.type).toBe('string');
    });

    it('has span_id parameter', () => {
      expect(props.span_id).toBeDefined();
      expect(props.span_id!.type).toBe('string');
    });

    it('has span_names parameter as array', () => {
      expect(props.span_names).toBeDefined();
      expect(props.span_names!.type).toBe('array');
      expect(props.span_names!.description).toContain('chat *');
    });

    it('has event_names parameter as array', () => {
      expect(props.event_names).toBeDefined();
      expect(props.event_names!.type).toBe('array');
    });

    it('has order parameter with enum', () => {
      expect(props.order).toBeDefined();
      expect(props.order!.type).toBe('string');
      expect(props.order!.enum).toContain('asc');
      expect(props.order!.enum).toContain('desc');
    });

    it('has limit parameter', () => {
      expect(props.limit).toBeDefined();
      expect(props.limit!.type).toBe('number');
    });

    it('has cursor parameter', () => {
      expect(props.cursor).toBeDefined();
      expect(props.cursor!.type).toBe('string');
    });

    it('has api_key_ids parameter as array', () => {
      expect(props.api_key_ids).toBeDefined();
      expect(props.api_key_ids!.type).toBe('array');
    });
  });
});

describe('get_usage_summary tool definition', () => {
  const getUsageSummaryTool = TOOL_DEFINITIONS.find((t) => t.name === 'get_usage_summary')!;

  it('has correct name', () => {
    expect(getUsageSummaryTool.name).toBe('get_usage_summary');
  });

  it('has no required parameters', () => {
    expect(getUsageSummaryTool.inputSchema.required).toBeUndefined();
  });

  it('includes hours, operation, and api_key_ids filters', () => {
    const props = getUsageSummaryTool.inputSchema.properties as Record<string, JsonSchemaProperty>;
    expect(props.hours?.type).toBe('number');
    expect(props.operation?.type).toBe('string');
    expect(props.api_key_ids?.type).toBe('array');
  });
});

describe('list_operation_usage tool definition', () => {
  const listOperationUsageTool = TOOL_DEFINITIONS.find((t) => t.name === 'list_operation_usage')!;

  it('has correct name', () => {
    expect(listOperationUsageTool.name).toBe('list_operation_usage');
  });

  it('documents cost and latency use cases', () => {
    expect(listOperationUsageTool.description).toContain('p95 latency');
    expect(listOperationUsageTool.description).toContain('cache hit rate');
  });

  it('includes limit and filter parameters', () => {
    const props = listOperationUsageTool.inputSchema.properties as Record<
      string,
      JsonSchemaProperty
    >;
    expect(props.limit?.type).toBe('number');
    expect(props.model?.type).toBe('string');
    expect(props.operation?.type).toBe('string');
  });
});

describe('list_model_usage tool definition', () => {
  const listModelUsageTool = TOOL_DEFINITIONS.find((t) => t.name === 'list_model_usage')!;

  it('has correct name', () => {
    expect(listModelUsageTool.name).toBe('list_model_usage');
  });

  it('documents cost efficiency use case', () => {
    expect(listModelUsageTool.description).toContain('cost efficiency');
  });

  it('includes provider, operation, status, and limit filters', () => {
    const props = listModelUsageTool.inputSchema.properties as Record<string, JsonSchemaProperty>;
    expect(props.provider?.type).toBe('string');
    expect(props.operation?.type).toBe('string');
    expect(props.status?.enum).toContain('STATUS_CODE_ERROR');
    expect(props.limit?.type).toBe('number');
  });
});
