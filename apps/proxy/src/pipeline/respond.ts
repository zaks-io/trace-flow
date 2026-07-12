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

  // Null-body statuses (204/205/304) must not carry a body — constructing a Response with a
  // non-null stream for those statuses throws. The upstream had nothing to capture anyway.
  const body = response.body === null ? null : attached.readable;

  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
