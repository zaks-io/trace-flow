import type { Context } from 'hono';
import { getCurrentTimestamp } from '@trace-flow/utils';
import type { ProxyEnv } from '../context';
import type { ValidatedRequest } from './validateRequest';

export interface ForwardedRequest {
  targetUrl: string;
  streamToCapture: ReadableStream | null;
  response: Response;
  requestStart: number;
  requestSent: number;
  responseReceived: number;
}

/**
 * Tee the request body, forward to the resolved provider, capture timestamps.
 *
 * tee() is mandatory — Workers streams are read-once and both consumers (proxy
 * fetch + capture pipeline) need their own reader. If only one drains, the
 * other backpressures the worker indefinitely.
 *
 * Strips proxy-internal headers (`X-Trace-Flow-Api-Key`,
 * `X-Trace-Flow-Omit-Body`) and W3C trace context — those are for us, not
 * the upstream provider. `Authorization` / `x-api-key` pass through.
 */
export async function forwardToUpstream(
  c: Context<{ Bindings: ProxyEnv }>,
  validated: ValidatedRequest,
): Promise<ForwardedRequest> {
  const requestStart = getCurrentTimestamp();

  const query = new URL(c.req.url).search;
  const targetUrl = validated.route.targetUrl + query;

  const [streamToProxy, streamToCapture] = c.req.raw.body?.tee() ?? [null, null];

  const headers = new Headers(c.req.raw.headers);
  headers.delete('X-Trace-Flow-Api-Key');
  headers.delete('X-Trace-Flow-Omit-Body');
  headers.delete('traceparent');
  headers.delete('tracestate');
  headers.delete('baggage');
  headers.delete('host');

  const requestSent = getCurrentTimestamp();

  const response = await fetch(targetUrl, {
    method: c.req.method,
    headers,
    body: streamToProxy,
  });

  const responseReceived = getCurrentTimestamp();

  return {
    targetUrl,
    streamToCapture,
    response,
    requestStart,
    requestSent,
    responseReceived,
  };
}
