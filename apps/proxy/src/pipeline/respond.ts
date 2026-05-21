import { applySecurityHeaders } from '@trace-flow/utils';
import type { AttachedCapture } from './attachCapture';

/**
 * Build the client-facing response. Surfaces the tracing decision via
 * `X-Trace-Flow-Recording*` headers so SDKs can detect when a request wasn't
 * billed-for (suspended/canceled/exceeded) without scraping logs.
 */
export function respond(attached: AttachedCapture): Response {
  const { response } = attached.forwarded;
  const { decision } = attached.forwarded.validated;

  const headers = new Headers(response.headers);
  headers.set('X-Trace-Flow-Recording', String(decision.record));
  if (!decision.record) {
    headers.set('X-Trace-Flow-Recording-Reason', decision.reason);
    if (decision.reason === 'exceeded' && decision.periodEnd) {
      headers.set('X-Trace-Flow-Period-Reset', new Date(decision.periodEnd).toISOString());
    }
  }
  applySecurityHeaders(headers);

  return new Response(attached.readable, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
