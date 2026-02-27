import { Box, Text } from 'ink';
import type { RequestResult } from '../../output';
import { getProviderColor } from '../theme';

interface TimingBarProps {
  results: RequestResult[];
  modelMap: Map<string, string>;
}

const BAR_WIDTH = 30;

export function TimingBar({ results, modelMap }: TimingBarProps) {
  // Group by provider, sum total duration across all requests
  const providerDurations = new Map<string, { model: string; id: string; totalDuration: number }>();
  for (const r of results) {
    if (r.status === 'skipped') continue;
    const existing = providerDurations.get(r.providerId);
    if (existing) {
      existing.totalDuration += r.duration;
    } else {
      providerDurations.set(r.providerId, {
        model: modelMap.get(r.providerId) ?? r.provider,
        id: r.providerId,
        totalDuration: r.duration,
      });
    }
  }

  const entries = [...providerDurations.values()].sort((a, b) => b.totalDuration - a.totalDuration);
  if (entries.length === 0) return null;

  const maxDuration = entries[0]!.totalDuration;

  return (
    <Box flexDirection="column" gap={0}>
      {entries.map((entry) => {
        const ratio = maxDuration > 0 ? entry.totalDuration / maxDuration : 0;
        const filled = Math.max(1, Math.round(ratio * BAR_WIDTH));
        const empty = BAR_WIDTH - filled;
        const color = getProviderColor(entry.id);

        return (
          <Box key={entry.id} gap={1}>
            <Box width={22}>
              <Text color={color}>{entry.model}</Text>
            </Box>
            <Text color={color}>
              {'\u2588'.repeat(filled)}
              <Text dimColor>{'\u2591'.repeat(empty)}</Text>
            </Text>
            <Text color="#94a3b8">
              {entry.totalDuration >= 1000
                ? `${(entry.totalDuration / 1000).toFixed(1)}s`
                : `${entry.totalDuration}ms`}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}
