import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearBodyAccessTokenCache,
  fetchStoredBodies,
  formatStoredBodiesForDisplay,
  getBodyAccessToken,
} from '../bodies';

function tokenResult(token: string, expiresInMs = 60_000): { token: string; expiresAt: number } {
  return {
    token,
    expiresAt: Math.floor((Date.now() + expiresInMs) / 1000),
  };
}

describe('body helpers', () => {
  beforeEach(() => {
    clearBodyAccessTokenCache();
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
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
    vi.stubEnv('NEXT_PUBLIC_RAW_API_URL', undefined);
    vi.stubEnv('NEXT_PUBLIC_API_URL', undefined);
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

  it('uses NEXT_PUBLIC_RAW_API_URL for Body Object reads when configured', async () => {
    vi.stubEnv('NEXT_PUBLIC_RAW_API_URL', 'https://raw.trace-flow.dev');
    vi.stubEnv('NEXT_PUBLIC_API_URL', 'https://legacy-api.trace-flow.dev');
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ requestBody: null, responseBody: null }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await fetchStoredBodies('req_123', 'token_123', new AbortController().signal);

    expect(fetch).toHaveBeenCalledWith('https://raw.trace-flow.dev/bodies/req_123', {
      headers: { Authorization: 'Bearer token_123' },
      signal: expect.any(AbortSignal),
    });
  });

  it('falls back to NEXT_PUBLIC_API_URL for Body Object reads', async () => {
    vi.stubEnv('NEXT_PUBLIC_RAW_API_URL', undefined);
    vi.stubEnv('NEXT_PUBLIC_API_URL', 'https://legacy-api.trace-flow.dev');
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ requestBody: null, responseBody: null }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await fetchStoredBodies('req_123', 'token_123', new AbortController().signal);

    expect(fetch).toHaveBeenCalledWith('https://legacy-api.trace-flow.dev/bodies/req_123', {
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

  it('returns null on 403 for legacy objects without org metadata', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ error: 'Forbidden' }), {
        status: 403,
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

  it('coalesces concurrent token requests for the same body', async () => {
    let resolveToken: (value: { token: string; expiresAt: number }) => void = () => {};
    const tokenPromise = new Promise<{ token: string; expiresAt: number }>((resolve) => {
      resolveToken = resolve;
    });
    const issueBodyToken = vi.fn(() => tokenPromise);

    const first = getBodyAccessToken('req_123', issueBodyToken);
    const second = getBodyAccessToken('req_123', issueBodyToken);

    expect(issueBodyToken).toHaveBeenCalledTimes(1);

    resolveToken(tokenResult('shared-body-jwt'));

    await expect(Promise.all([first, second])).resolves.toEqual([
      'shared-body-jwt',
      'shared-body-jwt',
    ]);
  });

  it('reuses a cached token outside the refresh window', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-28T00:00:00Z'));
    const issueBodyToken = vi.fn().mockResolvedValue(tokenResult('cached-body-jwt', 60_000));

    await expect(getBodyAccessToken('req_123', issueBodyToken)).resolves.toBe('cached-body-jwt');
    await expect(getBodyAccessToken('req_123', issueBodyToken)).resolves.toBe('cached-body-jwt');

    expect(issueBodyToken).toHaveBeenCalledTimes(1);
  });

  it('keeps body tokens scoped by request ID', async () => {
    const issueBodyToken = vi.fn(({ requestId }: { requestId: string }) =>
      Promise.resolve(tokenResult(`token-${requestId}`, 60_000)),
    );

    await expect(getBodyAccessToken('req_a', issueBodyToken)).resolves.toBe('token-req_a');
    await expect(getBodyAccessToken('req_b', issueBodyToken)).resolves.toBe('token-req_b');

    expect(issueBodyToken).toHaveBeenCalledTimes(2);
  });

  it('caps cached body tokens and evicts the oldest request', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-28T00:00:00Z'));
    let tokenIndex = 0;
    const issueBodyToken = vi.fn(({ requestId }: { requestId: string }) => {
      tokenIndex += 1;
      return Promise.resolve(tokenResult(`token-${requestId}-${tokenIndex}`, 60_000));
    });

    for (let index = 0; index < 101; index += 1) {
      await getBodyAccessToken(`req_${index}`, issueBodyToken);
    }

    await expect(getBodyAccessToken('req_0', issueBodyToken)).resolves.toBe('token-req_0-102');
    expect(issueBodyToken).toHaveBeenCalledTimes(102);
  });

  it('mints a new body token near expiry', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-28T00:00:00Z'));
    const issueBodyToken = vi
      .fn()
      .mockResolvedValueOnce(tokenResult('first-body-jwt', 10_000))
      .mockResolvedValueOnce(tokenResult('fresh-body-jwt', 60_000));

    await expect(getBodyAccessToken('req_123', issueBodyToken)).resolves.toBe('first-body-jwt');

    vi.setSystemTime(new Date('2026-06-28T00:00:06Z'));

    await expect(getBodyAccessToken('req_123', issueBodyToken)).resolves.toBe('fresh-body-jwt');
    expect(issueBodyToken).toHaveBeenCalledTimes(2);
  });
});
