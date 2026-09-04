import { describe, expect, it } from 'vitest';
import { analyticsKeyId, normalizeAnalyticsKey } from '../analytics-key';

describe('analytics identifiers', () => {
  it('uses the complete SHA-256 digest with a separate namespace', async () => {
    expect(await analyticsKeyId('abc')).toBe(
      'sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(await analyticsKeyId('another-key')).not.toBe(await analyticsKeyId('abc'));
  });

  it('normalizes legacy batches without double hashing new identifiers', async () => {
    const identifier = await analyticsKeyId('old-credential');
    expect(await normalizeAnalyticsKey('old-credential')).toBe(identifier);
    expect(await normalizeAnalyticsKey(identifier)).toBe(identifier);
  });

  it('fails on missing credentials instead of generating a shared identifier', async () => {
    await expect(analyticsKeyId('')).rejects.toThrow('Missing API credential');
    await expect(normalizeAnalyticsKey('')).rejects.toThrow('Missing API credential');
  });
});
