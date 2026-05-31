// Descending so the first tier a value clears is the largest applicable one.
const ABBREVIATIONS = [
  { value: 1_000_000_000_000, suffix: 'T' },
  { value: 1_000_000_000, suffix: 'B' },
  { value: 1_000_000, suffix: 'M' },
  { value: 1_000, suffix: 'K' },
] as const;

/**
 * Abbreviate a non-negative magnitude to one decimal, promoting at unit boundaries:
 * rounding 999_950 to 1000.0K would mislabel a megacount, so it carries up to 1.0M.
 * Returns null below 1_000 so each caller keeps its own small-value formatting.
 */
function abbreviate(n: number): { mantissa: string; suffix: string } | null {
  for (let i = 0; i < ABBREVIATIONS.length; i++) {
    const { value, suffix } = ABBREVIATIONS[i];
    if (n < value) continue;
    const rounded = Number((n / value).toFixed(1));
    if (rounded >= 1000 && i > 0) {
      const next = ABBREVIATIONS[i - 1];
      return { mantissa: (n / next.value).toFixed(1), suffix: next.suffix };
    }
    return { mantissa: rounded.toFixed(1), suffix };
  }
  return null;
}

export function formatNumber(num: number): string {
  const sign = num < 0 ? '-' : '';
  const abbr = abbreviate(Math.abs(num));
  if (abbr) return `${sign}${abbr.mantissa}${abbr.suffix}`;
  return new Intl.NumberFormat().format(num);
}

export function formatCurrency(value: number | null): string {
  if (value === null || isNaN(value)) return '-';
  const sign = value < 0 ? '-' : '';
  const v = Math.abs(value);
  if (v < 0.01) return `${sign}$${v.toFixed(4)}`;
  if (v < 1) return `${sign}$${v.toFixed(3)}`;
  if (v < 1_000) return `${sign}$${v.toFixed(2)}`;
  // Abbreviate at scale, matching token style.
  const abbr = abbreviate(v);
  return `${sign}$${abbr!.mantissa}${abbr!.suffix}`;
}

export function formatPercent(value: number): string {
  if (value < 1) return `${value.toFixed(1)}%`;
  return `${Math.round(value)}%`;
}

export function formatDuration(ms: number | null): string {
  if (ms === null || isNaN(ms)) return '-';
  if (ms < 1) return `${(ms * 1000).toFixed(0)}μs`;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

export function formatModelDisplay(model: string, provider?: string): string {
  if (!provider) return model;
  const name = model.includes('/') ? model.split('/').slice(1).join('/') : model;
  return `${provider}/${name}`;
}

/**
 * Parse a Tinybird/ClickHouse datetime as UTC. ClickHouse serializes DateTime over JSON as
 * `"2025-05-30 01:00:00"` (space-separated, no zone) — `new Date()` reads that as *local*, so a
 * UTC bucket renders shifted by the viewer's offset. We bucket in UTC and display in local, so
 * normalize to ISO-UTC (`T` + `Z`) before parsing. Values already carrying a zone (`Z`/`±hh:mm`)
 * or epoch numbers pass straight through.
 */
export function parseTinybirdDate(value: string | number): Date {
  if (typeof value === 'number') return new Date(value);
  const trimmed = value.trim();
  if (/[zZ]$|[+-]\d\d:?\d\d$/.test(trimmed)) return new Date(trimmed);
  return new Date(trimmed.replace(' ', 'T') + 'Z');
}

/** Bucket-axis tick label. `includeTime` adds the hour for sub-day (hourly) granularity. */
export function formatBucketTick(value: string, includeTime: boolean): string {
  const date = parseTinybirdDate(value);
  if (Number.isNaN(date.getTime())) return value;
  if (includeTime) {
    return date.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      hour12: true,
    });
  }
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** Bucket tooltip label — like the tick but with minutes, for the hovered hourly point. */
export function formatBucketTooltip(value: string): string {
  const date = parseTinybirdDate(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

export function formatRelativeTime(nanoseconds: number): string {
  const ms = nanoseconds / 1_000_000;
  const seconds = Math.floor((Date.now() - ms) / 1000);
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
