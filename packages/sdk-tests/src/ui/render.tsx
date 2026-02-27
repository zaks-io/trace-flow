import { render } from 'ink';
import type { ProviderConfig } from '../providers';
import type { Scenario } from '../scenarios/types';
import { App } from './App';

interface RenderOptions {
  mode: 'interactive' | 'run';
  scenario?: Scenario;
  providerConfigs?: ProviderConfig[];
  traceId?: string;
  scenarioOpts?: Record<string, unknown>;
}

export async function renderUI(options: RenderOptions): Promise<{ exitCode: number }> {
  return new Promise((resolve) => {
    const { waitUntilExit } = render(
      <App
        mode={options.mode}
        scenario={options.scenario}
        providerConfigs={options.providerConfigs}
        traceId={options.traceId}
        scenarioOpts={options.scenarioOpts}
        onExit={(exitCode) => resolve({ exitCode })}
      />,
    );

    waitUntilExit().catch(() => resolve({ exitCode: 1 }));
  });
}
