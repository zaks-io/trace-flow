export function formatNumber(num: number): string {
  const sign = num < 0 ? '-' : '';
  const n = Math.abs(num);
  if (n >= 1_000_000_000_000) return `${sign}${(n / 1_000_000_000_000).toFixed(1)}T`;
  if (n >= 1_000_000_000) return `${sign}${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${sign}${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${sign}${(n / 1_000).toFixed(1)}K`;
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
  if (v < 1_000_000) return `${sign}$${(v / 1_000).toFixed(1)}K`;
  if (v < 1_000_000_000) return `${sign}$${(v / 1_000_000).toFixed(1)}M`;
  if (v < 1_000_000_000_000) return `${sign}$${(v / 1_000_000_000).toFixed(1)}B`;
  return `${sign}$${(v / 1_000_000_000_000).toFixed(1)}T`;
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
