import { getProviders } from './providers';
import { getAllScenarios } from './scenarios';
import { generateTraceId, validateTraceId } from './trace';

export async function runInteractive(opts: {
  scenario?: string;
  providers?: string[];
  json?: boolean;
  requests?: number;
  concurrency?: number;
  traceId?: string;
}): Promise<void> {
  const providers = getProviders();
  const scenarios = getAllScenarios();
  const available = providers.filter((p) => process.env[p.envKey]);

  if (available.length === 0) {
    console.error('No providers configured. Set at least one API key in .env');
    process.exit(1);
  }

  if (scenarios.length === 0) {
    console.error('No scenarios registered.');
    process.exit(1);
  }

  console.log('\nInteractive mode\n');
  console.log('Available providers:', available.map((p) => p.id).join(', '));
  console.log('Available scenarios:', scenarios.map((s) => s.id).join(', '));
  console.log('\nTo run non-interactively, use: bun run cli run --providers <ids> --scenario <id>');
  console.log('Example: bun run cli run -p openai -s basic\n');

  const readline = await import('readline/promises');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  const providerInput = await rl.question(
    `Providers (comma-separated, or "all") [${available[0]!.id}]: `,
  );
  const scenarioInput = await rl.question(`Scenario [basic]: `);

  rl.close();

  const providerIds =
    !providerInput || providerInput.toLowerCase() === 'all'
      ? available.map((p) => p.id)
      : providerInput
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
  const scenarioId = scenarioInput?.trim() || 'basic';

  const { getScenario } = await import('./scenarios');
  const scenario = getScenario(scenarioId);
  if (!scenario) {
    console.error(`Unknown scenario: ${scenarioId}`);
    process.exit(1);
  }

  const { getProvidersByIds } = await import('./providers');
  const { PROXY_URL } = await import('./config');
  const providerConfigs = getProvidersByIds(providerIds);

  const traceId = opts.traceId && validateTraceId(opts.traceId) ? opts.traceId : generateTraceId();

  const ctx = {
    providerConfigs,
    proxyUrl: PROXY_URL,
    jsonMode: !!opts.json,
    traceId,
  };
  const scenarioOpts: Record<string, unknown> = {};
  if (opts.requests != null) scenarioOpts.requests = opts.requests;
  if (opts.concurrency != null) scenarioOpts.concurrency = opts.concurrency;

  const result = await scenario.run(ctx, scenarioOpts);
  const { printSummary } = await import('./output');
  printSummary(result, !!opts.json);

  process.exit(result.failed === 0 ? 0 : 1);
}
