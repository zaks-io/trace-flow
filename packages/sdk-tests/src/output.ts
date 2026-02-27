export interface RequestResult {
  provider: string;
  providerId: string;
  scenario: string;
  requestIndex?: number;
  label?: string;
  traceId?: string;
  spanId?: string;
  duration: number;
  ttft?: number;
  status: 'passed' | 'failed' | 'skipped';
  error?: string;
  text?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
  debug?: unknown;
}

export interface ScenarioResult {
  scenario: string;
  traceId?: string;
  requestCount: number;
  passed: number;
  failed: number;
  skipped: number;
  results: RequestResult[];
  duration: number;
}

export function log(provider: string, message: string): void {
  console.log(`[${provider}] ${message}`);
}

export function success(provider: string, message: string): void {
  console.log(`[${provider}] ✓ ${message}`);
}

export function error(provider: string, message: string): void {
  console.error(`[${provider}] ✗ ${message}`);
}

export function formatResult(result: RequestResult, indent = '  '): string {
  const status = result.status === 'passed' ? '✓' : result.status === 'failed' ? '✗' : '○';
  const label = result.label ?? `request ${(result.requestIndex ?? 0) + 1}`;
  let line = `${indent}${status} ${result.provider} (${label})`;
  if (result.duration > 0) line += ` ${result.duration}ms`;
  if (result.ttft != null) line += ` TTFT: ${result.ttft}ms`;
  if (result.cacheCreationTokens != null) line += ` cache-write: ${result.cacheCreationTokens}`;
  if (result.cacheReadTokens != null) line += ` cache-read: ${result.cacheReadTokens}`;
  if (result.status === 'failed' && result.error) line += ` — ${result.error}`;
  if (result.status === 'skipped') line += ` — ${result.error ?? 'skipped'}`;
  return line;
}

export function printTraceCorrelationBlock(traceId: string, results: RequestResult[]): void {
  console.log('\n--- Trace Correlation ---');
  console.log(`Trace ID: ${traceId}`);
  console.log('Use this ID in the dashboard to view all requests grouped under this trace.\n');
  for (const r of results) {
    const label = r.label ?? `request ${(r.requestIndex ?? 0) + 1}`;
    const span = r.spanId ? ` (span ${r.spanId.slice(0, 8)}…)` : '';
    console.log(`  ${label}: ${r.provider}${span}`);
  }
  console.log('-------------------------\n');
}

export function printSummary(result: ScenarioResult, jsonMode: boolean): void {
  if (jsonMode) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const sep = '='.repeat(60);
  console.log(`\n${sep}`);
  console.log('Summary');
  console.log(`${sep}`);
  console.log(
    `  Scenario: ${result.scenario} | Requests: ${result.requestCount} | Passed: ${result.passed} | Failed: ${result.failed} | Skipped: ${result.skipped} | Duration: ${result.duration}ms`,
  );
  for (const r of result.results) {
    console.log(formatResult(r));
  }
  if (result.traceId) {
    printTraceCorrelationBlock(result.traceId, result.results);
  }
  const allPassed = result.failed === 0;
  console.log(allPassed ? '✓ All passed' : '✗ Some failed');
}
