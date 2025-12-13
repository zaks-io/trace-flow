import { describe, it, expect } from 'vitest';
import {
  buildGetTraceSQL,
  parseSpanAttributes,
  extractBaggage,
  parseEvents,
  parseSpanRow,
  matchesPattern,
  filterBySpanNames,
  filterByMinDuration,
  excludeBySpanNames,
  generateSummary,
  sortSpans,
  applyTopN,
  paginateSpans,
  buildOutputSpan,
  calculateTraceStats,
  applyFilters,
  type ParsedSpan,
} from '../helpers/getTrace';

describe('buildGetTraceSQL', () => {
  it('builds SQL with trace ID and API keys', () => {
    const sql = buildGetTraceSQL('abc123def456abc123def456abc123de', ['key1', 'key2']);
    expect(sql).toContain("TraceId = 'abc123def456abc123def456abc123de'");
    expect(sql).toContain("ApiKey IN ('key1', 'key2')");
  });

  it('escapes SQL in trace ID', () => {
    const sql = buildGetTraceSQL("test'injection", ['key1']);
    expect(sql).toContain("test''injection");
  });
});

describe('parseSpanAttributes', () => {
  it('parses JSON string', () => {
    const result = parseSpanAttributes('{"key": "value"}');
    expect(result).toEqual({ key: 'value' });
  });

  it('returns object as-is', () => {
    const obj = { key: 'value' };
    const result = parseSpanAttributes(obj);
    expect(result).toEqual(obj);
  });

  it('returns empty object for null', () => {
    const result = parseSpanAttributes(null);
    expect(result).toEqual({});
  });

  it('returns empty object for undefined', () => {
    const result = parseSpanAttributes(undefined);
    expect(result).toEqual({});
  });
});

describe('extractBaggage', () => {
  it('extracts baggage prefixed attributes', () => {
    const attrs = {
      'baggage.userId': 'user123',
      'baggage.sessionId': 'session456',
      'ai.provider': 'openai',
    };
    const result = extractBaggage(attrs);
    expect(result).toEqual({ userId: 'user123', sessionId: 'session456' });
  });

  it('returns undefined for no baggage', () => {
    const attrs = { 'ai.provider': 'openai' };
    const result = extractBaggage(attrs);
    expect(result).toBeUndefined();
  });

  it('converts numbers to strings', () => {
    const attrs = { 'baggage.count': 42 };
    const result = extractBaggage(attrs);
    expect(result).toEqual({ count: '42' });
  });

  it('converts booleans to strings', () => {
    const attrs = { 'baggage.enabled': true };
    const result = extractBaggage(attrs);
    expect(result).toEqual({ enabled: 'true' });
  });
});

describe('parseEvents', () => {
  it('parses events from parallel arrays', () => {
    const timestamps = [1700000000000000000n, 1700000001000000000n];
    const names = ['input.text', 'output.text'];
    const attributes = [
      JSON.stringify({ 'ai.message.role': 'user' }),
      JSON.stringify({ 'ai.content.type': 'text' }),
    ];

    const result = parseEvents(timestamps, names, attributes);
    expect(result).toHaveLength(2);
    expect(result![0].name).toBe('input.text');
    expect(result![0].attributes['ai.message.role']).toBe('user');
    expect(result![1].name).toBe('output.text');
  });

  it('returns undefined for empty names array', () => {
    const result = parseEvents([], [], []);
    expect(result).toBeUndefined();
  });

  it('returns undefined for non-array names', () => {
    const result = parseEvents([], null, []);
    expect(result).toBeUndefined();
  });

  it('handles missing timestamps gracefully', () => {
    const names = ['input.text'];
    const attributes = [JSON.stringify({ role: 'user' })];

    const result = parseEvents([], names, attributes);
    expect(result).toHaveLength(1);
    expect(result![0].name).toBe('input.text');
  });

  it('handles object attributes', () => {
    const names = ['input.text'];
    const attributes = [{ role: 'user' }];

    const result = parseEvents([0], names, attributes);
    expect(result).toHaveLength(1);
    expect(result![0].attributes.role).toBe('user');
  });

  it('handles invalid JSON in attributes', () => {
    const names = ['input.text'];
    const attributes = ['not valid json'];

    const result = parseEvents([0], names, attributes);
    expect(result).toHaveLength(1);
    expect(result![0].attributes).toEqual({});
  });
});

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

  it('parses provider and model', () => {
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

  it('parses events when present', () => {
    const row = {
      ...baseRow,
      EventTimestamps: [1700000000000000000n],
      EventNames: ['input.text'],
      EventAttributes: [JSON.stringify({ 'ai.message.role': 'user' })],
    };
    const result = parseSpanRow(row);
    expect(result.events).toHaveLength(1);
    expect(result.events![0].name).toBe('input.text');
    expect(result.events![0].attributes['ai.message.role']).toBe('user');
  });

  it('returns undefined events when no events', () => {
    const result = parseSpanRow(baseRow);
    expect(result.events).toBeUndefined();
  });
});

