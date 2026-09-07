import type { Context } from 'hono';
import { getCurrentTimestamp } from '@trace-flow/utils';
import type { ProxyEnv } from '../context';
import type { ValidatedRequest } from './validateRequest';

/**
 * Output of the forward stage. Composes the validated request by inclusion —
 * `forwarded.validated.keyData.orgId` traces back to where it was set.
 */
export interface ForwardedExchange {
  validated: ValidatedRequest;
  targetUrl: string;
  streamToCapture: ReadableStream | null;
  response: Response;
  requestStart: number;
  requestSent: number;
  responseReceived: number;
}

export class UpstreamFetchError extends Error {
  constructor(
    readonly exchange: Omit<ForwardedExchange, 'response' | 'responseReceived'>,
    cause: unknown,
  ) {
    super('Upstream request failed', { cause });
    this.name = 'UpstreamFetchError';
  }
}

/**
 * Give forwarding and capture independent views of the request body validated by the prior stage.
 *
 * Strips proxy-internal headers (`X-Trace-Flow-Api-Key`,
 * `X-Trace-Flow-Omit-Body`) and W3C trace context — those are for us, not
 * the upstream provider. `Authorization` / `x-api-key` pass through.
 */
export async function forwardToUpstream(
  c: Context<{ Bindings: ProxyEnv }>,
  validated: ValidatedRequest,
): Promise<ForwardedExchange> {
  const requestStart = getCurrentTimestamp();

  const query = new URL(c.req.url).search;
  const targetUrl = validated.route.targetUrl + query;

  const body = validated.requestBody;
  const streamToCapture = body.byteLength > 0 ? new Blob([body]).stream() : null;

  const headers = new Headers(c.req.raw.headers);
  headers.delete('X-Trace-Flow-Api-Key');
  headers.delete('X-Trace-Flow-Omit-Body');
  headers.delete('traceparent');
  headers.delete('tracestate');
  headers.delete('baggage');
  headers.delete('host');
  headers.delete('content-length');

  const requestSent = getCurrentTimestamp();

  let response: Response;
  try {
    response = await fetch(targetUrl, {
      method: c.req.method,
      headers,
      body: body.byteLength > 0 ? body : null,
    });
  } catch (error) {
    throw new UpstreamFetchError(
      { validated, targetUrl, streamToCapture, requestStart, requestSent },
      error,
    );
  }

  const responseReceived = getCurrentTimestamp();

  return {
    validated,
    targetUrl,
    streamToCapture,
    response,
    requestStart,
    requestSent,
    responseReceived,
  };
}
