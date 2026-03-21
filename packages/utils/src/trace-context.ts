// W3C Trace Context types and utilities
// https://www.w3.org/TR/trace-context/

export interface TraceparentData {
  version: string;
  traceId: string;
  parentId: string;
  flags: number;
}

const TRACEPARENT_REGEX = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

export function parseTraceparent(header: string | null | undefined): TraceparentData | null {
  if (!header) return null;

  const match = TRACEPARENT_REGEX.exec(header.toLowerCase());
  if (!match) return null;

  // Regex guarantees all 4 capture groups exist when matched
  const version = match[1]!;
  const traceId = match[2]!;
  const parentId = match[3]!;
  const flags = match[4]!;

  // Reject invalid all-zero trace-id or parent-id per spec
  if (traceId === '00000000000000000000000000000000') return null;
  if (parentId === '0000000000000000') return null;

  return {
    version,
    traceId,
    parentId,
    flags: parseInt(flags, 16),
  };
}

export function formatTraceparent(traceId: string, parentId: string, flags = 0x01): string {
  const version = '00';
  const flagsHex = flags.toString(16).padStart(2, '0');
  return `${version}-${traceId.toLowerCase()}-${parentId.toLowerCase()}-${flagsHex}`;
}

// W3C Baggage utilities
// https://www.w3.org/TR/baggage/

export function parseBaggage(header: string | null | undefined): Record<string, string> {
  if (!header) return {};

  const result: Record<string, string> = {};

  for (const item of header.split(',')) {
    const trimmed = item.trim();
    if (!trimmed) continue;

    // Split on first '=' only, value may contain '='
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;

    const key = trimmed.slice(0, eqIndex).trim();
    const value = trimmed.slice(eqIndex + 1).trim();

    if (key) {
      // Decode percent-encoded values per spec
      try {
        result[key] = decodeURIComponent(value);
      } catch {
        result[key] = value;
      }
    }
  }

  return result;
}

export function formatBaggage(entries: Record<string, string>): string {
  return Object.entries(entries)
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join(',');
}
