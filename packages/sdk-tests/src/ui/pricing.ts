import type { RequestResult } from '../output';

interface ModelPricing {
  input: number;
  output: number;
  cacheWrite?: number;
  cacheRead?: number;
}

// Rates in $/1M tokens
const pricing: Record<string, ModelPricing> = {
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'claude-haiku-4-5': { input: 0.8, output: 4.0, cacheWrite: 1.0, cacheRead: 0.08 },
  'gemini-2.0-flash': { input: 0.1, output: 0.4 },
  'google/gemini-2.5-flash-lite': { input: 0.075, output: 0.3 },
  'openai/gpt-oss-20b': { input: 0.1, output: 0.1 },
};

function getPricing(model: string): ModelPricing | undefined {
  return pricing[model];
}

export interface TokenTotals {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

export interface ProviderPerfSummary {
  avgTtft: number | undefined;
  avgDuration: number;
  tokPerSec: number | undefined;
}

export interface ProviderCostSummary {
  providerId: string;
  providerName: string;
  model: string;
  tokens: TokenTotals;
  cost: number;
  perf: ProviderPerfSummary;
}

export function aggregateTokens(results: RequestResult[]): TokenTotals {
  let input = 0;
  let output = 0;
  let cacheWrite = 0;
  let cacheRead = 0;
  for (const r of results) {
    input += r.inputTokens ?? 0;
    output += r.outputTokens ?? 0;
    cacheWrite += r.cacheCreationTokens ?? 0;
    cacheRead += r.cacheReadTokens ?? 0;
  }
  return { input, output, cacheWrite, cacheRead };
}

export function calculateCost(tokens: TokenTotals, model: string): number {
  const rates = getPricing(model);
  if (!rates) return 0;
  const perM = 1_000_000;
  let cost = (tokens.input / perM) * rates.input + (tokens.output / perM) * rates.output;
  if (rates.cacheWrite) cost += (tokens.cacheWrite / perM) * rates.cacheWrite;
  if (rates.cacheRead) cost += (tokens.cacheRead / perM) * rates.cacheRead;
  return cost;
}

export function calculateProviderCosts(
  results: RequestResult[],
  modelMap: Map<string, string>,
): { providers: ProviderCostSummary[]; totals: TokenTotals; totalCost: number } {
  const byProvider = new Map<string, RequestResult[]>();
  for (const r of results) {
    const list = byProvider.get(r.providerId) ?? [];
    list.push(r);
    byProvider.set(r.providerId, list);
  }

  const providers: ProviderCostSummary[] = [];
  const grandTotals: TokenTotals = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
  let totalCost = 0;

  for (const [providerId, providerResults] of byProvider) {
    const model = modelMap.get(providerId) ?? '';
    const tokens = aggregateTokens(providerResults);
    const cost = calculateCost(tokens, model);

    grandTotals.input += tokens.input;
    grandTotals.output += tokens.output;
    grandTotals.cacheWrite += tokens.cacheWrite;
    grandTotals.cacheRead += tokens.cacheRead;
    totalCost += cost;

    const completed = providerResults.filter((r) => r.status === 'passed');
    const ttfts = completed.map((r) => r.ttft).filter((t): t is number => t != null);
    const avgTtft = ttfts.length > 0 ? ttfts.reduce((a, b) => a + b, 0) / ttfts.length : undefined;
    const durations = completed.map((r) => r.duration).filter((d) => d > 0);
    const avgDuration =
      durations.length > 0 ? durations.reduce((a, b) => a + b, 0) / durations.length : 0;
    const totalDurationSec = durations.reduce((a, b) => a + b, 0) / 1000;
    const tokPerSec =
      totalDurationSec > 0 && tokens.output > 0 ? tokens.output / totalDurationSec : undefined;

    providers.push({
      providerId,
      providerName: providerResults[0]?.provider ?? providerId,
      model,
      tokens,
      cost,
      perf: { avgTtft, avgDuration, tokPerSec },
    });
  }

  return { providers, totals: grandTotals, totalCost };
}

export function formatCost(dollars: number): string {
  if (dollars === 0) return '$0.0000';
  if (dollars < 0.0001) return `$${dollars.toFixed(6)}`;
  return `$${dollars.toFixed(4)}`;
}

export function formatTokenCount(n: number): string {
  if (n === 0) return '—';
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}