describe('matchesPattern', () => {
  it('matches exact name', () => {
    expect(matchesPattern('ai.request', 'ai.request')).toBe(true);
  });

  it('does not match different name', () => {
    expect(matchesPattern('ai.request', 'ai.embedding')).toBe(false);
  });

  it('matches wildcard pattern', () => {
    expect(matchesPattern('ai.request.user', 'ai.request.*')).toBe(true);
    expect(matchesPattern('ai.request.assistant', 'ai.request.*')).toBe(true);
  });

  it('does not match wildcard for different prefix', () => {
    expect(matchesPattern('ai.embedding', 'ai.request.*')).toBe(false);
  });
});

describe('filterBySpanNames', () => {
  const spans: ParsedSpan[] = [
    { name: 'ai.request', span_id: '1' } as ParsedSpan,
    { name: 'ai.request.user', span_id: '2' } as ParsedSpan,
    { name: 'ai.embedding', span_id: '3' } as ParsedSpan,
  ];

  it('returns all spans for empty patterns', () => {
    const result = filterBySpanNames(spans, []);
    expect(result).toHaveLength(3);
  });

  it('filters by exact match', () => {
    const result = filterBySpanNames(spans, ['ai.request']);
    expect(result).toHaveLength(1);
    expect(result[0].span_id).toBe('1');
  });

  it('filters by wildcard', () => {
    const result = filterBySpanNames(spans, ['ai.request.*']);
    expect(result).toHaveLength(1);
    expect(result[0].span_id).toBe('2');
  });

  it('combines multiple patterns with OR', () => {
    const result = filterBySpanNames(spans, ['ai.request', 'ai.embedding']);
    expect(result).toHaveLength(2);
  });
});

describe('filterByMinDuration', () => {
  const spans: ParsedSpan[] = [
    { duration_ms: 10 } as ParsedSpan,
    { duration_ms: 50 } as ParsedSpan,
    { duration_ms: 100 } as ParsedSpan,
  ];

  it('returns all spans for 0 min duration', () => {
    const result = filterByMinDuration(spans, 0);
    expect(result).toHaveLength(3);
  });

  it('filters spans below threshold', () => {
    const result = filterByMinDuration(spans, 50);
    expect(result).toHaveLength(2);
    expect(result[0].duration_ms).toBe(50);
    expect(result[1].duration_ms).toBe(100);
  });
});

describe('excludeBySpanNames', () => {
  const spans: ParsedSpan[] = [
    { name: 'ai.request', span_id: '1' } as ParsedSpan,
    { name: 'ai.request.user', span_id: '2' } as ParsedSpan,
    { name: 'ai.embedding', span_id: '3' } as ParsedSpan,
  ];

  it('returns all spans for empty patterns', () => {
    const result = excludeBySpanNames(spans, []);
    expect(result).toHaveLength(3);
  });

  it('excludes by exact match', () => {
    const result = excludeBySpanNames(spans, ['ai.request']);
    expect(result).toHaveLength(2);
    expect(result.find((s) => s.name === 'ai.request')).toBeUndefined();
  });

  it('excludes by wildcard', () => {
    const result = excludeBySpanNames(spans, ['ai.request.*']);
    expect(result).toHaveLength(2);
    expect(result.find((s) => s.name === 'ai.request.user')).toBeUndefined();
  });
});

