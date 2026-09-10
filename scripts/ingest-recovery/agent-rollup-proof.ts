import { quote } from './agent-data';
import { AgentTinybirdClient } from './agent-transport';

export async function verifyRollups(tinybird: AgentTinybirdClient, org: string): Promise<void> {
  const where = `OrgId=${quote(org)}`;
  const tokens = [
    'input_tokens',
    'output_tokens',
    'cache_read_tokens',
    'cache_creation_tokens',
    'reasoning_tokens',
  ];
  const states = [
    'InputTokens',
    'OutputTokens',
    'CacheReadTokens',
    'CacheCreationTokens',
    'ReasoningTokens',
  ];
  for (const [period, bucket] of [
    ['daily', 'toStartOfDay'],
    ['hourly', 'toStartOfHour'],
  ] as const) {
    const dimensions = 'BucketStart,source,model,repo_fingerprint';
    const expected = (
      await tinybird.sql(`SELECT ${bucket}(toDateTime(EventAt)) AS BucketStart,source,model,repo_fingerprint,
      toString(count()) AS MessageCount,toString(uniq(session_pk)) AS SessionCount,
      ${tokens.map((name, i) => `toString(sum(${name})) AS ${states[i]}`).join(',')},
      toString(countIf(cost_usd IS NOT NULL)) AS PricedMessageCount,sum(ifNull(cost_usd,0.)) AS CostUsd
      FROM agent_message_facts WHERE ${where} AND role='assistant' GROUP BY ${dimensions} ORDER BY ${dimensions}`)
    ).data;
    const table = `agent_usage_${period}`;
    const actual = (
      await tinybird.sql(`SELECT ${dimensions},toString(countMerge(MessageCount)) AS MessageCount,toString(uniqMerge(SessionCount)) AS SessionCount,
      ${states.map((name) => `toString(sumMerge(${name})) AS ${name}`).join(',')},
      toString(sumMerge(PricedMessageCount)) AS PricedMessageCount,sumMerge(CostUsd) AS CostUsd
      FROM ${table} WHERE ${where} GROUP BY ${dimensions} ORDER BY ${dimensions}`)
    ).data;
    assertRollupRows(actual, expected, table);

    const toolDimensions = 'BucketStart,source,tool_name,command_family,repo_fingerprint';
    const expectedTools = (
      await tinybird.sql(`SELECT ${bucket}(toDateTime(EventAt)) AS BucketStart,source,tool_name,command_family,repo_fingerprint,
      toString(count()) AS EventCount,toString(countIf(status='success')) AS SuccessCount,toString(countIf(status='failure')) AS FailureCount,
      toString(countIf(status='unknown')) AS UnknownCount,toString(sum(toUInt64(duration_ms))) AS DurationMsSum
      FROM agent_tool_event_facts WHERE ${where} GROUP BY ${toolDimensions} ORDER BY ${toolDimensions}`)
    ).data;
    const toolTable = `agent_tool_usage_${period}`;
    const actualTools = (
      await tinybird.sql(`SELECT ${toolDimensions},toString(countMerge(EventCount)) AS EventCount,
      toString(sumMerge(SuccessCount)) AS SuccessCount,toString(sumMerge(FailureCount)) AS FailureCount,
      toString(sumMerge(UnknownCount)) AS UnknownCount,toString(sumMerge(DurationMsSum)) AS DurationMsSum
      FROM ${toolTable} WHERE ${where} GROUP BY ${toolDimensions} ORDER BY ${toolDimensions}`)
    ).data;
    assertRollupRows(actualTools, expectedTools, toolTable);
  }
}

export function assertRollupRows(
  actual: Record<string, unknown>[],
  expected: Record<string, unknown>[],
  table: string,
): void {
  if (actual.length !== expected.length) throw new Error(`Rollup group count mismatch in ${table}`);
  for (let i = 0; i < expected.length; i++) {
    const left = { ...actual[i] };
    const right = { ...expected[i] };
    if ('CostUsd' in right) {
      const a = Number(left.CostUsd),
        b = Number(right.CostUsd);
      // Aggregate merge order may change Float64 rounding; permit at most one nanodollar.
      if (!Number.isFinite(a) || !Number.isFinite(b) || Math.abs(a - b) > 1e-9)
        throw new Error(`Cost rollup mismatch in ${table}`);
      delete left.CostUsd;
      delete right.CostUsd;
    }
    if (JSON.stringify(left) !== JSON.stringify(right))
      throw new Error(`Rollup values mismatch in ${table}`);
  }
}
