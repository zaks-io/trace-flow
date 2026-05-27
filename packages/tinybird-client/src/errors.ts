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

/** A non-2xx response from the Events API insert endpoint. `status` drives retry classification. */
export class TinybirdInsertError extends Error {
  readonly status: number;
  readonly responseText: string;

  constructor(status: number, responseText: string) {
    super(`Tinybird insert failed: ${status} ${responseText}`);
    this.name = 'TinybirdInsertError';
    this.status = status;
    this.responseText = responseText;
  }
}
