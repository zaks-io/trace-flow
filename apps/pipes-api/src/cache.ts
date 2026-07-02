const TWO_MINUTES_MS = 2 * 60 * 1000;

export async function hashString(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = new Uint8Array(hashBuffer);
  return Array.from(hashArray, (b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 32);
}

export function buildCacheKey(
  pipe: string,
  tokenHash: string,
  searchParams: URLSearchParams,
): string {
  const filtered = [...searchParams.entries()]
    .filter(
      ([key]) =>
        key !== 'token' && key !== 'api_keys' && key !== 'org_id' && key !== 'retention_days',
    )
    .sort(([a], [b]) => a.localeCompare(b));
  const sorted = new URLSearchParams(filtered).toString();

  return `cache:v2:${pipe}:${tokenHash}:${sorted}`;
}

export function computeTTL(pipe: string, searchParams: URLSearchParams): number {
  // Live polling queries — bypass cache
  if (searchParams.has('after_received_at')) {
    return 0;
  }

  if (pipe === 'filter_options') {
    return 120;
  }

  // Check if querying recent data (end_time_ns within last 2 min)
  const endTimeNs = searchParams.get('end_time_ns');
  if (endTimeNs) {
    const endTimeMs = Number(endTimeNs) / 1_000_000;
    if (Date.now() - endTimeMs < TWO_MINUTES_MS) {
      return 30;
    }
  }

  return 300;
}
