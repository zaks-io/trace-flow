import { Box, Text } from 'ink';
import type { RequestResult } from '../../output';
import { calculateProviderCosts, formatCost, formatTokenCount } from '../pricing';
import { getProviderColor } from '../theme';

interface CostReportProps {
  results: RequestResult[];
  modelMap: Map<string, string>;
}

const COL = { model: 22, tokens: 10, perf: 10, cost: 12 };

function Row({
  label,
  color,
  input,
  output,
  cache,
  ttft,
  tokSec,
  cost,
  bold,
}: {
  label: string;
  color?: string;
  input: string;
  output: string;
  cache: string;
  ttft: string;
  tokSec: string;
  cost: string;
  bold?: boolean;
}) {
  return (
    <Box>
      <Box width={COL.model}>
        <Text color={color} bold={bold}>
          {label}
        </Text>
      </Box>
      <Box width={COL.tokens} justifyContent="flex-end">
        <Text color="#94a3b8">{input}</Text>
      </Box>
      <Box width={COL.tokens} justifyContent="flex-end">
        <Text color="#94a3b8">{output}</Text>
      </Box>
      <Box width={COL.tokens} justifyContent="flex-end">
        <Text color="#94a3b8">{cache}</Text>
      </Box>
      <Box width={COL.perf} justifyContent="flex-end">
        <Text color="#67e8f9">{ttft}</Text>
      </Box>
      <Box width={COL.perf} justifyContent="flex-end">
        <Text color="#a78bfa">{tokSec}</Text>
      </Box>
      <Box width={COL.cost} justifyContent="flex-end">
        <Text color="#e0e7ff" bold={bold}>
          {cost}
        </Text>
      </Box>
    </Box>
  );
}

function formatMs(ms: number | undefined): string {
  if (ms == null) return '—';
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms)}ms`;
}

function formatTokSec(n: number | undefined): string {
  if (n == null) return '—';
  return `${n.toFixed(1)}`;
}

export function CostReport({ results, modelMap }: CostReportProps) {
  const { providers, totals, totalCost } = calculateProviderCosts(results, modelMap);

  if (providers.length === 0) return null;

  const hasCache = totals.cacheWrite > 0 || totals.cacheRead > 0;
  const lineWidth = COL.model + COL.tokens * 3 + COL.perf * 2 + COL.cost;

  return (
    <Box flexDirection="column" borderStyle="single" borderColor="#374151" paddingX={1}>
      <Text bold color="#94a3b8">
        Cost Report
      </Text>

      <Row
        label="Model"
        input="Input"
        output="Output"
        cache={hasCache ? 'Cache' : ''}
        ttft="TTFT"
        tokSec="Tok/s"
        cost="Est. Cost"
        bold
      />

      <Text dimColor>{'─'.repeat(lineWidth)}</Text>

      {providers.map((p) => {
        const cacheTotal = p.tokens.cacheWrite + p.tokens.cacheRead;
        return (
          <Row
            key={p.providerId}
            label={p.model || p.providerName}
            color={getProviderColor(p.providerId)}
            input={formatTokenCount(p.tokens.input)}
            output={formatTokenCount(p.tokens.output)}
            cache={hasCache ? formatTokenCount(cacheTotal) : ''}
            ttft={formatMs(p.perf.avgTtft)}
            tokSec={formatTokSec(p.perf.tokPerSec)}
            cost={formatCost(p.cost)}
          />
        );
      })}

      <Text dimColor>{'─'.repeat(lineWidth)}</Text>

      <Row
        label="Total"
        input={formatTokenCount(totals.input)}
        output={formatTokenCount(totals.output)}
        cache={hasCache ? formatTokenCount(totals.cacheWrite + totals.cacheRead) : ''}
        ttft=""
        tokSec=""
        cost={formatCost(totalCost)}
        bold
      />
    </Box>
  );
}
