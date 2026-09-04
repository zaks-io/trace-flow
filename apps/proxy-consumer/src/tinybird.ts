import type { TinybirdTrace } from '@trace-flow/types';
import { normalizeAnalyticsKey } from '@trace-flow/utils';
import { insertRows, shouldRetryTinybirdInsert } from '@trace-flow/tinybird-client';

const MAX_RETRIES = 1;
const INITIAL_RETRY_DELAY_MS = 1000;

/**
 * Reshapes the flat `Events.*` / `Links.*` columns back into the nested `Events{}` / `Links{}`
 * objects the OTel datasource expects, then delegates to the shared NDJSON insert transport
 * (`@trace-flow/tinybird-client`). The reshape is proxy-specific and stays here; the transport core
 * is shared with the agent consumer, which passes already-flat rows.
 */
export async function insertIntoTinybird(
  traces: TinybirdTrace[],
  tinybirdToken: string,
  datasource: string,
  host: string,
): Promise<void> {
  const rows = await Promise.all(
    traces.map(async (trace) => {
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

      return {
        ...rest,
        ApiKey: await normalizeAnalyticsKey(trace.ApiKey),
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
    }),
  );

  await insertRows(rows, tinybirdToken, datasource, host);
}

/**
 * Wraps insertIntoTinybird — no retries by default since the Events API is non-idempotent.
 * The batcher's alarm cycle handles retry at a higher level.
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
      const retryable = shouldRetryTinybirdInsert(error);
      console.warn(`Insert attempt ${attempt + 1}/${MAX_RETRIES} failed:`, lastError.message);

      if (!retryable) {
        console.error('Non-retriable Tinybird insert error:', lastError.message);
        throw lastError;
      }

      if (attempt < MAX_RETRIES - 1) {
        const delay = INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt);
        const jitter = Math.floor(Math.random() * 100);
        await delayFn(delay + jitter);
      } else {
        console.error('Failed to insert traces into Tinybird after retries:', lastError.message);
      }
    }
  }

  throw lastError;
}
