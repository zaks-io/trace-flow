import { describe, it, expect } from 'vitest';
import { parseSpanRow, buildOutputSpan, type ParsedSpan } from '../helpers/getTrace';

describe('parseSpanRow', () => {
  const baseRow = {
    ReceivedAt: 1700000000000000000n,
    Timestamp: 1700000000000000000n,
    TraceId: 'trace123',
    SpanId: 'span123',
    ParentSpanId: 'parent123',
    SpanName: 'ai.request',
    Duration: 150000000,
    StatusCode: 'STATUS_CODE_OK',
    StatusMessage: '',
    SpanAttributes: JSON.stringify({
      'ai.provider': 'openai',
      'ai.model': 'gpt-4',
      'ai.tokens.prompt': 100,
      'ai.tokens.completion': 50,
      'ai.tokens.total': 150,
      'ai.cost.input': 0.001,
      'ai.cost.output': 0.002,
      'ai.cost.total': 0.003,
    }),
    EventTimestamps: [],
    EventNames: [],
    EventAttributes: [],
  };

  it('parses basic span fields', () => {
    const result = parseSpanRow(baseRow);
    expect(result.span_id).toBe('span123');
    expect(result.name).toBe('ai.request');
    expect(result.status).toBe('ok');
    expect(result.duration_ms).toBe(150);
  });

  it('parses parent span ID', () => {
    const result = parseSpanRow(baseRow);
    expect(result.parent_span_id).toBe('parent123');
  });

  it('parses provider and model from attributes', () => {
    const result = parseSpanRow(baseRow);
    expect(result.provider).toBe('openai');
    expect(result.model).toBe('gpt-4');
  });

  it('parses tokens', () => {
    const result = parseSpanRow(baseRow);
    expect(result.tokens).toEqual({
      prompt: 100,
      completion: 50,
      total: 150,
      cached: 0,
      reasoning: 0,
    });
  });

  it('parses costs', () => {
    const result = parseSpanRow(baseRow);
    expect(result.cost_usd).toEqual({
      input: 0.001,
      output: 0.002,
      total: 0.003,
    });
  });

  it('returns undefined tokens when no token data', () => {
    const row = { ...baseRow, SpanAttributes: '{}' };
    const result = parseSpanRow(row);
    expect(result.tokens).toBeUndefined();
  });

  it('returns undefined cost when no cost data', () => {
    const row = { ...baseRow, SpanAttributes: '{}' };
    const result = parseSpanRow(row);
    expect(result.cost_usd).toBeUndefined();
  });

  it('converts error status code', () => {
    const row = { ...baseRow, StatusCode: 'STATUS_CODE_ERROR' };
    const result = parseSpanRow(row);
    expect(result.status).toBe('error');
  });

  it('extracts baggage attributes', () => {
    const row = {
      ...baseRow,
      SpanAttributes: JSON.stringify({
        'baggage.userId': 'user123',
        'baggage.sessionId': 'session456',
        'ai.provider': 'openai',
      }),
    };
    const result = parseSpanRow(row);
    expect(result.baggage).toEqual({ userId: 'user123', sessionId: 'session456' });
  });

  it('handles object attributes (not just JSON string)', () => {
    const row = {
      ...baseRow,
      SpanAttributes: {
        'ai.provider': 'anthropic',
        'ai.model': 'claude-3',
      },
    };
    const result = parseSpanRow(row);
    expect(result.provider).toBe('anthropic');
    expect(result.model).toBe('claude-3');
  });
});

