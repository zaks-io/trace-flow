export function generateId(): string {
  return crypto.randomUUID();
}

export function generateSpanId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function generateTraceId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function validateTraceId(traceId: string | null | undefined): string | null {
  if (!traceId) return null;
  const normalized = traceId.toLowerCase();
  return /^[0-9a-f]{32}$/.test(normalized) ? normalized : null;
}

export function validateSpanId(spanId: string | null | undefined): string | null {
  if (!spanId) return null;
  const normalized = spanId.toLowerCase();
  return /^[0-9a-f]{16}$/.test(normalized) ? normalized : null;
}
