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
