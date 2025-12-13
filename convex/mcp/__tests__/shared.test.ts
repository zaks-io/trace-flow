import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  TRACE_ID_PATTERN,
  queryTinybird,
  generateTinybirdToken,
  noApiKeysError,
  invalidTraceIdError,
  traceNotFoundError,
} from '../tools/shared';

describe('TRACE_ID_PATTERN', () => {
  it('matches valid 32-character lowercase hex string', () => {
    expect(TRACE_ID_PATTERN.test('abcdef0123456789abcdef0123456789')).toBe(true);
  });

  it('matches valid 32-character uppercase hex string', () => {
    expect(TRACE_ID_PATTERN.test('ABCDEF0123456789ABCDEF0123456789')).toBe(true);
  });

  it('matches valid 32-character mixed case hex string', () => {
    expect(TRACE_ID_PATTERN.test('AbCdEf0123456789aBcDeF0123456789')).toBe(true);
  });

  it('rejects string shorter than 32 characters', () => {
    expect(TRACE_ID_PATTERN.test('abcdef0123456789')).toBe(false);
  });

  it('rejects string longer than 32 characters', () => {
    expect(TRACE_ID_PATTERN.test('abcdef0123456789abcdef0123456789extra')).toBe(false);
  });

  it('rejects non-hex characters', () => {
    expect(TRACE_ID_PATTERN.test('ghijkl0123456789ghijkl0123456789')).toBe(false);
  });

  it('rejects empty string', () => {
    expect(TRACE_ID_PATTERN.test('')).toBe(false);
  });
});

describe('noApiKeysError', () => {
  it('returns error with isError true', () => {
    const result = noApiKeysError();
    expect(result.isError).toBe(true);
  });

  it('returns text content about no API keys', () => {
    const result = noApiKeysError();
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
    expect(result.content[0].text).toContain('No API keys');
  });
});

describe('invalidTraceIdError', () => {
  it('returns error with isError true', () => {
    const result = invalidTraceIdError();
    expect(result.isError).toBe(true);
  });

  it('returns text content about invalid trace ID', () => {
    const result = invalidTraceIdError();
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
    expect(result.content[0].text).toContain('Invalid trace ID');
    expect(result.content[0].text).toContain('32-character hex');
  });
});

describe('traceNotFoundError', () => {
  it('returns error with isError true', () => {
    const result = traceNotFoundError('abc123');
    expect(result.isError).toBe(true);
  });

  it('includes trace ID in error message', () => {
    const traceId = 'abcdef0123456789abcdef0123456789';
    const result = traceNotFoundError(traceId);
    expect(result.content[0].text).toContain(traceId);
  });

  it('returns text content about trace not found', () => {
    const result = traceNotFoundError('test123');
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
    expect(result.content[0].text).toContain('Trace not found');
  });
});

describe('queryTinybird', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.stubEnv('TINYBIRD_API_URL', 'https://api.tinybird.co');
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.unstubAllEnvs();
  });

  it('returns data from successful response', async () => {
    const mockData = [{ TraceId: 'abc123', Duration: 100 }];
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: mockData }),
    });

    const result = await queryTinybird('token', 'SELECT * FROM traces');
    expect(result).toEqual(mockData);
  });

  it('returns empty array when data is undefined', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({}),
    });

    const result = await queryTinybird('token', 'SELECT * FROM traces');
    expect(result).toEqual([]);
  });

  it('throws error for non-200 response', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: () => Promise.resolve('Unauthorized'),
    });

    await expect(queryTinybird('invalid-token', 'SELECT * FROM traces')).rejects.toThrow(
      'TinyBird query failed: 401',
    );
  });

  it('includes SQL query in URL params', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: [] }),
    });

    const sql = 'SELECT * FROM otel_traces LIMIT 10';
    await queryTinybird('token', sql);

    expect(globalThis.fetch).toHaveBeenCalledWith(expect.stringContaining('q=SELECT'), {
      headers: { Authorization: 'Bearer token' },
    });
  });

  it('uses custom API URL from environment', async () => {
    vi.stubEnv('TINYBIRD_API_URL', 'https://custom.tinybird.co');
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: [] }),
    });

    await queryTinybird('token', 'SELECT 1');

    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining('https://custom.tinybird.co'),
      expect.any(Object),
    );
  });
});

describe('generateTinybirdToken', () => {
  const testApiKeys = ['api-key-1', 'api-key-2'];

  beforeEach(() => {
    vi.stubEnv('TINYBIRD_ADMIN_TOKEN', 'admin-token-secret');
    vi.stubEnv('TINYBIRD_WORKSPACE_ID', 'workspace-123');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('throws error when admin token is missing', async () => {
    vi.stubEnv('TINYBIRD_ADMIN_TOKEN', '');
    await expect(
      generateTinybirdToken([{ type: 'PIPES:READ', resource: 'otel_traces' }], testApiKeys),
    ).rejects.toThrow('Tinybird credentials not configured');
  });

  it('throws error when workspace ID is missing', async () => {
    vi.stubEnv('TINYBIRD_WORKSPACE_ID', '');
    await expect(
      generateTinybirdToken([{ type: 'PIPES:READ', resource: 'otel_traces' }], testApiKeys),
    ).rejects.toThrow('Tinybird credentials not configured');
  });

  it('generates a valid JWT string', async () => {
    const token = await generateTinybirdToken(
      [{ type: 'PIPES:READ', resource: 'otel_traces' }],
      testApiKeys,
    );
    expect(typeof token).toBe('string');
    expect(token.split('.')).toHaveLength(3);
  });

  it('accepts custom TTL', async () => {
    const token = await generateTinybirdToken(
      [{ type: 'PIPES:READ', resource: 'otel_traces' }],
      testApiKeys,
      300,
    );
    expect(typeof token).toBe('string');
  });

  it('works with empty api keys array', async () => {
    const token = await generateTinybirdToken(
      [{ type: 'PIPES:READ', resource: 'otel_traces' }],
      [],
    );
    expect(typeof token).toBe('string');
    expect(token.split('.')).toHaveLength(3);
  });
});
