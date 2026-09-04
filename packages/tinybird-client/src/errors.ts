export class TinybirdAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TinybirdAuthError';
  }
}

export class TinybirdQueryError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'TinybirdQueryError';
    this.status = status;
  }
}

export type TinybirdInsertFailureReason =
  | 'http'
  | 'unconfirmed'
  | 'malformed-receipt'
  | 'partial-receipt';

/**
 * An Events API insert failure. `responseText` keeps the complete provider response for durable
 * recovery, while the printable message excludes it so routine error logging cannot expose data.
 */
export class TinybirdInsertError extends Error {
  readonly status: number;
  readonly responseText: string;
  readonly reason: TinybirdInsertFailureReason;

  constructor(status: number, responseText: string, reason: TinybirdInsertFailureReason = 'http') {
    super(`Tinybird insert failed: status=${status} reason=${reason}`);
    this.name = 'TinybirdInsertError';
    this.status = status;
    this.responseText = responseText;
    this.reason = reason;
  }
}
