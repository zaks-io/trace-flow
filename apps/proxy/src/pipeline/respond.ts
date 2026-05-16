import { applySecurityHeaders } from '@trace-flow/utils';
import type { CaptureContext } from '../context';

/**
 * Build the client-facing response. Surfaces the tracing decision via
 * `X-Trace-Flow-Recording*` headers so SDKs can detect when a request wasn't
 * billed-for (suspended/canceled/exceeded) without scraping logs.
 */
export function respond(ctx: CaptureContext): Response {
  const headers = new Headers(ctx.response.headers);
  headers.set('X-Trace-Flow-Recording', String(ctx.decision.record));
  if (!ctx.decision.record) {
    headers.set('X-Trace-Flow-Recording-Reason', ctx.decision.reason);
    if (ctx.decision.reason === 'exceeded' && ctx.decision.periodEnd) {
      headers.set('X-Trace-Flow-Period-Reset', new Date(ctx.decision.periodEnd).toISOString());
    }
  }
  applySecurityHeaders(headers);

  return new Response(ctx.readable, {
    status: ctx.response.status,
    statusText: ctx.response.statusText,
    headers,
  });
}