describe('generateSummary', () => {
  const spans: ParsedSpan[] = [
    {
      provider: 'openai',
      model: 'gpt-4',
      duration_ms: 100,
      tokens: { total: 150 },
      cost_usd: { total: 0.01 },
    } as ParsedSpan,
    {
      provider: 'openai',
      model: 'gpt-4',
      duration_ms: 200,
      tokens: { total: 250 },
      cost_usd: { total: 0.02 },
    } as ParsedSpan,
    {
      provider: 'anthropic',
      model: 'claude-3',
      duration_ms: 150,
      tokens: { total: 100 },
      cost_usd: { total: 0.015 },
    } as ParsedSpan,
  ];

  it('calculates totals', () => {
    const result = generateSummary(spans);
    expect(result.totals.count).toBe(3);
    expect(result.totals.duration_ms).toBe(450);
    expect(result.totals.tokens).toBe(500);
    expect(result.totals.cost_usd).toBeCloseTo(0.045);
  });

  it('groups by provider', () => {
    const result = generateSummary(spans);
    expect(result.by_provider?.openai.count).toBe(2);
    expect(result.by_provider?.anthropic.count).toBe(1);
  });

  it('groups by model', () => {
    const result = generateSummary(spans);
    expect(result.by_model?.['gpt-4'].count).toBe(2);
    expect(result.by_model?.['claude-3'].count).toBe(1);
  });

  it('returns undefined by_provider for spans without provider', () => {
    const result = generateSummary([{ duration_ms: 100 } as ParsedSpan]);
    expect(result.by_provider).toBeUndefined();
  });
});

describe('sortSpans', () => {
  const spans: ParsedSpan[] = [
    { duration_ms: 100, cost_usd: { total: 0.01 }, tokens: { total: 50 } } as ParsedSpan,
    { duration_ms: 200, cost_usd: { total: 0.02 }, tokens: { total: 100 } } as ParsedSpan,
    { duration_ms: 50, cost_usd: { total: 0.005 }, tokens: { total: 25 } } as ParsedSpan,
  ];

  it('sorts by duration descending by default', () => {
    const result = sortSpans(spans, 'duration_ms');
    expect(result[0].duration_ms).toBe(200);
    expect(result[1].duration_ms).toBe(100);
    expect(result[2].duration_ms).toBe(50);
  });

  it('sorts by cost descending', () => {
    const result = sortSpans(spans, 'cost_usd');
    expect(result[0].cost_usd?.total).toBe(0.02);
  });

  it('sorts by tokens descending', () => {
    const result = sortSpans(spans, 'tokens');
    expect(result[0].tokens?.total).toBe(100);
  });

  it('does not mutate original array', () => {
    const original = [...spans];
    sortSpans(spans, 'duration_ms');
    expect(spans).toEqual(original);
  });
});

describe('applyTopN', () => {
  const spans: ParsedSpan[] = [
    { duration_ms: 100 } as ParsedSpan,
    { duration_ms: 200 } as ParsedSpan,
    { duration_ms: 50 } as ParsedSpan,
    { duration_ms: 150 } as ParsedSpan,
  ];

  it('returns all spans for topN <= 0', () => {
    const result = applyTopN(spans, 0, 'duration_ms');
    expect(result).toHaveLength(4);
  });

  it('returns top N spans sorted', () => {
    const result = applyTopN(spans, 2, 'duration_ms');
    expect(result).toHaveLength(2);
    expect(result[0].duration_ms).toBe(200);
    expect(result[1].duration_ms).toBe(150);
  });
});

