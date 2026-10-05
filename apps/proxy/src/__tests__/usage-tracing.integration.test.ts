import { env, runDurableObjectAlarm } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProxyEnv } from '../context';

const bindings = env as unknown as ProxyEnv;

describe('UsageTracker trace propagation in workerd', () => {
  afterEach(() => vi.restoreAllMocks());

  it('sends the alarm execution trace to authenticated Convex without baggage', async () => {
    const requests: { url: string; headers: Headers; body: string }[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      requests.push({ url: request.url, headers: request.headers, body: await request.text() });
      return Response.json({ ok: true });
    });
    const orgId = `usage-trace-${crypto.randomUUID()}`;
    const stub = bindings.USAGE_TRACKER.get(bindings.USAGE_TRACKER.idFromName(orgId));
    const periodStart = Date.now();
    const periodEnd = periodStart + 86_400_000;
    const response = await stub.fetch(
      new Request('https://usage.internal/check', {
        method: 'POST',
        headers: { 'sentry-trace': `${'1'.repeat(32)}-${'2'.repeat(16)}-1` },
        body: JSON.stringify({
          count: 3,
          orgId,
          subscriptionConfig: {
            tier: 'pro',
            monthlyUnits: 100,
            addonUnits: 0,
            currentPeriodStart: periodStart,
            currentPeriodEnd: periodEnd,
          },
        }),
      }),
    );
    expect(await response.json()).toEqual({ allowed: true });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(requests).toHaveLength(1);
    const request = requests[0]!;
    expect(request.url).toBe('https://convex.test/usage/record');
    expect(request.headers.get('Authorization')).toBe('Bearer test-secret');
    expect(request.headers.has('baggage')).toBe(false);
    const sentryHeader = request.headers.get('sentry-trace');
    expect(sentryHeader).toMatch(/^[a-f0-9]{32}-[a-f0-9]{16}-[01]$/);
    const [traceId, spanId, sampled] = sentryHeader!.split('-');
    expect(request.headers.get('traceparent')).toBe(
      `00-${traceId}-${spanId}-${sampled === '1' ? '01' : '00'}`,
    );
    const payload = JSON.parse(request.body) as {
      subscriptionUnitsUsed: number;
      traceContext: { traceId: string; workflowId: string };
    };
    expect(payload.subscriptionUnitsUsed).toBe(3);
    expect(payload.traceContext).toMatchObject({
      traceId,
      workflowId: `usage:${orgId}:${periodStart}:${periodEnd}`,
    });
  });
});
