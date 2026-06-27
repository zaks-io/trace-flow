import { describe, expect, it } from 'vitest';
import { buildTraceflowPythonClient } from '../pythonClient';

const toolDefinitions = [
  {
    name: 'list_api_keys',
    description: 'List available API keys.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_traces',
    description:
      'List recent LLM trace rows. Use this for row-level inspection; prefer aggregates for totals.',
    inputSchema: {
      type: 'object',
      properties: {
        provider: { type: 'string', description: 'Filter by provider' },
        status: {
          type: 'string',
          enum: ['STATUS_CODE_OK', 'STATUS_CODE_ERROR'],
          description: 'Filter by status code',
        },
        expand: {
          type: 'array',
          items: { type: 'string', enum: ['tokens', 'costs'] },
          description: 'Extra fields',
        },
        limit: { type: 'number', description: 'Max rows' },
        hours: { type: 'integer', description: 'Lookback hours' },
        api_key_ids: { type: 'array', items: { type: 'string' } },
        cursor: { type: 'string', description: 'Pagination cursor' },
      },
    },
  },
  {
    name: 'get_trace',
    description: 'Get one trace.',
    inputSchema: {
      type: 'object',
      properties: { trace_id: { type: 'string', description: 'Trace id' } },
      required: ['trace_id'],
    },
  },
];

describe('buildTraceflowPythonClient', () => {
  const source = buildTraceflowPythonClient(toolDefinitions);

  it('emits a runtime base with imports and the client class', () => {
    expect(source).toContain('import pandas as pd');
    expect(source).toContain('from pydantic import BaseModel, ConfigDict, Field');
    expect(source).toContain('class TraceflowData(TraceflowClient):');
    expect(source).toContain('tf = TraceflowData()');
  });

  it('generates one DataFrame method and one raw method per tool', () => {
    for (const name of ['list_api_keys', 'list_traces', 'get_trace']) {
      expect(source).toContain(`def ${name}(self`);
      expect(source).toContain(`def ${name}_raw(self`);
    }
  });

  it('maps JSON Schema types to Python type hints', () => {
    expect(source).toContain('provider: str | None = None');
    expect(source).toContain('limit: float | None = None');
    expect(source).toContain('hours: int | None = None');
    expect(source).toContain('api_key_ids: list[str] | None = None');
  });

  it('orders required params before optional ones, with refresh last', () => {
    expect(source).toContain('def get_trace(self, *, trace_id: str, refresh: bool = False) ->');
  });

  it('appends a keyword-only refresh flag to every method (even zero-arg tools)', () => {
    expect(source).toContain('def list_api_keys(self, *, refresh: bool = False) ->');
  });

  it('builds a pydantic args model per tool with extra=forbid', () => {
    expect(source).toContain('class ListTracesArgs(BaseModel):');
    expect(source).toContain('model_config = ConfigDict(extra="forbid")');
  });

  it('threads refresh into the cached call helpers', () => {
    expect(source).toContain('return self._call_df("list_traces", args, refresh=refresh)');
    expect(source).toContain('return self._call_raw("list_traces", args, refresh=refresh)');
  });

  it('emits a per-run disk cache with a 5 minute TTL', () => {
    expect(source).toContain('_CACHE_TTL_SECONDS = 300');
    expect(source).toContain('def _cache_read(key: str)');
    expect(source).toContain('def _cache_write(key: str, data: Any)');
  });

  it('follows the real pagination envelope (pagination.has_more / next_cursor)', () => {
    expect(source).toContain('pagination.get("has_more")');
    expect(source).toContain('pagination.get("next_cursor")');
  });

  // Docstrings are word-wrapped, so assert against whitespace-collapsed text.
  const flat = source.replace(/\s+/g, ' ');

  it('documents each method with the full description and when-to-use guidance', () => {
    expect(flat).toContain('Use this for row-level inspection; prefer aggregates for totals.');
    expect(source).toContain('Args:');
    expect(source).toContain('Returns:');
    expect(source).toContain('Caching:');
  });

  it('surfaces enum choices inline in the docstring (scalar and array-of-enum)', () => {
    expect(flat).toContain('One of: STATUS_CODE_OK, STATUS_CODE_ERROR.');
    expect(flat).toContain('One of: tokens, costs.');
  });

  it('emits a scannable method index with one-line guidance per tool', () => {
    expect(source).toContain('# Available methods');
    expect(source).toContain('#   tf.list_traces: List recent LLM trace rows.');
    expect(source).toContain('#   tf.get_trace: Get one trace.');
  });

  it('skips malformed definitions without throwing', () => {
    const mixed = buildTraceflowPythonClient([
      null,
      'nope',
      { name: '' },
      { name: 'has space' },
      { name: 'valid_tool', description: 'ok', inputSchema: { type: 'object', properties: {} } },
    ] as unknown[]);
    expect(mixed).toContain('def valid_tool(self');
    expect(mixed).not.toContain('has space');
  });

  it('produces a class body even when no tools are valid', () => {
    const empty = buildTraceflowPythonClient([]);
    expect(empty).toContain('class TraceflowData(TraceflowClient):');
    expect(empty).toContain('pass');
  });
});
