import type { LanguageModel } from 'ai';
import {
  getBenchmarkProvider,
  getAvailableBenchmarkProviderIds,
  getAllAvailableBenchmarkProviders,
  type BenchmarkProvider,
} from './models';
import { measureNonStreaming, measureStreaming, type TimingResult } from './runner';
import {
  computeStats,
  getOutlierMask,
  formatComparisonTable,
  formatOverheadTable,
  formatMarkdownReport,
  type Stats,
  type ProviderBenchmarkResult,
  type ReportMetadata,
} from './stats';
import { PROXY_URL } from '../config';

export interface BenchOptions {
  provider: string;
  iterations: number;
  warmup: number;
  streaming: boolean;
  nonStreaming: boolean;
  prompt: string;
  maxTokens: number;
  json: boolean;
  all: boolean;
  markdown: boolean;
}

interface IterationData {
  iteration: number;
  proxied: { duration: number; ttft?: number; outputTokens?: number; tps?: number };
  direct: { duration: number; ttft?: number; outputTokens?: number; tps?: number };
  overhead: { duration: number; ttft?: number };
}

interface ModeResult {
  mode: string;
  raw: IterationData[];
  proxied: { durations: number[]; ttfts: number[]; tps: number[] };
  direct: { durations: number[]; ttfts: number[]; tps: number[] };
  overheads: { durations: number[]; ttfts: number[] };
  errors: string[];
}