describe('buildOutputSpan', () => {
  const span: ParsedSpan = {
    span_id: '123',
    parent_span_id: 'parent123',
    name: 'ai.request',
    timestamp: '2024-01-01T00:00:00Z',
    duration_ms: 100,
    status: 'ok',
    status_message: 'Success',
    provider: 'openai',
    model: 'gpt-4',
    target_url: 'https://api.openai.com',
    http_status: '200',
    tokens: { prompt: 10, completion: 5, total: 15, cached: 0, reasoning: 0 },
    cost_usd: { input: 0.001, output: 0.002, total: 0.003 },
    time_to_first_token_ms: 50,
    baggage: { userId: 'user123' },
  };

  it('includes base fields by default', () => {
    const result = buildOutputSpan(span, new Set());
    expect(result.span_id).toBe('123');
    expect(result.name).toBe('ai.request');
    expect(result.duration_ms).toBe(100);
    expect(result.status).toBe('ok');
    expect(result.timestamp).toBeDefined();
  });

  it('excludes optional fields when not expanded', () => {
    const result = buildOutputSpan(span, new Set());
    expect(result.provider).toBeUndefined();
    expect(result.model).toBeUndefined();
    expect(result.tokens).toBeUndefined();
    expect(result.cost_usd).toBeUndefined();
    expect(result.baggage).toBeUndefined();
  });

  it('includes parent when expanded', () => {
    const result = buildOutputSpan(span, new Set(['parent']));
    expect(result.parent_span_id).toBe('parent123');
  });

  it('includes status_message when expanded', () => {
    const result = buildOutputSpan(span, new Set(['status_message']));
    expect(result.status_message).toBe('Success');
  });

  it('includes provider when expanded', () => {
    const result = buildOutputSpan(span, new Set(['provider']));
    expect(result.provider).toBe('openai');
  });

  it('includes model when expanded', () => {
    const result = buildOutputSpan(span, new Set(['model']));
    expect(result.model).toBe('gpt-4');
  });

  it('includes url when expanded', () => {
    const result = buildOutputSpan(span, new Set(['url']));
    expect(result.target_url).toBe('https://api.openai.com');
  });

  it('includes http status when expanded', () => {
    const result = buildOutputSpan(span, new Set(['http']));
    expect(result.http_status).toBe('200');
  });

  it('includes tokens when expanded', () => {
    const result = buildOutputSpan(span, new Set(['tokens']));
    expect(result.tokens).toEqual({
      prompt: 10,
      completion: 5,
      total: 15,
      cached: 0,
      reasoning: 0,
    });
  });

  it('includes costs when expanded', () => {
    const result = buildOutputSpan(span, new Set(['costs']));
    expect(result.cost_usd).toEqual({ input: 0.001, output: 0.002, total: 0.003 });
  });

  it('includes ttft when expanded', () => {
    const result = buildOutputSpan(span, new Set(['ttft']));
    expect(result.time_to_first_token_ms).toBe(50);
  });

  it('includes baggage when expanded', () => {
    const result = buildOutputSpan(span, new Set(['baggage']));
    expect(result.baggage).toEqual({ userId: 'user123' });
  });

  it('includes multiple expanded fields', () => {
    const result = buildOutputSpan(span, new Set(['provider', 'model', 'tokens']));
    expect(result.provider).toBe('openai');
    expect(result.model).toBe('gpt-4');
    expect(result.tokens).toBeDefined();
    expect(result.cost_usd).toBeUndefined();
  });

  it('does not include optional fields when value is undefined', () => {
    const spanWithoutOptionals: ParsedSpan = {
      span_id: '123',
      parent_span_id: undefined,
      name: 'test',
      timestamp: '2024-01-01T00:00:00Z',
      duration_ms: 100,
      status: 'ok',
      status_message: undefined,
      provider: undefined,
      model: undefined,
      target_url: undefined,
      http_status: undefined,
      tokens: undefined,
      cost_usd: undefined,
      time_to_first_token_ms: undefined,
      baggage: undefined,
    };

    const result = buildOutputSpan(spanWithoutOptionals, new Set(['provider', 'model', 'tokens']));
    expect(result.provider).toBeUndefined();
    expect(result.model).toBeUndefined();
    expect(result.tokens).toBeUndefined();
  });
});
