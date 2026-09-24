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

const PROXY_ONLY_HEADERS = [
  'x-trace-flow-api-key',
  'x-trace-flow-omit-body',
  'traceparent',
  'tracestate',
  'baggage',
  'host',
  'content-length',
];

/** RFC 9110 §7.6.1 connection-scoped headers; they describe the client hop, not ours. */
const HOP_BY_HOP_HEADERS = [
  'connection',
  'keep-alive',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
];

/** Caller network identity added by Cloudflare or client-side proxies. */
const CLIENT_NETWORK_HEADERS = ['forwarded', 'x-real-ip', 'true-client-ip'];
const CLIENT_NETWORK_HEADER_PREFIXES = ['cf-', 'x-forwarded-'];

export function buildUpstreamHeaders(incoming: Headers): Headers {
  const headers = new Headers(incoming);
  const stripped = new Set([
    ...PROXY_ONLY_HEADERS,
    ...HOP_BY_HOP_HEADERS,
    ...CLIENT_NETWORK_HEADERS,
  ]);
  for (const name of headers.keys()) {
    if (CLIENT_NETWORK_HEADER_PREFIXES.some((prefix) => name.startsWith(prefix))) {
      stripped.add(name);
    }
  }
  for (const name of stripped) headers.delete(name);
  return headers;
}

/**
 * Give forwarding and capture independent views of the request body validated by the prior stage.
 *
 * Strips proxy-internal headers and W3C trace context (those are for us), plus
 * hop-by-hop and caller network headers so the end user's IP never reaches the
 * provider. `Authorization` / `x-api-key` pass through.
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

  const headers = buildUpstreamHeaders(c.req.raw.headers);

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
