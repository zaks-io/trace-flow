import { TinybirdInsertError } from './errors';

const TINYBIRD_TIMEOUT_MS = 60_000;

/**
 * Generic Events API insert transport: serialize `rows` as NDJSON and POST them to
 * `/v0/events?name=<datasource>`. This is the shared core both consumers use; it knows nothing
 * about row shape, so the proxy consumer reshapes its OTel rows before calling, and the agent
 * consumer passes flat rows directly.
 *
 * The Events API is non-idempotent — a re-POST writes duplicate physical rows. Callers must make
 * redelivery safe before leaning on at-least-once queue delivery. Hot callers should dedupe before
 * insert instead of relying on Tinybird query-time cleanup.
 */
export async function insertRows(
  rows: readonly unknown[],
  token: string,
  datasource: string,
  host: string,
): Promise<void> {
  const url = `${host}/v0/events?name=${encodeURIComponent(datasource)}`;
  const body = rows.map((row) => JSON.stringify(row)).join('\n');

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
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
 * Whether a failed insert is worth retrying. 4xx client errors (bad rows, auth, payload too large)
 * and 422 partial-ingestion are terminal; 429/503 and 5xx are transient. A non-`TinybirdInsertError`
 * (network/timeout) is treated as transient.
 */
export function shouldRetryTinybirdInsert(error: unknown): boolean {
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
