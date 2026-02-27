import { useEffect, useRef, useState } from 'react';
import type { RequestResult, ScenarioResult } from '../../output';
import type { ProviderInfo, TestEngine } from '../engine';

export interface ProviderState {
  id: string;
  name: string;
  model: string;
  status: 'pending' | 'running' | 'done';
  results: RequestResult[];
}

export interface EngineState {
  phase: 'idle' | 'running' | 'done';
  scenario: string | null;
  traceId: string | null;
  providers: Map<string, ProviderState>;
  results: RequestResult[];
  finalResult: ScenarioResult | null;
  error: Error | null;
  elapsed: number;
}

const initialState: EngineState = {
  phase: 'idle',
  scenario: null,
  traceId: null,
  providers: new Map(),
  results: [],
  finalResult: null,
  error: null,
  elapsed: 0,
};

export function useEngine(engine: TestEngine): EngineState {
  const [state, setState] = useState<EngineState>(initialState);
  const startRef = useRef<number | null>(null);

  useEffect(() => {
    const onStart = ({
      scenario,
      providers,
      traceId,
    }: {
      scenario: string;
      providers: ProviderInfo[];
      traceId: string;
    }) => {
      startRef.current = Date.now();
      const providerMap = new Map<string, ProviderState>();
      for (const p of providers) {
        providerMap.set(p.id, {
          id: p.id,
          name: p.name,
          model: p.model,
          status: 'pending',
          results: [],
        });
      }
      setState({
        phase: 'running',
        scenario,
        traceId,
        providers: providerMap,
        results: [],
        finalResult: null,
        error: null,
        elapsed: 0,
      });
    };

    const onResult = ({ result }: { result: RequestResult }) => {
      setState((prev) => {
        const providers = new Map(prev.providers);
        const provider = providers.get(result.providerId);
        if (provider) {
          const updated = {
            ...provider,
            name: result.provider,
            status: 'running' as const,
            results: [...provider.results, result],
          };
          providers.set(result.providerId, updated);
        }
        return {
          ...prev,
          providers,
          results: [...prev.results, result],
        };
      });
    };

    const onDone = ({ result }: { result: ScenarioResult }) => {
      setState((prev) => {
        const providers = new Map(prev.providers);
        for (const [id, p] of providers) {
          providers.set(id, { ...p, status: 'done' });
        }
        return {
          ...prev,
          phase: 'done',
          providers,
          finalResult: result,
          elapsed: startRef.current ? Date.now() - startRef.current : 0,
        };
      });
    };

    const onError = ({ error }: { error: Error }) => {
      setState((prev) => ({
        ...prev,
        phase: 'done',
        error,
        elapsed: startRef.current ? Date.now() - startRef.current : 0,
      }));
    };

    engine.on('run:start', onStart);
    engine.on('result:complete', onResult);
    engine.on('run:done', onDone);
    engine.on('run:error', onError);

    return () => {
      engine.off('run:start', onStart);
      engine.off('result:complete', onResult);
      engine.off('run:done', onDone);
      engine.off('run:error', onError);
    };
  }, [engine]);

  // Elapsed timer tick
  useEffect(() => {
    if (state.phase !== 'running') return;
    const interval = setInterval(() => {
      setState((prev) => ({
        ...prev,
        elapsed: startRef.current ? Date.now() - startRef.current : 0,
      }));
    }, 100);
    return () => clearInterval(interval);
  }, [state.phase]);

  return state;
}
