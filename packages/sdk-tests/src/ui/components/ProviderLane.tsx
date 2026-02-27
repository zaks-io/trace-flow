import { Box, Text } from 'ink';
import { Spinner } from '@inkjs/ui';
import type { RequestResult } from '../../output';
import { chars, getProviderColor, statusColors } from '../theme';

interface ProviderLaneProps {
  id: string;
  name: string;
  model: string;
  status: 'pending' | 'running' | 'done';
  results: RequestResult[];
  totalExpected?: number;
}

function StatusIcon({ status }: { status: RequestResult['status'] }) {
  if (status === 'passed') return <Text color={statusColors.passed}>{chars.passed}</Text>;
  if (status === 'failed') return <Text color={statusColors.failed}>{chars.failed}</Text>;
  return <Text color={statusColors.skipped}>{chars.skipped}</Text>;
}

function formatMs(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${ms}ms`;
}

export function ProviderLane({ id, name: _name, model, status, results }: ProviderLaneProps) {
  const color = getProviderColor(id);
  const passed = results.filter((r) => r.status === 'passed').length;
  const failed = results.filter((r) => r.status === 'failed').length;
  const total = results.length;

  return (
    <Box gap={1}>
      <Box width={22}>
        <Text color={color} bold>
          {model}
        </Text>
      </Box>

      <Box flexGrow={1} gap={1} flexWrap="wrap">
        {status === 'pending' && results.length === 0 && (
          <Text color={statusColors.pending}>{chars.pending} waiting</Text>
        )}
        {status === 'running' && results.length === 0 && (
          <Box gap={1}>
            <Spinner label="running" />
          </Box>
        )}
        {results.map((r, i) => (
          <Box key={i} gap={1}>
            <StatusIcon status={r.status} />
            <Text dimColor>{r.label ?? `req ${(r.requestIndex ?? 0) + 1}`}</Text>
            {r.duration > 0 && <Text color="#94a3b8">{formatMs(r.duration)}</Text>}
            {r.ttft != null && <Text color="#67e8f9">TTFT:{formatMs(r.ttft)}</Text>}
            {r.status === 'failed' && r.error && (
              <Text color={statusColors.failed}>{r.error.slice(0, 50)}</Text>
            )}
          </Box>
        ))}
        {status === 'running' && results.length > 0 && <Spinner label="" />}
      </Box>

      <Box width={10} justifyContent="flex-end">
        {total > 0 && (
          <Text
            color={
              failed > 0
                ? statusColors.failed
                : passed === total
                  ? statusColors.passed
                  : statusColors.running
            }
          >
            {failed > 0 ? chars.failed : passed === total ? '\u2713' : chars.running} {passed}/
            {total}
          </Text>
        )}
      </Box>
    </Box>
  );
}