interface ModeStats {
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

function computeModeStats(result: ModeResult): ModeStats {
  // Use overhead durations for outlier detection — filter all paired arrays by the same mask
  const mask = getOutlierMask(result.overheads.durations);
  const keep = (arr: number[]) => arr.filter((_, i) => mask[i]);
  const removed = mask.filter((v) => !v).length;

  const filteredProxiedDur = keep(result.proxied.durations);
  const filteredDirectDur = keep(result.direct.durations);
  const filteredOverheadDur = keep(result.overheads.durations);

  const stats: ModeStats = {
    proxied: computeStats(filteredProxiedDur),
    direct: computeStats(filteredDirectDur),
    overhead: computeStats(filteredOverheadDur),
    outliersRemoved: removed,
    sampleSize: filteredOverheadDur.length,
  };

  // TTFT stats (streaming only) — apply separate TTFT outlier mask intersected with duration mask
  if (result.proxied.ttfts.length > 0 && result.direct.ttfts.length > 0) {
    const ttftMask = getOutlierMask(result.overheads.ttfts);
    const combinedMask = mask.map((v, i) => v && (ttftMask[i] ?? true));
    const keepTtft = (arr: number[]) => arr.filter((_, i) => combinedMask[i]);
    stats.proxiedTtft = computeStats(keepTtft(result.proxied.ttfts));
    stats.directTtft = computeStats(keepTtft(result.direct.ttfts));
    stats.overheadTtft = computeStats(keepTtft(result.overheads.ttfts));
  }

  // Throughput stats
  if (result.proxied.tps.length > 0) {
    const filteredProxiedTps = keep(result.proxied.tps);
    const filteredDirectTps = keep(result.direct.tps);
    stats.proxiedTps = computeStats(filteredProxiedTps);
    stats.directTps = computeStats(filteredDirectTps);
  }

  return stats;
}

export async function runBenchmark(opts: BenchOptions): Promise<void> {
  const providers = opts.all
    ? getAllAvailableBenchmarkProviders()
    : (() => {
        const bp = getBenchmarkProvider(opts.provider);
        if (!bp) {
          const available = getAvailableBenchmarkProviderIds();
          console.error(`Provider "${opts.provider}" not available.`);
          if (available.length > 0) console.error(`Available: ${available.join(', ')}`);
          else console.error('No providers have API keys set.');
          process.exit(1);
        }
        return [bp];
      })();

  if (providers.length === 0) {
    console.error('No providers have API keys set.');
    process.exit(1);
  }

  if (opts.iterations < 1 || opts.warmup < 0) {
    console.error('Iterations must be >= 1 and warmup must be >= 0.');
    process.exit(1);
  }

  const modes: {
    label: string;
    measure: (model: LanguageModel, prompt: string, maxTokens: number) => Promise<TimingResult>;
  }[] = [];
  if (opts.nonStreaming) modes.push({ label: 'non-streaming', measure: measureNonStreaming });
  if (opts.streaming) modes.push({ label: 'streaming', measure: measureStreaming });

  const meta: ReportMetadata = {
    timestamp: new Date().toISOString(),
    proxyUrl: PROXY_URL,
    iterations: opts.iterations,
    warmup: opts.warmup,
    prompt: opts.prompt,
    maxTokens: opts.maxTokens,
  };

  const allProviderResults: ProviderBenchmarkResult[] = [];
  const jsonProviders: unknown[] = [];

  for (const bp of providers) {
    if (!opts.json && !opts.markdown) {
      console.log(`\nLatency Benchmark: ${bp.name} (${bp.model})`);
      console.log(
        `  Iterations: ${opts.iterations} | Warmup: ${opts.warmup} | Prompt: "${opts.prompt}"`,
      );
      console.log();
    }

    const providerResult: ProviderBenchmarkResult = {
      provider: bp.name,
      model: bp.model,
      modes: {},
    };
    const jsonModes: Record<string, unknown> = {};

    for (const mode of modes) {
      const result = await runMode(mode.label, mode.measure, bp, opts);
      const stats = computeModeStats(result);

      providerResult.modes[mode.label] = stats;

      if (opts.json) {
        jsonModes[mode.label] = {
          raw: result.raw,
          stats,
          outliersRemoved: stats.outliersRemoved,
          sampleSize: stats.sampleSize,
          errors: result.errors,
        };
        continue;
      }

      if (!opts.markdown) {
        printModeResults(mode.label, bp.name, stats, result.errors);
      }
    }

    allProviderResults.push(providerResult);
    jsonProviders.push({ provider: bp.id, model: bp.model, modes: jsonModes });
  }

  if (opts.json) {
    console.log(JSON.stringify({ metadata: meta, providers: jsonProviders }, null, 2));
  }

  if (opts.markdown) {
    console.log(formatMarkdownReport(allProviderResults, meta));
  }
}

function printModeResults(
  modeLabel: string,
  providerName: string,
  stats: ModeStats,
  errors: string[],
): void {
  if (stats.outliersRemoved > 0) {
    console.log(
      `  ${stats.sampleSize} samples (${stats.outliersRemoved} outlier${stats.outliersRemoved === 1 ? '' : 's'} removed)`,
    );
  }

  console.log(
    formatComparisonTable(`${modeLabel} — duration — ${providerName}`, stats.proxied, stats.direct),
  );
  console.log();
  console.log(
    formatOverheadTable(`${modeLabel} — proxy overhead — ${providerName}`, stats.overhead),
  );
  console.log();

  if (stats.proxiedTtft && stats.directTtft && stats.overheadTtft) {
    console.log(
      formatComparisonTable(
        `${modeLabel} — ttft — ${providerName}`,
        stats.proxiedTtft,
        stats.directTtft,
      ),
    );
    console.log();
    console.log(
      formatOverheadTable(`${modeLabel} — ttft overhead — ${providerName}`, stats.overheadTtft),
    );
    console.log();
  }

  if (stats.proxiedTps && stats.directTps) {
    console.log(
      formatComparisonTable(
        `${modeLabel} — tokens/sec — ${providerName}`,
        stats.proxiedTps,
        stats.directTps,
        ' tok/s',
      ),
    );
    console.log();
  }

  if (errors.length > 0) {
    console.log(`  Errors (${errors.length}):`);
    for (const err of errors) console.log(`    - ${err}`);
    console.log();
  }
}

async function runMode(
  label: string,
  measure: (model: LanguageModel, prompt: string, maxTokens: number) => Promise<TimingResult>,
  bp: BenchmarkProvider,
  opts: BenchOptions,
): Promise<ModeResult> {
  const result: ModeResult = {
    mode: label,
    raw: [],
    proxied: { durations: [], ttfts: [], tps: [] },
    direct: { durations: [], ttfts: [], tps: [] },
    overheads: { durations: [], ttfts: [] },
    errors: [],
  };

  const proxiedModel = bp.createProxiedModel();
  const directModel = bp.createDirectModel();
  const quiet = opts.json || opts.markdown;

  // Warmup — interleaved
  if (!quiet) process.stdout.write(`  ${label} warmup...`);
  for (let i = 0; i < opts.warmup; i++) {
    await measure(proxiedModel, opts.prompt, opts.maxTokens);
    await measure(directModel, opts.prompt, opts.maxTokens);
  }
  if (!quiet) console.log(' done');

  // Measured — interleaved pairs
  if (!quiet) process.stdout.write(`  ${label}: `);
  for (let i = 0; i < opts.iterations; i++) {
    const proxied = await measure(proxiedModel, opts.prompt, opts.maxTokens);
    const direct = await measure(directModel, opts.prompt, opts.maxTokens);

    if (proxied.success && direct.success) {
      result.proxied.durations.push(proxied.duration);
      result.direct.durations.push(direct.duration);
      result.overheads.durations.push(proxied.duration - direct.duration);

      if (proxied.ttft != null && direct.ttft != null) {
        result.proxied.ttfts.push(proxied.ttft);
        result.direct.ttfts.push(direct.ttft);
        result.overheads.ttfts.push(proxied.ttft - direct.ttft);
      }

      const proxiedTps =
        proxied.outputTokens != null && proxied.duration > 0
          ? Math.round((proxied.outputTokens / proxied.duration) * 1000 * 10) / 10
          : undefined;
      const directTps =
        direct.outputTokens != null && direct.duration > 0
          ? Math.round((direct.outputTokens / direct.duration) * 1000 * 10) / 10
          : undefined;

      if (proxiedTps != null && directTps != null) {
        result.proxied.tps.push(proxiedTps);
        result.direct.tps.push(directTps);
      }

      result.raw.push({
        iteration: i + 1,
        proxied: {
          duration: proxied.duration,
          ttft: proxied.ttft,
          outputTokens: proxied.outputTokens,
          tps: proxiedTps,
        },
        direct: {
          duration: direct.duration,
          ttft: direct.ttft,
          outputTokens: direct.outputTokens,
          tps: directTps,
        },
        overhead: {
          duration: proxied.duration - direct.duration,
          ttft:
            proxied.ttft != null && direct.ttft != null ? proxied.ttft - direct.ttft : undefined,
        },
      });

      if (!quiet) process.stdout.write(`${i + 1}/${opts.iterations} `);
    } else {
      if (!proxied.success) result.errors.push(`proxied #${i + 1}: ${proxied.error}`);
      if (!direct.success) result.errors.push(`direct #${i + 1}: ${direct.error}`);
      if (!quiet) process.stdout.write('x');
    }
  }
  if (!quiet) console.log();

  return result;
}
