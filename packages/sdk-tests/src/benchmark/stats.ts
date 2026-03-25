export interface Stats {
  count: number;
  avg: number;
  min: number;
  max: number;
  p50: number;
  p75: number;
  p90: number;
  p95: number;
  p99: number;
  stddev: number;
  ci95Lower: number;
  ci95Upper: number;
}

// t-critical values for 95% CI (two-tailed, α=0.05)
const T_TABLE: [number, number][] = [
  [1, 12.706],
  [2, 4.303],
  [3, 3.182],
  [4, 2.776],
  [5, 2.571],
  [7, 2.365],
  [10, 2.228],
  [15, 2.131],
  [20, 2.086],
  [25, 2.06],
  [30, 2.042],
  [40, 2.021],
  [50, 2.009],
  [60, 2.0],
  [80, 1.99],
  [100, 1.984],
  [120, 1.98],
];

function tCritical95(df: number): number {
  if (df <= 0) return 1.96;
  if (df >= 120) return 1.96;
  for (let i = 0; i < T_TABLE.length - 1; i++) {
    const [df0, t0] = T_TABLE[i];
    const [df1, t1] = T_TABLE[i + 1];
    if (df <= df0) return t0 as number;
    if (df <= df1) {
      const frac = (df - df0) / (df1 - df0);
      return (t0 as number) + frac * ((t1 as number) - (t0 as number));
    }
  }
  return 1.96;
}

export function computeStats(values: number[]): Stats {
  const empty: Stats = {
    count: 0,
    avg: 0,
    min: 0,
    max: 0,
    p50: 0,
    p75: 0,
    p90: 0,
    p95: 0,
    p99: 0,
    stddev: 0,
    ci95Lower: 0,
    ci95Upper: 0,
  };
  if (values.length === 0) return empty;

  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const sum = sorted.reduce((a, b) => a + b, 0);
  const avg = sum / n;
  const variance = n > 1 ? sorted.reduce((acc, v) => acc + (v - avg) ** 2, 0) / (n - 1) : 0;
  const stddev = Math.sqrt(variance);

  const t = tCritical95(n - 1);
  const margin = t * (stddev / Math.sqrt(n));

  return {
    count: n,
    avg: round(avg),
    min: sorted[0],
    max: sorted[n - 1],
    p50: percentile(sorted, 0.5),
    p75: percentile(sorted, 0.75),
    p90: percentile(sorted, 0.9),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    stddev: round(stddev),
    ci95Lower: round(avg - margin),
    ci95Upper: round(avg + margin),
  };
}

