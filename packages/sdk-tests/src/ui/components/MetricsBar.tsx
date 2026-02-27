import { Box, Text } from 'ink';
import { statusColors } from '../theme';

interface MetricsBarProps {
  passed: number;
  failed: number;
  skipped: number;
  total: number;
  elapsed: number;
}

function formatElapsed(ms: number): string {
  if (ms >= 60_000) {
    const m = Math.floor(ms / 60_000);
    const s = ((ms % 60_000) / 1000).toFixed(1);
    return `${m}m ${s}s`;
  }
  return `${(ms / 1000).toFixed(1)}s`;
}

export function MetricsBar({ passed, failed, skipped, total, elapsed }: MetricsBarProps) {
  return (
    <Box gap={1}>
      <Text color={statusColors.passed} bold>
        Passed: {passed}
      </Text>
      <Text dimColor>\u2502</Text>
      <Text color={failed > 0 ? statusColors.failed : '#6b7280'} bold={failed > 0}>
        Failed: {failed}
      </Text>
      <Text dimColor>\u2502</Text>
      <Text color={statusColors.skipped}>Skipped: {skipped}</Text>
      <Text dimColor>\u2502</Text>
      <Text dimColor>Total: {total}</Text>
      <Text dimColor>\u2502</Text>
      <Text color="#a5b4fc">{formatElapsed(elapsed)}</Text>
    </Box>
  );
}
