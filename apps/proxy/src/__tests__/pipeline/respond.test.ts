import { describe, it, expect } from 'vitest';
import { respond } from '../../pipeline/respond';
import type { CaptureContext, TracingDecision } from '../../context';

function makeCtx(
  decision: TracingDecision,
  upstream: { status: number; statusText: string; headers: Record<string, string> } = {
    status: 200,
    statusText: 'OK',
    headers: { 'content-type': 'application/json' },
  },
): CaptureContext {
  const upstreamResponse = new Response('{}', {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: upstream.headers,
  });
  const readable = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('hi'));
      controller.close();
    },
  });
  return {
    decision,
    response: upstreamResponse,
    readable,
  } as unknown as CaptureContext;
}

describe('respond', () => {
  it('sets X-Trace-Flow-Recording=true when decision.record is true', () => {
    const res = respond(makeCtx({ record: true, reason: 'ok' }));
    expect(res.headers.get('X-Trace-Flow-Recording')).toBe('true');
    expect(res.headers.get('X-Trace-Flow-Recording-Reason')).toBeNull();
  });

  it('sets recording=false and reason when not recording', () => {
    const res = respond(makeCtx({ record: false, reason: 'canceled' }));
    expect(res.headers.get('X-Trace-Flow-Recording')).toBe('false');
    expect(res.headers.get('X-Trace-Flow-Recording-Reason')).toBe('canceled');
  });

  it('adds X-Trace-Flow-Period-Reset on exceeded with periodEnd', () => {
    const periodEnd = Date.UTC(2026, 0, 1);
    const res = respond(makeCtx({ record: false, reason: 'exceeded', periodEnd }));
    expect(res.headers.get('X-Trace-Flow-Period-Reset')).toBe(new Date(periodEnd).toISOString());
  });

  it('omits Period-Reset when reason is not exceeded', () => {
    const periodEnd = Date.UTC(2026, 0, 1);
    const res = respond(makeCtx({ record: false, reason: 'suspended', periodEnd }));
    expect(res.headers.get('X-Trace-Flow-Period-Reset')).toBeNull();
  });

  it('preserves upstream status and statusText', () => {
    const res = respond(
      makeCtx({ record: true, reason: 'ok' }, { status: 503, statusText: 'Bad', headers: {} }),
    );
    expect(res.status).toBe(503);
    expect(res.statusText).toBe('Bad');
  });

  it('applies security headers', () => {
    const res = respond(makeCtx({ record: true, reason: 'ok' }));
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });
});
