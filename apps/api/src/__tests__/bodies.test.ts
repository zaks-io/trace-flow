import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildStoredBodyKey } from '@trace-flow/types';
import {
  getStoredBodies,
  isBodyVisible,
  parseStoredBodiesPayload,
  resolveVisibilityWindowDays,
} from '../bodies';

function createObjectBody(body: string, uploaded: string, orgId = 'org_123'): R2ObjectBody {
  return {
    text: vi.fn().mockResolvedValue(body),
    uploaded: new Date(uploaded),
    customMetadata: { orgId },
  } as unknown as R2ObjectBody;
}

describe('bodies helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('builds the new combined body key', () => {
    expect(buildStoredBodyKey('req_123')).toBe('bodies/req_123');
  });

  it('parses stored body payloads', () => {
    expect(
      parseStoredBodiesPayload(
        JSON.stringify({
          requestBody: '{"prompt":"hi"}',
          responseBody: '{"output":"hello"}',
          truncated: true,
        }),
      ),
    ).toEqual({
      requestBody: '{"prompt":"hi"}',
      responseBody: '{"output":"hello"}',
      truncated: true,
    });
  });

  it('uses current-tier visibility windows', () => {
    expect(resolveVisibilityWindowDays('hobby')).toBe(7);
    expect(resolveVisibilityWindowDays('pro')).toBe(30);
    expect(
      isBodyVisible(
        new Date('2026-03-01T00:00:00.000Z'),
        'hobby',
        Date.parse('2026-03-05T00:00:00.000Z'),
      ),
    ).toBe(true);
    expect(
      isBodyVisible(
        new Date('2026-03-01T00:00:00.000Z'),
        'hobby',
        Date.parse('2026-03-10T00:00:00.000Z'),
      ),
    ).toBe(false);
    // Exactly at boundary (7 days to the ms) should be expired
    expect(
      isBodyVisible(
        new Date('2026-03-01T00:00:00.000Z'),
        'hobby',
        Date.parse('2026-03-08T00:00:00.000Z'),
      ),
    ).toBe(false);
    // 1ms before boundary should still be visible
    expect(
      isBodyVisible(
        new Date('2026-03-01T00:00:00.000Z'),
        'hobby',
        Date.parse('2026-03-08T00:00:00.000Z') - 1,
      ),
    ).toBe(true);
  });

  it('returns stored bodies from combined key', async () => {
    const combined = createObjectBody(
      JSON.stringify({
        requestBody: 'request body',
        responseBody: 'response body',
      }),
      '2026-03-01T00:00:00.000Z',
    );
    const storage = {
      get: vi.fn().mockImplementation((key: string) => {
        if (key === 'bodies/req_123') return Promise.resolve(combined);
        return Promise.resolve(null);
      }),
    } as unknown as R2Bucket;

    const result = await getStoredBodies(storage, 'req_123');

    expect(result).toEqual({
      payload: {
        requestBody: 'request body',
        responseBody: 'response body',
      },
      orgId: 'org_123',
      uploaded: new Date('2026-03-01T00:00:00.000Z'),
    });
    expect(storage.get).toHaveBeenCalledTimes(1);
  });

  it('returns null when stored payload is corrupt', async () => {
    const corrupt = {
      text: vi.fn().mockResolvedValue('not valid json{{{'),
      uploaded: new Date('2026-03-01T00:00:00.000Z'),
      customMetadata: { orgId: 'org_123' },
    } as unknown as R2ObjectBody;
    const storage = {
      get: vi.fn().mockResolvedValue(corrupt),
    } as unknown as R2Bucket;

    const result = await getStoredBodies(storage, 'req_corrupt');

    expect(result).toBeNull();
  });

  it('rejects arrays in parseStoredBodiesPayload', () => {
    expect(() => parseStoredBodiesPayload('[]')).toThrow('Stored body payload must be an object');
  });

  it('coerces unexpected field types to null', () => {
    const result = parseStoredBodiesPayload(
      JSON.stringify({ requestBody: 123, responseBody: { nested: true } }),
    );

    expect(result.requestBody).toBeNull();
    expect(result.responseBody).toBeNull();
  });

  it('returns null when the combined body object is missing', async () => {
    const storage = {
      get: vi.fn().mockResolvedValue(null),
    } as unknown as R2Bucket;

    const result = await getStoredBodies(storage, 'req_123');

    expect(result).toBeNull();
    expect(storage.get).toHaveBeenCalledWith('bodies/req_123');
  });
});
