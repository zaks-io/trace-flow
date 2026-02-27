import { Box, Text } from 'ink';
import type { RequestResult } from '../../output';

interface TraceBlockProps {
  traceId: string;
  results: RequestResult[];
}

export function TraceBlock({ traceId, results }: TraceBlockProps) {
  const withSpans = results.filter((r) => r.spanId);
  if (withSpans.length === 0) return null;

  return (
    <Box flexDirection="column" borderStyle="single" borderColor="#4b5563" paddingX={1}>
      <Text bold color="#94a3b8">
        Trace Correlation
      </Text>
      <Text dimColor>
        ID: <Text color="#67e8f9">{traceId}</Text>
      </Text>
      {withSpans.map((r, i) => {
        const label = r.label ?? `request ${(r.requestIndex ?? 0) + 1}`;
        return (
          <Text key={i} dimColor>
            {'  '}
            {label}: {r.provider}
            {r.spanId && <Text color="#4b5563"> (span {r.spanId.slice(0, 8)})</Text>}
          </Text>
        );
      })}
    </Box>
  );
}
