#!/usr/bin/env bun
import { program } from 'commander';
import { PROXY_URL } from './config';
import { getProviders, getProvidersByIds } from './providers';
import { getAllScenarios, getScenario } from './scenarios';
import { generateTraceId, validateTraceId } from './trace';

interface RunOptions {
  providers?: string[];
  scenario?: string;
  json?: boolean;
  interactive?: boolean;
  requests?: number;
  concurrency?: number;
  traceId?: string;
}

program.name('sdk-tests').description('Trace Flow SDK integration test CLI').version('0.0.1');

program
  .command('run')
  .description('Run test scenarios against configured providers')
  .option(
    '-p, --providers <ids>',
    'Comma-separated provider ids (e.g. openai,anthropic). Omit for all available.',
    (v: string) => v.split(',').map((s) => s.trim()),
  )
  .option('-s, --scenario <id>', 'Scenario id (default: basic)', 'basic')
  .option('--json', 'Output results as JSON')
  .option('-i, --interactive', 'Interactive provider/scenario selection')
  .option('--requests <n>', 'Number of requests for multi-request scenarios', parseInt)
  .option('--concurrency <n>', 'Max concurrent requests', parseInt)
  .option('--trace-id <id>', 'Override trace ID for shared-trace scenarios')
  .action(async (opts: RunOptions) => {
    const scenario = opts.interactive ? undefined : getScenario(opts.scenario ?? 'basic');
    if (!opts.interactive && !scenario) {
      console.error(`Unknown scenario: ${opts.scenario}`);
      process.exit(1);
    }

    let providerConfigs: ReturnType<typeof getProviders> | undefined;
    if (!opts.interactive) {
      if (opts.providers?.length) {
        providerConfigs = getProvidersByIds(opts.providers);
        if (providerConfigs.length === 0) {
          console.error(`No valid providers found for: ${opts.providers.join(', ')}`);
          process.exit(1);
        }
      } else {
        providerConfigs = getProviders().filter((p) => process.env[p.envKey]);
        if (providerConfigs.length === 0) {
          console.error('No providers have API keys set. Set env vars or use --providers.');
          process.exit(1);
        }
      }
    }

    if (opts.json && opts.interactive) {
      console.error('--json and --interactive cannot be used together.');
      process.exit(1);
    }

    // JSON mode: no Ink, plain output for CI
    if (opts.json) {
      const traceId =
        opts.traceId && validateTraceId(opts.traceId) ? opts.traceId : generateTraceId();
      const ctx = {
        providerConfigs: providerConfigs!,
        proxyUrl: PROXY_URL,
        jsonMode: true,
        traceId,
      };
      const scenarioOpts: Record<string, unknown> = {};
      if (opts.requests != null) scenarioOpts.requests = opts.requests;
      if (opts.concurrency != null) scenarioOpts.concurrency = opts.concurrency;

      const result = await scenario!.run(ctx, scenarioOpts);
      const { printSummary } = await import('./output');
      printSummary(result, true);
      process.exit(result.failed === 0 ? 0 : 1);
    }

    // Ink UI for interactive and standard run modes
    const { renderUI } = await import('./ui/render');
    const scenarioOpts: Record<string, unknown> = {};
    if (opts.requests != null) scenarioOpts.requests = opts.requests;
    if (opts.concurrency != null) scenarioOpts.concurrency = opts.concurrency;

    const { exitCode } = await renderUI({
      mode: opts.interactive ? 'interactive' : 'run',
      scenario: scenario ?? undefined,
      providerConfigs,
      traceId: opts.traceId,
      scenarioOpts,
    });
    process.exit(exitCode);
  });

program
  .command('providers')
  .description('List configured providers and API key status')
  .option('--json', 'Output as JSON')
  .action((opts: { json?: boolean }) => {
    const all = getProviders();
    const rows = all.map((p) => ({
      id: p.id,
      name: p.name,
      envKey: p.envKey,
      configured: !!process.env[p.envKey],
    }));

    if (opts.json) {
      console.log(JSON.stringify(rows, null, 2));
      return;
    }

    console.log('Providers:');
    console.log('-'.repeat(50));
    for (const r of rows) {
      const status = r.configured ? '✓' : '○';
      console.log(`  ${status} ${r.id.padEnd(12)} (${r.envKey})`);
    }
  });

program
  .command('bench')
  .description('Benchmark proxy latency overhead vs direct provider calls')
  .option('-p, --provider <id>', 'Provider to benchmark (default: openai)', 'openai')
  .option('-n, --iterations <n>', 'Number of measured iterations', (v: string) => Number(v), 50)
  .option('-w, --warmup <n>', 'Warmup iterations to discard', (v: string) => Number(v), 2)
  .option('--all', 'Run benchmark for all providers with API keys set')
  .option('--streaming', 'Only benchmark streaming mode')
  .option('--non-streaming', 'Only benchmark non-streaming mode')
  .option('--prompt <text>', 'Custom prompt', 'Say hello in exactly three words.')
  .option('--max-tokens <n>', 'Max output tokens', (v: string) => Number(v), 50)
  .option('--json', 'Output structured JSON results')
  .option('--markdown', 'Output markdown report for documentation')
  .action(
    async (opts: {
      provider: string;
      iterations: number;
      warmup: number;
      all?: boolean;
      streaming?: boolean;
      nonStreaming?: boolean;
      prompt: string;
      maxTokens: number;
      json?: boolean;
      markdown?: boolean;
    }) => {
      const { runBenchmark } = await import('./benchmark/index');
      // Default: both modes; passing --streaming or --non-streaming narrows to one
      const streaming = opts.streaming === true || opts.nonStreaming !== true;
      const nonStreaming = opts.nonStreaming === true || opts.streaming !== true;
      await runBenchmark({
        provider: opts.provider,
        iterations: opts.iterations,
        warmup: opts.warmup,
        all: opts.all ?? false,
        streaming,
        nonStreaming,
        prompt: opts.prompt,
        maxTokens: opts.maxTokens,
        json: opts.json ?? false,
        markdown: opts.markdown ?? false,
      });
    },
  );

program
  .command('scenarios')
  .description('List available scenario ids')
  .option('--json', 'Output as JSON')
  .action((opts: { json?: boolean }) => {
    const all = getAllScenarios();
    if (opts.json) {
      console.log(
        JSON.stringify(
          all.map((s) => ({ id: s.id, name: s.name, description: s.description })),
          null,
          2,
        ),
      );
      return;
    }
    console.log('Scenarios:');
    console.log('-'.repeat(50));
    for (const s of all) {
      console.log(`  ${s.id.padEnd(28)} ${s.description}`);
    }
  });

program.parse();
