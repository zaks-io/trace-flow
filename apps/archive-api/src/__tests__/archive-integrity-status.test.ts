import { afterEach, describe, expect, it, vi } from 'vitest';
import { publishArchiveIntegrityStatus } from '../archive-integrity-status';

const env = {
  CONVEX_SITE_URL: 'https://convex.test',
  ARCHIVE_API_SHARED_SECRET: 'shared-secret',
};

describe('archive integrity status publication', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('posts only collector binding and integrity metadata', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      expect(request.url).toBe('https://convex.test/archive-api/session-integrity');
      expect(request.headers.get('Authorization')).toBe('Bearer shared-secret');
      const body = await request.json<Record<string, unknown>>();
      expect(body).toEqual({
        collectorCredentialId: 'collector-1',
        source: 'codex',
        sourceSessionId: 'session-1',
        errorClass: 'payload_hash_mismatch',
      });
      expect(body).not.toHaveProperty('payload');
      expect(body).not.toHaveProperty('path');
      expect(JSON.stringify(body)).not.toContain('shared-secret');
      return Response.json(body);
    });

    await expect(
      publishArchiveIntegrityStatus(env, {
        collectorCredentialId: 'collector-1',
        source: 'codex',
        sourceSessionId: 'session-1',
        errorClass: 'payload_hash_mismatch',
      }),
    ).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('fails on a malformed acknowledgement', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(Response.json({ source: 'codex' }));
    await expect(
      publishArchiveIntegrityStatus(env, {
        collectorCredentialId: 'collector-1',
        source: 'codex',
        sourceSessionId: 'session-1',
        errorClass: 'payload_hash_mismatch',
      }),
    ).rejects.toThrow('archive_integrity_status_publication_malformed');
  });
});
