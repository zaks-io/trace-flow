export const STATUS_CODE = {
  OK: 'STATUS_CODE_OK',
  ERROR: 'STATUS_CODE_ERROR',
  UNSET: 'STATUS_CODE_UNSET',
} as const;

export type SpanStatus = 'ok' | 'error' | 'unset';

const SPAN_STATUS_BY_NAME: Record<string, SpanStatus> = {
  [STATUS_CODE.OK]: 'ok',
  [STATUS_CODE.ERROR]: 'error',
  [STATUS_CODE.UNSET]: 'unset',
  OK: 'ok',
  ERROR: 'error',
  UNSET: 'unset',
};

const SPAN_STATUS_LABELS: Record<SpanStatus, string> = {
  ok: 'OK',
  error: 'Error',
  unset: 'Unset',
};

/**
 * Tinybird stores OTel proto names (`STATUS_CODE_ERROR`); older code uses bare names
 * (`ERROR`). A missing status is OTel's default, unset. Anything else throws, because
 * guessing would silently hide errors (a typo read as unset never fires `is_error`).
 */
export function normalizeSpanStatus(raw: unknown): SpanStatus {
  if (raw === undefined || raw === null || raw === '') return 'unset';
  const status = typeof raw === 'string' ? SPAN_STATUS_BY_NAME[raw.toUpperCase()] : undefined;
  if (!status) throw new Error(`Unexpected span status code: ${JSON.stringify(raw)}`);
  return status;
}

export function isErrorStatus(raw: unknown): boolean {
  return normalizeSpanStatus(raw) === 'error';
}

export function statusLabel(raw: unknown): string {
  return SPAN_STATUS_LABELS[normalizeSpanStatus(raw)];
}
