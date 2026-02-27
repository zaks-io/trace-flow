import { useMemo } from 'react';
import { Box, Text } from 'ink';
import { Header } from '../components/Header';
import { ProviderLane } from '../components/ProviderLane';
import { MetricsBar } from '../components/MetricsBar';
import { TimingBar } from '../components/TimingBar';
import { TraceBlock } from '../components/TraceBlock';
import { CostReport } from '../components/CostReport';
import type { EngineState } from '../hooks/use-engine';

interface ResultsScreenProps {
  state: EngineState;
  proxyUrl: string;
}

export function ResultsScreen({ state, proxyUrl }: ResultsScreenProps) {
  const { scenario, traceId, providers, finalResult, error, elapsed } = state;

  const modelMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of providers.values()) {
      map.set(p.id, p.model);
    }
    return map;
  }, [providers]);

  const passed = finalResult?.passed ?? 0;
  const failed = finalResult?.failed ?? 0;
  const skipped = finalResult?.skipped ?? 0;
  const total = finalResult?.requestCount ?? 0;
  const results = finalResult?.results ?? [];
  const allPassed = failed === 0 && !error;

  return (
    <Box flexDirection="column" gap={1}>
      <Header scenario={scenario} traceId={traceId} proxyUrl={proxyUrl} />

      <Box flexDirection="column" paddingX={1}>
        {[...providers.values()].map((p) => (
          <ProviderLane
            key={p.id}
            id={p.id}
            name={p.name}
            model={p.model}
            status={p.status}
            results={p.results}
          />
        ))}
      </Box>

      <Box
        borderStyle="single"
        borderColor="#374151"
        borderTop
        borderBottom={false}
        borderLeft={false}
        borderRight={false}
      />

      <Box paddingX={1}>
        <MetricsBar
          passed={passed}
          failed={failed}
          skipped={skipped}
          total={total}
          elapsed={elapsed}
        />
      </Box>

      {results.length > 0 && (
        <Box paddingX={1} flexDirection="column" gap={1}>
          <Text bold dimColor>
            Duration
          </Text>
          <TimingBar results={results} modelMap={modelMap} />
        </Box>
      )}

      {results.length > 0 && (
        <Box paddingX={1}>
          <CostReport results={results} modelMap={modelMap} />
        </Box>
      )}

      {traceId && results.length > 0 && (
        <Box paddingX={1}>
          <TraceBlock traceId={traceId} results={results} />
        </Box>
      )}

      {error && (
        <Box paddingX={1}>
          <Text color="#ef4444" bold>
            Error: {error.message}
          </Text>
        </Box>
      )}

      <Box paddingX={1}>
        {allPassed ? (
          <Text color="#22c55e" bold>
            {'\u2713'} All tests passed
          </Text>
        ) : (
          <Text color="#ef4444" bold>
            {'\u2717'} {failed} test{failed !== 1 ? 's' : ''} failed
          </Text>
        )}
      </Box>
    </Box>
  );
}
