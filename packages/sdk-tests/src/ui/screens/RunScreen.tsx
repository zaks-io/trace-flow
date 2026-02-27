import { Box } from 'ink';
import { Spinner } from '@inkjs/ui';
import { Header } from '../components/Header';
import { ProviderLane } from '../components/ProviderLane';
import { MetricsBar } from '../components/MetricsBar';
import type { EngineState } from '../hooks/use-engine';

interface RunScreenProps {
  state: EngineState;
  proxyUrl: string;
}

export function RunScreen({ state, proxyUrl }: RunScreenProps) {
  const { scenario, traceId, providers, results, elapsed } = state;

  const passed = results.filter((r) => r.status === 'passed').length;
  const failed = results.filter((r) => r.status === 'failed').length;
  const skipped = results.filter((r) => r.status === 'skipped').length;

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
        {providers.size === 0 && (
          <Box gap={1}>
            <Spinner label="Starting..." />
          </Box>
        )}
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
          total={results.length}
          elapsed={elapsed}
        />
      </Box>
    </Box>
  );
}
