import { TinybirdInsertError } from './errors';

const TINYBIRD_TIMEOUT_MS = 60_000;

export type TinybirdInsertFailureClassification = 'retryable' | 'rejected' | 'uncertain';

interface TinybirdInsertReceipt {
  successful_rows: number;
  quarantined_rows: number;
}

function parseReceipt(responseText: string): TinybirdInsertReceipt | undefined {
  let receipt: unknown;
  try {
    receipt = JSON.parse(responseText);
  } catch {
    return undefined;
  }

  if (typeof receipt !== 'object' || receipt === null || Array.isArray(receipt)) {
    return undefined;
  }

  const { successful_rows, quarantined_rows } = receipt as Record<string, unknown>;
  if (
    !Number.isSafeInteger(successful_rows) ||
    !Number.isSafeInteger(quarantined_rows) ||
    (successful_rows as number) < 0 ||
    (quarantined_rows as number) < 0
  ) {
    return undefined;
  }

  return {
    successful_rows: successful_rows as number,
    quarantined_rows: quarantined_rows as number,
  };
}

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
  const url = `${host}/v0/events?name=${encodeURIComponent(datasource)}&wait=true`;
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

  if (response.status !== 200) {
    if (response.ok) {
      throw new TinybirdInsertError(response.status, responseText, 'unconfirmed');
    }
    throw new TinybirdInsertError(response.status, responseText);
  }

  const receipt = parseReceipt(responseText);
  if (!receipt) {
    throw new TinybirdInsertError(response.status, responseText, 'malformed-receipt');
  }

  if (receipt.successful_rows !== rows.length || receipt.quarantined_rows !== 0) {
    throw new TinybirdInsertError(response.status, responseText, 'partial-receipt');
  }
}

/**
 * Classify whether retrying an Events API insert is safe. The endpoint is non-idempotent, so only
 * statuses for which Tinybird guarantees no write are retryable. A timeout, network error, or
 * unconfirmed/partial receipt may have committed and must be reconciled by the caller.
 */
export function classifyTinybirdInsertFailure(error: unknown): TinybirdInsertFailureClassification {
  if (!(error instanceof TinybirdInsertError)) {
    return 'uncertain';
  }

  if (error.status === 429 || error.status === 503) {
    return 'retryable';
  }

  if ([400, 401, 403, 404, 413].includes(error.status)) {
    return 'rejected';
  }

  return 'uncertain';
}

export function shouldRetryTinybirdInsert(error: unknown): boolean {
  return classifyTinybirdInsertFailure(error) === 'retryable';
}
