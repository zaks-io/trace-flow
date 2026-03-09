import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchStoredBodies, formatStoredBodiesForDisplay } from '../bodies';

describe('body helpers', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('formats combined stored bodies for display', () => {
    const result = formatStoredBodiesForDisplay({
      requestBody: '{"model":"gpt-4"}',
      responseBody: 'data: {"delta":"hello"}\n\n',
      truncated: true,
    });

    expect(result.requestBody?.format).toBe('json');
    expect(result.responseBody?.format).toBe('sse');
    expect(result.truncated).toBe(true);
  });

  it('returns null when the combined body payload is missing', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(null, {
        status: 404,
      }),
    );

    const result = await fetchStoredBodies('req_123', 'token_123', new AbortController().signal);

    expect(result).toBeNull();
    expect(fetch).toHaveBeenCalledWith('http://localhost:8788/bodies/req_123', {
      headers: { Authorization: 'Bearer token_123' },
      signal: expect.any(AbortSignal),
    });
  });

  it('returns null when bodies are expired (410)', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ error: 'Bodies expired under current retention policy' }), {
        status: 410,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const result = await fetchStoredBodies('req_123', 'token_123', new AbortController().signal);

    expect(result).toBeNull();
  });

  it('returns the combined body payload on success', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          requestBody: '{"prompt":"hi"}',
          responseBody: '{"output":"hello"}',
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    );

    const result = await fetchStoredBodies('req_123', 'token_123', new AbortController().signal);

    expect(result).toEqual({
      requestBody: '{"prompt":"hi"}',
      responseBody: '{"output":"hello"}',
    });
  });
});
