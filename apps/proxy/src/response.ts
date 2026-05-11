import { applySecurityHeaders } from '@trace-flow/utils';
import type { TracingDecision } from './tracing-decision';

export function buildProxyResponse(
  readable: ReadableStream,
  response: Response,
  decision: TracingDecision,
): Response {
  const headers = new Headers(response.headers);
  headers.set('X-Trace-Flow-Recording', String(decision.record));
  if (!decision.record) {
    headers.set('X-Trace-Flow-Recording-Reason', decision.reason);
    if (decision.reason === 'exceeded' && decision.periodEnd) {
      headers.set('X-Trace-Flow-Period-Reset', new Date(decision.periodEnd).toISOString());
    }
  }
  applySecurityHeaders(headers);

  return new Response(readable, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
