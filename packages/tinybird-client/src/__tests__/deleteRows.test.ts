import { afterEach, describe, expect, it, vi } from 'vitest';
import { startDeleteRows, waitForDeleteRows } from '../deleteRows';

const options = {
  baseUrl: 'https://tinybird.test',
  token: 'admin',
  datasource: 'snapshot_rows',
  condition: "OrgId = 'org'",
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('startDeleteRows', () => {
  it('retries a rejected delete after Tinybird Retry-After and returns the accepted job', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-16T00:00:00Z'));
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(null, { status: 429, headers: { 'Retry-After': '2' } }))
      .mockResolvedValueOnce(Response.json({ job_id: 'job-1' }));

    const result = startDeleteRows({ ...options, deadlineMs: Date.now() + 10_000 });
    await vi.advanceTimersByTimeAsync(2_000);

    await expect(result).resolves.toBe('job-1');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('fails loud when the retry delay would exceed the caller deadline', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(null, { status: 429, headers: { 'Retry-After': '60' } }),
    );

    await expect(startDeleteRows({ ...options, deadlineMs: Date.now() + 1_000 })).rejects.toThrow(
      'remained rate limited before its deadline',
    );
  });

  it.each([new Headers(), new Headers({ 'Retry-After': '', 'X-RateLimit-Reset': '' })])(
    'fails loud when Tinybird omits valid retry headers',
    async (headers) => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(null, { status: 429, headers }),
      );

      await expect(startDeleteRows(options)).rejects.toThrow(
        'HTTP 429 without a valid retry delay',
      );
    },
  );

  it('does not retry a definitive delete rejection', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(null, { status: 403 }));

    await expect(startDeleteRows(options)).rejects.toThrow(
      'Tinybird row deletion failed: HTTP 403',
    );
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

describe('waitForDeleteRows', () => {
  it('retries rate-limited status reads and still requires a completed job', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-16T00:00:00Z'));
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(null, { status: 429, headers: { 'X-RateLimit-Reset': '1' } }),
      )
      .mockResolvedValueOnce(Response.json({ job_id: 'job-1', status: 'done' }));

    const result = waitForDeleteRows(options, 'job-1', Date.now() + 10_000);
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(result).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
