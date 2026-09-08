import {
  SPAN_STATUS_ERROR,
  SPAN_STATUS_OK,
  startInactiveSpan,
  type Scope,
  type Span,
} from '@sentry/core';

export interface StartTinybirdQuerySpanOptions {
  baseUrl: string;
  pipe?: string;
  sentryScope?: Scope;
}

const cachedSpans = new WeakSet<Span>();

export function startTinybirdQuerySpan({
  baseUrl,
  pipe,
  sentryScope,
}: StartTinybirdQuerySpanOptions): Span {
  const hostname = new URL(baseUrl).hostname;

  return startInactiveSpan({
    name: pipe ? `tinybird.pipe ${pipe}` : 'tinybird.sql',
    op: 'db.query',
    scope: sentryScope,
    ...(sentryScope ? { parentSpan: null } : {}),
    attributes: {
      'db.system': 'clickhouse',
      'server.address': hostname,
      ...(pipe ? { 'tinybird.pipe': pipe } : {}),
    },
  });
}

export function recordTinybirdResponse(span: Span, response: Response): void {
  span.setAttribute('http.response.status_code', response.status);

  const requestId = response.headers.get('x-request-id');
  if (requestId) {
    span.setAttribute('tinybird.request_id', requestId);
  }

  const cacheStatus = response.headers.get('x-cache');
  if (cacheStatus) {
    span.setAttribute('tinybird.cache_status', cacheStatus);
    if (cacheStatus.toUpperCase().includes('HIT')) {
      cachedSpans.add(span);
    }
  }
}

export function recordTinybirdStatistics(span: Span, body: unknown): void {
  if (!isRecord(body)) {
    return;
  }

  if (Array.isArray(body.data)) {
    span.setAttribute('db.response.returned_rows', body.data.length);
  }

  if (cachedSpans.has(span) || !isRecord(body.statistics)) {
    return;
  }

  setNonNegativeFiniteAttribute(span, 'tinybird.elapsed_ms', body.statistics.elapsed, 1_000);
  setNonNegativeFiniteAttribute(span, 'tinybird.rows_read', body.statistics.rows_read);
  setNonNegativeFiniteAttribute(span, 'tinybird.bytes_read', body.statistics.bytes_read);
}

export function finishTinybirdQuerySpan(span: Span, succeeded: boolean): void {
  span.setStatus({ code: succeeded ? SPAN_STATUS_OK : SPAN_STATUS_ERROR });
  span.end();
}

function setNonNegativeFiniteAttribute(
  span: Span,
  name: string,
  value: unknown,
  multiplier = 1,
): void {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    const scaledValue = value * multiplier;
    if (Number.isFinite(scaledValue)) {
      span.setAttribute(name, scaledValue);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
