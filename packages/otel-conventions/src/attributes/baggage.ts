/**
 * W3C Baggage entries become `baggage.{key}` attributes on the Root Span. The
 * key set is unbounded (caller-controlled), so we don't include the prefix in
 * the centralized key list — only the prefix string.
 */
export const BAGGAGE_PREFIX = 'baggage.';

export function baggageAttributes(baggage: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(baggage)) {
    out[`${BAGGAGE_PREFIX}${key}`] = value;
  }
  return out;
}