describe('paginateSpans', () => {
  const spans = Array.from({ length: 25 }, (_, i) => ({ span_id: String(i) }) as ParsedSpan);

  it('returns first page', () => {
    const result = paginateSpans(spans, 10);
    expect(result.spans).toHaveLength(10);
    expect(result.hasMore).toBe(true);
    expect(result.offset).toBe(0);
  });

  it('returns second page with cursor', () => {
    const result = paginateSpans(spans, 10, '10');
    expect(result.spans).toHaveLength(10);
    expect(result.hasMore).toBe(true);
    expect(result.offset).toBe(10);
  });

  it('returns last page', () => {
    const result = paginateSpans(spans, 10, '20');
    expect(result.spans).toHaveLength(5);
    expect(result.hasMore).toBe(false);
  });

  it('caps limit at max', () => {
    const result = paginateSpans(spans, 200);
    expect(result.spans.length).toBeLessThanOrEqual(100);
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
    events: [
      { name: 'input.text', timestamp: '2024-01-01T00:00:00Z', attributes: { role: 'user' } },
      { name: 'output.text', timestamp: '2024-01-01T00:00:00.5Z', attributes: { type: 'text' } },
    ],
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
  });

  it('includes provider when expanded', () => {
    const result = buildOutputSpan(span, new Set(['provider']));
    expect(result.provider).toBe('openai');
  });

  it('includes model when expanded', () => {
    const result = buildOutputSpan(span, new Set(['model']));
    expect(result.model).toBe('gpt-4');
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

  it('includes baggage when expanded', () => {
    const result = buildOutputSpan(span, new Set(['baggage']));
    expect(result.baggage).toEqual({ userId: 'user123' });
  });

  it('includes events when expanded', () => {
    const result = buildOutputSpan(span, new Set(['events']));
    expect(result.events).toEqual([
      { name: 'input.text', timestamp: '2024-01-01T00:00:00Z', attributes: { role: 'user' } },
      { name: 'output.text', timestamp: '2024-01-01T00:00:00.5Z', attributes: { type: 'text' } },
    ]);
  });

  it('excludes events when not expanded', () => {
    const result = buildOutputSpan(span, new Set());
    expect(result.events).toBeUndefined();
  });
});

describe('calculateTraceStats', () => {
  it('calculates duration from timestamps', () => {
    const spans: ParsedSpan[] = [
      { timestamp: '2024-01-01T00:00:00Z', status: 'ok' } as ParsedSpan,
      { timestamp: '2024-01-01T00:00:01Z', status: 'ok' } as ParsedSpan,
      { timestamp: '2024-01-01T00:00:02Z', status: 'ok' } as ParsedSpan,
    ];
    const result = calculateTraceStats(spans);
    expect(result.duration).toBe(2000);
  });

  it('detects error status', () => {
    const spans: ParsedSpan[] = [
      { timestamp: '2024-01-01T00:00:00Z', status: 'ok' } as ParsedSpan,
      { timestamp: '2024-01-01T00:00:01Z', status: 'error' } as ParsedSpan,
    ];
    const result = calculateTraceStats(spans);
    expect(result.hasError).toBe(true);
  });

  it('returns no error when all ok', () => {
    const spans: ParsedSpan[] = [{ timestamp: '2024-01-01T00:00:00Z', status: 'ok' } as ParsedSpan];
    const result = calculateTraceStats(spans);
    expect(result.hasError).toBe(false);
  });
});

describe('applyFilters', () => {
  const spans: ParsedSpan[] = [
    { name: 'ai.request', duration_ms: 100 } as ParsedSpan,
    { name: 'ai.request.user', duration_ms: 50 } as ParsedSpan,
    { name: 'ai.embedding', duration_ms: 10 } as ParsedSpan,
  ];

  it('applies span_names filter', () => {
    const result = applyFilters(spans, { trace_id: '', span_names: ['ai.request'] });
    expect(result).toHaveLength(1);
  });

  it('applies min_duration_ms filter', () => {
    const result = applyFilters(spans, { trace_id: '', min_duration_ms: 50 });
    expect(result).toHaveLength(2);
  });

  it('applies exclude_span_names filter', () => {
    const result = applyFilters(spans, { trace_id: '', exclude_span_names: ['ai.embedding'] });
    expect(result).toHaveLength(2);
  });

  it('applies multiple filters', () => {
    const result = applyFilters(spans, {
      trace_id: '',
      span_names: ['ai.*'],
      min_duration_ms: 50,
      exclude_span_names: ['ai.request.user'],
    });
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('ai.request');
  });
});
