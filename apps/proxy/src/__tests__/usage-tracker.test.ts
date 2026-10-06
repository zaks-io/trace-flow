import { describe, it, expect } from 'vitest';
import { buildUsageSyncRequestInit, isPermanentUsageSyncFailure } from '../usage-tracker';

describe('buildUsageSyncRequestInit', () => {
  it('keeps workflow metadata in the body without inventing an execution trace', () => {
    const init = buildUsageSyncRequestInit('sync-secret', {
      orgId: 'org_123',
      periodStart: 1,
      periodEnd: 2,
      subscriptionUnitsUsed: 3,
      addonUnitsUsed: 4,
      traceContext: {
        traceId: '0123456789abcdef0123456789abcdef',
        requestId: 'req_123',
        workflowId: 'usage:org_123:1:2',
        orgId: 'org_123',
      },
    });

    const headers = new Headers(init.headers);
    const body = JSON.parse(String(init.body)) as {
      traceContext?: { traceId?: string; requestId?: string; workflowId?: string };
    };

    expect(headers.get('Authorization')).toBe('Bearer sync-secret');
    expect(headers.has('traceparent')).toBe(false);
    expect(headers.has('sentry-trace')).toBe(false);
    expect(headers.has('baggage')).toBe(false);
    expect(body.traceContext).toMatchObject({
      traceId: '0123456789abcdef0123456789abcdef',
      requestId: 'req_123',
      workflowId: 'usage:org_123:1:2',
    });
  });
});

describe('usage synchronization failure classification', () => {
  it.each([400, 403, 404, 422])('identifies rejected status %i', (status) => {
    expect(isPermanentUsageSyncFailure(status)).toBe(true);
  });
  it.each([401, 408, 429, 500, 503])('identifies retryable status %i', (status) => {
    expect(isPermanentUsageSyncFailure(status)).toBe(false);
  });
});
