import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchPipe } from '@trace-flow/tinybird-client';
import { clearTokenCache, fetchTinybirdPipe } from '../tinybird';

vi.mock('@trace-flow/tinybird-client', () => ({
  fetchPipe: vi.fn(async () => []),
  TinybirdAuthError: class TinybirdAuthError extends Error {},
}));

const mockFetchPipe = vi.mocked(fetchPipe);

describe('fetchTinybirdPipe', () => {
  beforeEach(() => {
    clearTokenCache();
    vi.clearAllMocks();
  });

  it('coalesces concurrent token requests for the same pipe', async () => {
    let resolveToken: (value: { token: string }) => void = () => {};
    const tokenPromise = new Promise<{ token: string }>((resolve) => {
      resolveToken = resolve;
    });
    const generateToken = vi.fn(() => tokenPromise);

    const first = fetchTinybirdPipe({
      pipe: 'agent_usage_timeseries',
      params: { start_time_ms: 1 },
      generateToken,
    });
    const second = fetchTinybirdPipe({
      pipe: 'agent_usage_timeseries',
      params: { start_time_ms: 2 },
      generateToken,
    });

    expect(generateToken).toHaveBeenCalledTimes(1);

    resolveToken({ token: 'shared-jwt' });
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

  it('clears a failed in-flight token request so later calls can retry', async () => {
    const generateToken = vi
      .fn()
      .mockRejectedValueOnce(new Error('rate limited'))
      .mockResolvedValueOnce({ token: 'retry-jwt' });

    await expect(
      fetchTinybirdPipe({
        pipe: 'agent_usage_summary',
        generateToken,
      }),
    ).rejects.toThrow('rate limited');

    await fetchTinybirdPipe({
      pipe: 'agent_usage_summary',
      generateToken,
    });

    expect(generateToken).toHaveBeenCalledTimes(2);
    expect(mockFetchPipe).toHaveBeenCalledWith(
      expect.objectContaining({ pipe: 'agent_usage_summary', token: 'retry-jwt' }),
    );
  });

  it('does not cache a token that resolves after the cache was cleared', async () => {
    let resolveOldToken: (value: { token: string }) => void = () => {};
    const oldTokenPromise = new Promise<{ token: string }>((resolve) => {
      resolveOldToken = resolve;
    });
    const generateToken = vi
      .fn()
      .mockReturnValueOnce(oldTokenPromise)
      .mockResolvedValueOnce({ token: 'fresh-jwt' });

    const first = fetchTinybirdPipe({
      pipe: 'agent_context_health',
      generateToken,
    });

    expect(generateToken).toHaveBeenCalledTimes(1);
    clearTokenCache();
    resolveOldToken({ token: 'old-jwt' });
    await first;

    await fetchTinybirdPipe({
      pipe: 'agent_context_health',
      generateToken,
    });

    expect(generateToken).toHaveBeenCalledTimes(2);
    expect(mockFetchPipe).toHaveBeenLastCalledWith(
      expect.objectContaining({ pipe: 'agent_context_health', token: 'fresh-jwt' }),
    );
  });
});
