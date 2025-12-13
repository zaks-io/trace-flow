import { describe, it, expect } from 'vitest';
import {
  normalizeParams,
  buildListTracesConditions,
  buildListTracesSQL,
  formatTraceRow,
  buildListTracesResult,
} from '../helpers/listTraces';

describe('normalizeParams', () => {
  it('returns defaults when no params provided', () => {
    const result = normalizeParams({});
    expect(result).toEqual({ limit: 10, hours: 24, offset: 0 });
  });

  it('respects provided limit within max', () => {
    const result = normalizeParams({ limit: 15 });
    expect(result.limit).toBe(15);
  });

  it('caps limit at max', () => {
    const result = normalizeParams({ limit: 100 });
    expect(result.limit).toBe(25);
  });

  it('respects provided hours within max', () => {
    const result = normalizeParams({ hours: 48 });
    expect(result.hours).toBe(48);
  });

  it('caps hours at max', () => {
    const result = normalizeParams({ hours: 500 });
    expect(result.hours).toBe(168);
  });

  it('parses cursor to offset', () => {
    const result = normalizeParams({ cursor: '20' });
    expect(result.offset).toBe(20);
  });

  it('returns 0 offset for invalid cursor', () => {
    const result = normalizeParams({ cursor: 'invalid' });
    expect(result.offset).toBe(0);
  });
});

describe('buildListTracesConditions', () => {
  const apiKeys = ['key1', 'key2'];
  const startTimeNs = 1000000000;

  it('includes base conditions', () => {
    const conditions = buildListTracesConditions(apiKeys, {}, startTimeNs);
    expect(conditions).toContain("SpanName = 'ai.request'");
    expect(conditions).toContain(`ReceivedAt >= ${startTimeNs}`);
    expect(conditions.some((c) => c.includes('ApiKey IN'))).toBe(true);
  });

  it('adds provider filter when specified', () => {
    const conditions = buildListTracesConditions(apiKeys, { provider: 'openai' }, startTimeNs);
    expect(conditions.some((c) => c.includes("'openai'"))).toBe(true);
  });

  it('adds model filter when specified', () => {
    const conditions = buildListTracesConditions(apiKeys, { model: 'gpt-4' }, startTimeNs);
    expect(conditions.some((c) => c.includes("'gpt-4'"))).toBe(true);
  });

  it('adds status filter when specified', () => {
    const conditions = buildListTracesConditions(
      apiKeys,
      { status: 'STATUS_CODE_OK' },
      startTimeNs,
    );
    expect(conditions.some((c) => c.includes('STATUS_CODE_OK'))).toBe(true);
  });

  it('escapes SQL in filter values', () => {
    const conditions = buildListTracesConditions(apiKeys, { provider: "test'sql" }, startTimeNs);
    expect(conditions.some((c) => c.includes("test''sql"))).toBe(true);
  });
});

describe('buildListTracesSQL', () => {
  it('builds SQL with conditions', () => {
    const conditions = ["SpanName = 'ai.request'", "ApiKey IN ('key1')"];
    const sql = buildListTracesSQL(conditions, 10, 0);
    expect(sql).toContain('SELECT');
    expect(sql).toContain('FROM otel_traces');
    expect(sql).toContain("SpanName = 'ai.request'");
    expect(sql).toContain('LIMIT 11');
    expect(sql).not.toContain('OFFSET');
  });

  it('includes offset when provided', () => {
    const conditions = ["SpanName = 'ai.request'"];
    const sql = buildListTracesSQL(conditions, 10, 20);
    expect(sql).toContain('OFFSET 20');
  });
});

describe('formatTraceRow', () => {
  it('formats a trace row correctly', () => {
    const row = {
      TraceId: 'abc123',
      ReceivedAt: 1700000000000000000n,
      duration_ms: 150,
      StatusCode: 'STATUS_CODE_OK',
      provider: 'openai',
      model: 'gpt-4',
      prompt_tokens: 100,
      completion_tokens: 50,
      total_tokens: 150,
      cost_usd: 0.001,
    };

    const result = formatTraceRow(row);
    expect(result.trace_id).toBe('abc123');
    expect(result.status).toBe('ok');
    expect(result.provider).toBe('openai');
    expect(result.tokens.total).toBe(150);
  });

  it('formats error status correctly', () => {
    const row = {
      TraceId: 'abc123',
      ReceivedAt: 1700000000000000000n,
      duration_ms: 150,
      StatusCode: 'STATUS_CODE_ERROR',
      provider: 'openai',
      model: 'gpt-4',
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
      cost_usd: 0,
    };

    const result = formatTraceRow(row);
    expect(result.status).toBe('error');
  });
});

describe('buildListTracesResult', () => {
  const makeRow = (id: string) => ({
    TraceId: id,
    ReceivedAt: 1700000000000000000n,
    duration_ms: 100,
    StatusCode: 'STATUS_CODE_OK',
    provider: 'openai',
    model: 'gpt-4',
    prompt_tokens: 10,
    completion_tokens: 5,
    total_tokens: 15,
    cost_usd: 0.001,
  });

  it('returns hasMore false when data <= limit', () => {
    const data = [makeRow('1'), makeRow('2')];
    const result = buildListTracesResult(data, 10, 0);
    expect(result.pagination.has_more).toBe(false);
    expect(result.pagination.next_cursor).toBeUndefined();
    expect(result.traces).toHaveLength(2);
  });

  it('returns hasMore true when data > limit', () => {
    const data = Array.from({ length: 11 }, (_, i) => makeRow(String(i)));
    const result = buildListTracesResult(data, 10, 0);
    expect(result.pagination.has_more).toBe(true);
    expect(result.pagination.next_cursor).toBe('10');
    expect(result.traces).toHaveLength(10);
  });

  it('calculates next cursor with offset', () => {
    const data = Array.from({ length: 11 }, (_, i) => makeRow(String(i)));
    const result = buildListTracesResult(data, 10, 20);
    expect(result.pagination.next_cursor).toBe('30');
  });
});
