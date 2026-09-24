import { describe, expect, it, vi } from 'vitest';
import { getProvider, type ResolvedRoute } from '@trace-flow/llm-providers';
import { writeRequestAnalytics } from '../analytics';

function serverErrorFlag(responseStatus: number, streamFailed: boolean): number | undefined {
  const writeDataPoint = vi.fn();
  writeRequestAnalytics({
    analytics: { writeDataPoint },
    orgId: 'org-1',
    route: { provider: getProvider('anthropic') } as ResolvedRoute,
    responseStatus,
    streamFailed,
    operationName: 'chat',
    isSSE: true,
    responseMetadata: undefined,
    requestStart: 0,
    requestSent: 1,
    responseReceived: 2,
    responseComplete: 3,
    firstTokenReceived: 2,
    tokens: undefined,
    totalSize: 10,
    storageSkipped: false,
    stored: true,
  });
  const point = writeDataPoint.mock.calls[0]?.[0] as { doubles: number[] };
  return point.doubles[3];
}

describe('writeRequestAnalytics', () => {
  it('flags a failed 200 stream as a server error', () => {
    expect(serverErrorFlag(200, true)).toBe(1);
  });

  it('keeps successful and client-error responses unflagged', () => {
    expect(serverErrorFlag(200, false)).toBe(0);
    expect(serverErrorFlag(429, false)).toBe(0);
    expect(serverErrorFlag(502, false)).toBe(1);
  });
});
