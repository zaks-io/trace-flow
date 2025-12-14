import { describe, it, expect } from 'vitest';
import { formatTraceRow, type TraceRow } from '../tools/listTraces';

describe('formatTraceRow', () => {
  const baseRow: TraceRow = {
    trace_id: 'abcdef0123456789abcdef0123456789',
    timestamp: '2024-01-15T10:30:00Z',
    duration_ms: 150,
    status: 'ok',
    provider: 'openai',
    model: 'gpt-4',
    prompt_tokens: 100,
    completion_tokens: 50,
    total_tokens: 150,
    cost_usd: 0.003,
    total_count: 1,
  };

  it('maps all required fields', () => {
    const result = formatTraceRow(baseRow);
    expect(result.trace_id).toBe('abcdef0123456789abcdef0123456789');
    expect(result.timestamp).toBe('2024-01-15T10:30:00Z');
    expect(result.duration_ms).toBe(150);
    expect(result.status).toBe('ok');
    expect(result.provider).toBe('openai');
    expect(result.model).toBe('gpt-4');
  });

  it('includes tokens when values are greater than 0', () => {
    const result = formatTraceRow(baseRow);
    expect(result.tokens).toEqual({
      prompt: 100,
      completion: 50,
      total: 150,
    });
  });

  it('excludes tokens when all values are 0', () => {
    const row: TraceRow = {
      ...baseRow,
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    };
    const result = formatTraceRow(row);
    expect(result.tokens).toBeUndefined();
  });

  it('includes only non-zero token values', () => {
    const row: TraceRow = {
      ...baseRow,
      prompt_tokens: 100,
      completion_tokens: 0,
      total_tokens: 100,
    };
    const result = formatTraceRow(row);
    expect(result.tokens).toEqual({
      prompt: 100,
      total: 100,
    });
  });

  it('includes cost_usd when greater than 0', () => {
    const result = formatTraceRow(baseRow);
    expect(result.cost_usd).toBe(0.003);
  });

  it('excludes cost_usd when 0', () => {
    const row: TraceRow = { ...baseRow, cost_usd: 0 };
    const result = formatTraceRow(row);
    expect(result.cost_usd).toBeUndefined();
  });

  it('handles negative cost (should still be excluded)', () => {
    const row: TraceRow = { ...baseRow, cost_usd: -0.001 };
    const result = formatTraceRow(row);
    expect(result.cost_usd).toBeUndefined();
  });
});
