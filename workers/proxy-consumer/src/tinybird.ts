import type { TinybirdTrace } from '@trace-flow/types';

const MAX_RETRIES = 3;
const INITIAL_RETRY_DELAY_MS = 1000;
const TINYBIRD_TIMEOUT_MS = 60000;

class TinybirdInsertError extends Error {
  readonly status: number;
  readonly responseText: string;

  constructor(status: number, responseText: string) {
    super(`Tinybird insert failed: ${status} ${responseText}`);
    this.status = status;
    this.responseText = responseText;
  }
}

function shouldRetryTinybirdError(error: unknown): boolean {
  if (!(error instanceof TinybirdInsertError)) {
    return true;
  }

  if (error.status === 422) {
    return false;
  }

  if (error.status === 429 || error.status === 503) {
    return true;
  }

  if ([400, 401, 403, 404, 413].includes(error.status)) {
    return false;
  }

  return error.status >= 500;
}

/**
 * Inserts traces into Tinybird using their Events API.
 *
 * Formats traces as NDJSON (one JSON object per line) which is required by Tinybird's
 * bulk insert endpoint. Each trace becomes a row in the datasource.
 *
 * Uses 60-second timeout to prevent hanging on slow network conditions.
 */
export async function insertIntoTinybird(
  traces: TinybirdTrace[],
  tinybirdToken: string,
  datasource: string,
  host: string,
): Promise<void> {
  const url = `${host}/v0/events?name=${encodeURIComponent(datasource)}&wait=true`;

  const body = traces
    .map((trace) => {
      const {
        'Events.Timestamp': eventsTimestamp,
        'Events.Name': eventsName,
        'Events.Attributes': eventsAttributes,
        'Links.TraceId': linksTraceId,
        'Links.SpanId': linksSpanId,
        'Links.TraceState': linksTraceState,
        'Links.Attributes': linksAttributes,
        ...rest
      } = trace;

      const transformed = {
        ...rest,
        Events: {
          Timestamp: eventsTimestamp,
          Name: eventsName,
          Attributes: eventsAttributes,
        },
        Links: {
          TraceId: linksTraceId,
          SpanId: linksSpanId,
          TraceState: linksTraceState,
          Attributes: linksAttributes,
        },
      };

      return JSON.stringify(transformed);
    })
    .join('\n');

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${tinybirdToken}`,
    },
    body,
    signal: AbortSignal.timeout(TINYBIRD_TIMEOUT_MS),
  });

  const responseText = await response.text();

  if (!response.ok) {
    throw new TinybirdInsertError(response.status, responseText);
  }
}

/**
 * Wraps insertIntoTinybird with exponential backoff retry logic.
 *
 * Retries up to MAX_RETRIES times with exponential backoff and jitter:
 * - Attempt 1: 1000ms + jitter
 * - Attempt 2: 2000ms + jitter
 * - Attempt 3: 4000ms + jitter
 *
 * Jitter (0-100ms) prevents thundering herd when multiple workers retry simultaneously.
 */
export async function insertIntoTinybirdWithRetry(
  traces: TinybirdTrace[],
  tinybirdToken: string,
  datasource: string,
  host: string,
  delayFn: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<void> {
  let lastError: Error = new Error('Unknown error');

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      await insertIntoTinybird(traces, tinybirdToken, datasource, host);
      return;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      const retryable = shouldRetryTinybirdError(error);
      console.warn(`Insert attempt ${attempt + 1}/${MAX_RETRIES} failed:`, lastError.message);

      if (!retryable) {
        console.error('Non-retriable Tinybird insert error:', lastError);
        throw lastError;
      }

      if (attempt < MAX_RETRIES - 1) {
        const delay = INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt);
        const jitter = Math.floor(Math.random() * 100);
        await delayFn(delay + jitter);
      } else {
        console.error('Failed to insert traces into Tinybird after retries:', lastError);
      }
    }
  }

  throw lastError;
}
