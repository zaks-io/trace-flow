export function isRetryableDurableObjectError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { overloaded?: unknown; retryable?: unknown };
  return candidate.retryable === true && candidate.overloaded !== true;
}
