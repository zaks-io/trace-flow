import {
  startTinybirdQuerySpan,
  recordTinybirdResponse,
  recordTinybirdStatistics,
} from '@trace-flow/tinybird-client';

export async function fetchFromTinybird(
  apiUrl: string,
  originalUrl: URL,
  token: string,
): Promise<Response> {
  const pipe = originalUrl.pathname.slice('/v0/pipes/'.length).replace(/\.json$/, '');
  const span = startTinybirdQuerySpan({ baseUrl: apiUrl, pipe });
  try {
    const response = await fetch(`${apiUrl}${originalUrl.pathname}${originalUrl.search}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    recordTinybirdResponse(span, response);
    const body = await response.text();
    if (response.ok) {
      try {
        recordTinybirdStatistics(span, JSON.parse(body));
        span.setStatus({ code: 1 });
      } catch {
        // Keep the proxy's passthrough contract even if Tinybird returns malformed JSON.
        span.setStatus({ code: 2 });
      }
    } else {
      span.setStatus({ code: 2 });
    }
    return new Response([204, 205, 304].includes(response.status) ? null : body, {
      status: response.status,
      headers: response.headers,
    });
  } catch (error) {
    span.setStatus({ code: 2 });
    throw error;
  } finally {
    span.end();
  }
}
