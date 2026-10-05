import { parseTraceparent, formatTraceparent, type TraceparentData } from './trace-context';

const originalTraceparents = new WeakMap<Request, TraceparentData | null>();

/** The supplied parent is distinct from the compatibility header synthesized for SDK ingress. */
export function getOriginalTraceparent(request: Request): TraceparentData | null {
  return originalTraceparents.has(request)
    ? originalTraceparents.get(request)!
    : validTraceparent(request.headers.get('traceparent'));
}

function validSentryHeader(header: string | null): string | null {
  if (!header || !/^[0-9a-f]{32}-[0-9a-f]{16}(?:-[01])?$/.test(header)) return null;
  const [traceId, spanId] = header.split('-');
  return traceId === '0'.repeat(32) || spanId === '0'.repeat(16) ? null : header;
}

function validTraceparent(header: string | null) {
  if (header !== header?.toLowerCase()) return null;
  if (!header) return null;
  const parsed = parseTraceparent(header.slice(0, 55));
  if (!parsed || parsed.version === 'ff') return null;
  if (parsed.version === '00' && header.length !== 55) return null;
  if (header.length > 55 && !/^-[\x21-\x2b\x2d-\x7e]+$/.test(header.slice(55))) return null;
  return parsed;
}

/**
 * Run before the SDK creates its request span. Valid Sentry context wins conflicts; W3C-only
 * context is translated with the same IDs and sampling bit. Trace headers never authorize access.
 */
export function normalizeTraceRequest<Cf extends CfProperties>(
  request: Request<unknown, Cf>,
): Request<unknown, Cf> {
  const originalTraceparent = getOriginalTraceparent(request);
  const normalizedRequest = (headers: Headers): Request<unknown, Cf> => {
    const normalized = new Request<unknown, Cf>(request, { headers });
    originalTraceparents.set(normalized, originalTraceparent);
    return normalized;
  };
  const sentryHeader = validSentryHeader(request.headers.get('sentry-trace'));
  const w3c = validTraceparent(request.headers.get('traceparent'));
  if (!sentryHeader && !w3c) {
    if (!request.headers.has('sentry-trace') && !request.headers.has('traceparent')) return request;
    const headers = new Headers(request.headers);
    headers.delete('sentry-trace');
    headers.delete('traceparent');
    headers.delete('tracestate');
    return normalizedRequest(headers);
  }

  const chosenSentry = sentryHeader ?? `${w3c!.traceId}-${w3c!.parentId}-${w3c!.flags & 1}`;
  const [traceId, parentId, sampled] = chosenSentry.split('-');
  const sameW3cParent = w3c?.traceId === traceId && w3c?.parentId === parentId;
  const originalW3c = request.headers.get('traceparent')!;
  const flags = sameW3cParent ? (w3c!.flags & ~1) | (sampled === '1' ? 1 : 0) : 0;
  const chosenW3c = sameW3cParent
    ? sampled === undefined
      ? originalW3c
      : `${originalW3c.slice(0, 53)}${flags.toString(16).padStart(2, '0')}${originalW3c.slice(55)}`
    : formatTraceparent(traceId!, parentId!, sampled === '1' ? 1 : 0);
  if (
    request.headers.get('sentry-trace') === chosenSentry &&
    request.headers.get('traceparent') === chosenW3c
  ) {
    return request;
  }

  const headers = new Headers(request.headers);
  headers.set('sentry-trace', chosenSentry);
  headers.set('traceparent', chosenW3c);
  // A conflicting W3C parent cannot retain its vendor state after choosing the Sentry parent.
  if (sentryHeader && !sameW3cParent) {
    headers.delete('tracestate');
  }
  return normalizedRequest(headers);
}