function percentile(sorted: number[], p: number): number {
  const idx = Math.ceil(p * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function round(v: number): number {
  return Math.round(v * 10) / 10;
}

export function getOutlierMask(values: number[]): boolean[] {
  if (values.length < 4) return values.map(() => true);
  const sorted = [...values].sort((a, b) => a - b);
  const q1 = percentile(sorted, 0.25);
  const q3 = percentile(sorted, 0.75);
  const iqr = q3 - q1;
  const lower = q1 - 3 * iqr;
  const upper = q3 + 3 * iqr;
  return values.map((v) => v >= lower && v <= upper);
}

// --- Table formatting ---

const METRIC_KEYS: (keyof Stats)[] = [
  'avg',
  'min',
  'max',
  'p50',
  'p75',
  'p90',
  'p95',
  'p99',
  'stddev',
];

type Row = string[];

function buildTable(label: string, headers: string[], rows: Row[]): string {
  const colCount = headers.length;
  const widths = headers.map((h) => h.length);
  for (const row of rows) {
    for (let i = 0; i < colCount; i++) {
      widths[i] = Math.max(widths[i], (row[i] ?? '').length);
    }
  }
  const cellWidths = widths.map((w) => w + 2);

  const hLine = (left: string, mid: string, right: string, fill = '─') =>
    left + cellWidths.map((w) => fill.repeat(w)).join(mid) + right;

  const fmtRow = (cells: string[]) =>
    `│${cells.map((c, i) => ` ${c.padEnd(widths[i])} `).join('│')}│`;

  const innerWidth = cellWidths.reduce((a, b) => a + b, 0) + colCount - 1;

  // Truncate label if it would overflow the title row
  const maxLabelLen = innerWidth - 1; // 1 for leading space
  const displayLabel = label.length > maxLabelLen ? `${label.slice(0, maxLabelLen - 1)}…` : label;

  const lines: string[] = [];
  lines.push(`┌${'─'.repeat(innerWidth)}┐`);
  lines.push(`│${` ${displayLabel}`.padEnd(innerWidth)}│`);
  lines.push(hLine('├', '┼', '┤'));
  lines.push(fmtRow(headers));
  lines.push(hLine('├', '┼', '┤'));
  for (const row of rows) lines.push(fmtRow(row));
  lines.push(hLine('└', '┴', '┘'));
  return lines.join('\n');
}

function fmtUnit(v: number, unit: string): string {
  return `${v}${unit}`;
}

export function formatComparisonTable(
  label: string,
  proxied: Stats,
  direct: Stats,
  unit = 'ms',
): string {
  const fmt = (v: number) => fmtUnit(v, unit);
  const headers = ['metric', 'proxied', 'direct', 'overhead'];
  const rows: Row[] = METRIC_KEYS.map((key) => {
    const pv = proxied[key];
    const dv = direct[key];
    let overhead = '';
    if (key !== 'stddev' && key !== 'count' && dv !== 0) {
      const diff = pv - dv;
      const pct = ((diff / dv) * 100).toFixed(1);
      const sign = diff >= 0 ? '+' : '';
      overhead = `${sign}${round(diff)}${unit} (${sign}${pct}%)`;
    }
    return [key, fmt(pv), fmt(dv), overhead];
  });
  rows.push([
    '95% CI',
    `${fmt(proxied.ci95Lower)}–${fmt(proxied.ci95Upper)}`,
    `${fmt(direct.ci95Lower)}–${fmt(direct.ci95Upper)}`,
    '',
  ]);
  return buildTable(label, headers, rows);
}

export function formatOverheadTable(label: string, stats: Stats, unit = 'ms'): string {
  const fmt = (v: number) => fmtUnit(v, unit);
  const headers = ['metric', 'value'];
  const rows: Row[] = METRIC_KEYS.map((key) => [key, fmt(stats[key])]);
  rows.push(['95% CI', `${fmt(stats.ci95Lower)}–${fmt(stats.ci95Upper)}`]);
  return buildTable(label, headers, rows);
}

// --- Markdown report ---

export interface ProviderBenchmarkResult {
  provider: string;
  model: string;
  modes: Record<
    string,
    {
      proxied: Stats;
      direct: Stats;
      overhead: Stats;
      proxiedTtft?: Stats;
      directTtft?: Stats;
      overheadTtft?: Stats;
      proxiedTps?: Stats;
      directTps?: Stats;
      outliersRemoved: number;
      sampleSize: number;
    }
  >;
}

export interface ReportMetadata {
  timestamp: string;
  proxyUrl: string;
  iterations: number;
  warmup: number;
  prompt: string;
  maxTokens: number;
}

export function formatMarkdownReport(
  results: ProviderBenchmarkResult[],
  meta: ReportMetadata,
): string {
  const lines: string[] = [];

  lines.push('## Proxy Latency Benchmark Results');
  lines.push('');
  lines.push(`- **Date**: ${meta.timestamp}`);
  lines.push(`- **Iterations**: ${meta.iterations} per provider (${meta.warmup} warmup)`);
  lines.push(`- **Prompt**: "${meta.prompt}"`);
  lines.push(`- **Max tokens**: ${meta.maxTokens}`);
  lines.push('');

  // Summary table
  lines.push('### Summary');
  lines.push('');
  lines.push(
    '| Provider | Model | Non-stream p50 | Non-stream p95 | Stream TTFT p50 | Stream TTFT p95 | Tok/s (proxied) |',
  );
  lines.push(
    '|----------|-------|----------------|----------------|-----------------|-----------------|-----------------|',
  );
  for (const r of results) {
    const ns = r.modes['non-streaming'];
    const st = r.modes.streaming;
    const nsP50 = ns ? `${ns.overhead.p50}ms` : '—';
    const nsP95 = ns ? `${ns.overhead.p95}ms` : '—';
    const ttftP50 = st?.overheadTtft ? `${st.overheadTtft.p50}ms` : '—';
    const ttftP95 = st?.overheadTtft ? `${st.overheadTtft.p95}ms` : '—';
    const tps = st?.proxiedTps
      ? `${st.proxiedTps.avg}`
      : ns?.proxiedTps
        ? `${ns.proxiedTps.avg}`
        : '—';
    lines.push(
      `| ${r.provider} | ${r.model} | ${nsP50} | ${nsP95} | ${ttftP50} | ${ttftP95} | ${tps} |`,
    );
  }
  lines.push('');

  // Per-provider detail
  for (const r of results) {
    lines.push(`### ${r.provider} (${r.model})`);
    lines.push('');

    for (const [mode, data] of Object.entries(r.modes)) {
      lines.push(`#### ${mode}`);
      lines.push('');
      lines.push(`*${data.sampleSize} samples after ${data.outliersRemoved} outlier(s) removed*`);
      lines.push('');

      // Overhead table
      lines.push('**Proxy overhead (duration)**');
      lines.push('');
      lines.push('| Metric | Value | 95% CI |');
      lines.push('|--------|-------|--------|');
      for (const key of METRIC_KEYS) {
        const ci = key === 'avg' ? `${data.overhead.ci95Lower}ms–${data.overhead.ci95Upper}ms` : '';
        lines.push(`| ${key} | ${data.overhead[key]}ms | ${ci} |`);
      }
      lines.push('');

      if (data.overheadTtft) {
        lines.push('**Proxy overhead (TTFT)**');
        lines.push('');
        lines.push('| Metric | Value | 95% CI |');
        lines.push('|--------|-------|--------|');
        for (const key of METRIC_KEYS) {
          const ci =
            key === 'avg'
              ? `${data.overheadTtft.ci95Lower}ms–${data.overheadTtft.ci95Upper}ms`
              : '';
          lines.push(`| ${key} | ${data.overheadTtft[key]}ms | ${ci} |`);
        }
        lines.push('');
      }

      if (data.proxiedTps) {
        lines.push('**Throughput (tokens/sec)**');
        lines.push('');
        lines.push('| | Proxied | Direct |');
        lines.push('|---|---------|--------|');
        lines.push(`| avg | ${data.proxiedTps.avg} | ${data.directTps?.avg ?? '—'} |`);
        lines.push(`| p50 | ${data.proxiedTps.p50} | ${data.directTps?.p50 ?? '—'} |`);
        lines.push('');
      }
    }
  }

  // Methodology
  lines.push('### Methodology');
  lines.push('');
  lines.push(
    '- **Interleaved pairs**: Each iteration runs one proxied call immediately followed by one direct call to the same provider. This cancels out time-dependent API load variance.',
  );
  lines.push(
    `- **Warmup**: ${meta.warmup} warmup iterations are run and discarded before measurement begins.`,
  );
  lines.push(
    '- **Outlier removal**: Values outside Q1 − 3×IQR to Q3 + 3×IQR are removed (extreme outlier threshold). Sample size shown is after removal.',
  );
  lines.push("- **Confidence intervals**: 95% CI on the mean using Student's t-distribution.");
  lines.push(
    '- **Note on p99**: At n=50, the p99 value is the single highest remaining sample. For reliable p99 estimates, run with n≥300.',
  );
  lines.push('');

  return lines.join('\n');
}
