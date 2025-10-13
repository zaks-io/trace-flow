import type { TinybirdTrace } from '@observe/types';

const MAX_RETRIES = 3;
const INITIAL_RETRY_DELAY_MS = 1000;

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
  const url = `${host}/v0/events?name=${encodeURIComponent(datasource)}`;
  const body = traces.map((trace) => JSON.stringify(trace)).join('\n');

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${tinybirdToken}`,
    },
    body,
    signal: AbortSignal.timeout(60000),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Tinybird insert failed: ${response.status} ${errorText}`);
  }

  console.log(`Successfully inserted ${traces.length} traces into Tinybird`);
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
      console.warn(`Insert attempt ${attempt + 1}/${MAX_RETRIES} failed:`, lastError.message);

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
