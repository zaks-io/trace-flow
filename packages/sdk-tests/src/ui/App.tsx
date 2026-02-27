import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useApp, useInput } from 'ink';
import type { ProviderConfig } from '../providers';
import { getProvidersByIds } from '../providers';
import { getScenario } from '../scenarios';
import type { Scenario } from '../scenarios/types';
import { generateTraceId, validateTraceId } from '../trace';
import { PROXY_URL } from '../config';
import { TestEngine } from './engine';
import { useEngine } from './hooks/use-engine';
import { SelectScreen } from './screens/SelectScreen';
import { RunScreen } from './screens/RunScreen';
import { ResultsScreen } from './screens/ResultsScreen';

type AppPhase = 'select' | 'run' | 'results';

interface AppProps {
  mode: 'interactive' | 'run';
  scenario?: Scenario;
  providerConfigs?: ProviderConfig[];
  traceId?: string;
  scenarioOpts?: Record<string, unknown>;
  onExit: (exitCode: number) => void;
}

export function App({
  mode,
  scenario: initialScenario,
  providerConfigs: initialProviders,
  traceId: initialTraceId,
  scenarioOpts,
  onExit,
}: AppProps) {
  const { exit } = useApp();
  const [phase, setPhase] = useState<AppPhase>(mode === 'interactive' ? 'select' : 'run');
  const engine = useMemo(() => new TestEngine(), []);
  const state = useEngine(engine);
  const hasStarted = useRef(false);
  const pendingExitCode = useRef<number | null>(null);

  useInput(() => {
    if (phase === 'results' && pendingExitCode.current !== null) {
      onExit(pendingExitCode.current);
      exit();
    }
  });

  const startRun = useCallback(
    (scenario: Scenario, providerConfigs: ProviderConfig[], traceId: string) => {
      if (hasStarted.current) return;
      hasStarted.current = true;
      setPhase('run');

      engine
        .run({
          scenario,
          providerConfigs,
          proxyUrl: PROXY_URL,
          traceId,
          scenarioOpts,
        })
        .then((result) => {
          pendingExitCode.current = result.failed === 0 ? 0 : 1;
          setPhase('results');
        })
        .catch(() => {
          pendingExitCode.current = 1;
          setPhase('results');
        });
    },
    [engine, scenarioOpts],
  );

  // Auto-start for non-interactive mode
  useEffect(() => {
    if (mode === 'run' && initialScenario && initialProviders) {
      const traceId =
        initialTraceId && validateTraceId(initialTraceId) ? initialTraceId : generateTraceId();
      startRun(initialScenario, initialProviders, traceId);
    }
  }, [mode, initialScenario, initialProviders, initialTraceId, startRun]);

  const handleSelect = useCallback(
    (providerIds: string[], scenarioId: string) => {
      const providers = getProvidersByIds(providerIds);
      const scenario = getScenario(scenarioId);
      if (!scenario || providers.length === 0) return;
      const traceId = generateTraceId();
      startRun(scenario, providers, traceId);
    },
    [startRun],
  );

  if (phase === 'select') {
    return <SelectScreen onSelect={handleSelect} />;
  }

  if (phase === 'results' || state.phase === 'done') {
    return <ResultsScreen state={state} proxyUrl={PROXY_URL} />;
  }

  return <RunScreen state={state} proxyUrl={PROXY_URL} />;
}
