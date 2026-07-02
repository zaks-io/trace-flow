import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchPipe, TinybirdAuthError } from '@trace-flow/tinybird-client';
import { clearTokenCache, fetchTinybirdPipe } from '../tinybird';

vi.mock('@trace-flow/tinybird-client', () => ({
  fetchPipe: vi.fn(async () => []),
  TinybirdAuthError: class TinybirdAuthError extends Error {},
}));

const mockFetchPipe = vi.mocked(fetchPipe);

function tokenResult(token: string, expiresInMs = 60_000): { token: string; expiresAt: number } {
  return {
    token,
    expiresAt: Math.floor((Date.now() + expiresInMs) / 1000),
  };
}

describe('fetchTinybirdPipe', () => {
  beforeEach(() => {
    clearTokenCache();
    mockFetchPipe.mockReset();
    mockFetchPipe.mockResolvedValue([]);
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it('coalesces concurrent token requests for different pipes', async () => {
    let resolveToken: (value: { token: string; expiresAt: number }) => void = () => {};
    const tokenPromise = new Promise<{ token: string; expiresAt: number }>((resolve) => {
      resolveToken = resolve;
    });
    const generateWebReadToken = vi.fn(() => tokenPromise);

    const first = fetchTinybirdPipe({
      pipe: 'agent_usage_timeseries',
      params: { start_time_ms: 1 },
      generateWebReadToken,
    });
    const second = fetchTinybirdPipe({
      pipe: 'agent_usage_summary',
      params: { start_time_ms: 2 },
      generateWebReadToken,
    });

    expect(generateWebReadToken).toHaveBeenCalledTimes(1);

    resolveToken(tokenResult('shared-jwt'));
    await Promise.all([first, second]);

    expect(mockFetchPipe).toHaveBeenCalledTimes(2);
    expect(mockFetchPipe).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ pipe: 'agent_usage_timeseries', token: 'shared-jwt' }),
    );
    expect(mockFetchPipe).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ pipe: 'agent_usage_summary', token: 'shared-jwt' }),
    );
  });

  it('coalesces concurrent token requests for the same pipe', async () => {
    let resolveToken: (value: { token: string; expiresAt: number }) => void = () => {};
    const tokenPromise = new Promise<{ token: string; expiresAt: number }>((resolve) => {
      resolveToken = resolve;
    });
    const generateWebReadToken = vi.fn(() => tokenPromise);

    const first = fetchTinybirdPipe({
      pipe: 'agent_usage_timeseries',
      params: { start_time_ms: 1 },
      generateWebReadToken,
    });
    const second = fetchTinybirdPipe({
      pipe: 'agent_usage_timeseries',
      params: { start_time_ms: 2 },
      generateWebReadToken,
    });

    expect(generateWebReadToken).toHaveBeenCalledTimes(1);

    resolveToken(tokenResult('shared-jwt'));
    await Promise.all([first, second]);

    expect(mockFetchPipe).toHaveBeenCalledTimes(2);
    expect(mockFetchPipe).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ pipe: 'agent_usage_timeseries', token: 'shared-jwt' }),
    );
    expect(mockFetchPipe).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ pipe: 'agent_usage_timeseries', token: 'shared-jwt' }),
    );
  });

  it('reuses a cached token outside the refresh window', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-16T00:00:00Z'));

    const generateWebReadToken = vi.fn().mockResolvedValue(tokenResult('cached-jwt', 60_000));

    await fetchTinybirdPipe({
      pipe: 'agent_usage_timeseries',
      generateWebReadToken,
    });
    await fetchTinybirdPipe({
      pipe: 'llm_usage_summary',
      generateWebReadToken,
    });

    expect(generateWebReadToken).toHaveBeenCalledTimes(1);
    expect(mockFetchPipe).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ pipe: 'llm_usage_summary', token: 'cached-jwt' }),
    );
  });

  it('mints a new token when the cached token is near expiry', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-16T00:00:00Z'));

    const generateWebReadToken = vi
      .fn()
      .mockResolvedValueOnce(tokenResult('first-jwt', 40_000))
      .mockResolvedValueOnce(tokenResult('refreshed-jwt', 60_000));

    await fetchTinybirdPipe({
      pipe: 'agent_usage_timeseries',
      generateWebReadToken,
    });

    vi.setSystemTime(new Date('2026-06-16T00:00:11Z'));

    await fetchTinybirdPipe({
      pipe: 'llm_usage_summary',
      generateWebReadToken,
    });

    expect(generateWebReadToken).toHaveBeenCalledTimes(2);
    expect(mockFetchPipe).toHaveBeenLastCalledWith(
      expect.objectContaining({ pipe: 'llm_usage_summary', token: 'refreshed-jwt' }),
    );
  });

  it('clears the shared token and retries once on 403', async () => {
    const generateWebReadToken = vi
      .fn()
      .mockResolvedValueOnce(tokenResult('expired-jwt'))
      .mockResolvedValueOnce(tokenResult('fresh-jwt'));

    mockFetchPipe
      .mockRejectedValueOnce(new TinybirdAuthError('expired'))
      .mockResolvedValueOnce([{ ok: true }]);

    await fetchTinybirdPipe({
      pipe: 'agent_usage_summary',
      generateWebReadToken,
    });

    expect(generateWebReadToken).toHaveBeenCalledTimes(2);
    expect(mockFetchPipe).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ pipe: 'agent_usage_summary', token: 'expired-jwt' }),
    );
    expect(mockFetchPipe).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ pipe: 'agent_usage_summary', token: 'fresh-jwt' }),
    );
  });

  it('clears a failed in-flight token request so later calls can retry', async () => {
    const generateWebReadToken = vi
      .fn()
      .mockRejectedValueOnce(new Error('rate limited'))
      .mockResolvedValueOnce(tokenResult('retry-jwt'));

    await expect(
      fetchTinybirdPipe({
        pipe: 'agent_usage_summary',
        generateWebReadToken,
      }),
    ).rejects.toThrow('rate limited');

    await fetchTinybirdPipe({
      pipe: 'agent_usage_summary',
      generateWebReadToken,
    });

    expect(generateWebReadToken).toHaveBeenCalledTimes(2);
    expect(mockFetchPipe).toHaveBeenCalledWith(
      expect.objectContaining({ pipe: 'agent_usage_summary', token: 'retry-jwt' }),
    );
  });

  it('does not cache a token that resolves after the cache was cleared', async () => {
    let resolveOldToken: (value: { token: string; expiresAt: number }) => void = () => {};
    const oldTokenPromise = new Promise<{ token: string; expiresAt: number }>((resolve) => {
      resolveOldToken = resolve;
    });
    const generateWebReadToken = vi
      .fn()
      .mockReturnValueOnce(oldTokenPromise)
      .mockResolvedValueOnce(tokenResult('fresh-jwt'));

    const first = fetchTinybirdPipe({
      pipe: 'agent_context_health',
      generateWebReadToken,
    });

    expect(generateWebReadToken).toHaveBeenCalledTimes(1);
    clearTokenCache();
    resolveOldToken(tokenResult('old-jwt'));
    await first;

    await fetchTinybirdPipe({
      pipe: 'agent_context_health',
      generateWebReadToken,
    });

    expect(generateWebReadToken).toHaveBeenCalledTimes(2);
    expect(mockFetchPipe).toHaveBeenLastCalledWith(
      expect.objectContaining({ pipe: 'agent_context_health', token: 'fresh-jwt' }),
    );
  });

  it('uses NEXT_PUBLIC_PIPES_API_URL for pipe calls when configured', async () => {
    vi.stubEnv('NEXT_PUBLIC_PIPES_API_URL', 'https://pipes.trace-flow.dev');
    vi.stubEnv('NEXT_PUBLIC_API_URL', 'https://legacy-api.trace-flow.dev');
    const generateWebReadToken = vi.fn().mockResolvedValue(tokenResult('pipe-jwt'));

    await fetchTinybirdPipe({
      pipe: 'agent_usage_summary',
      generateWebReadToken,
    });

    expect(mockFetchPipe).toHaveBeenCalledWith(
      expect.objectContaining({ baseUrl: 'https://pipes.trace-flow.dev' }),
    );
  });

  it('uses the local pipes API default when pipe origin is unset', async () => {
    vi.stubEnv('NEXT_PUBLIC_PIPES_API_URL', undefined);
    vi.stubEnv('NEXT_PUBLIC_API_URL', 'https://legacy-api.trace-flow.dev');
    const generateWebReadToken = vi.fn().mockResolvedValue(tokenResult('pipe-jwt'));

    await fetchTinybirdPipe({
      pipe: 'agent_usage_summary',
      generateWebReadToken,
    });

    expect(mockFetchPipe).toHaveBeenCalledWith(
      expect.objectContaining({ baseUrl: 'http://localhost:8788' }),
    );
  });
});
