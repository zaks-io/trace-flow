'use client';

import { useMemo } from 'react';
import { useTinybirdQuery } from '@/hooks/useTinybirdQuery';
import type { AgentUsageBreakdownRow } from './types';

const MODEL_OPTION_LIMIT = 100;

export function modelOptionsFromRows(rows: AgentUsageBreakdownRow[]): string[] {
  return [...new Set(rows.map((row) => row.group_value).filter(Boolean))];
}

/**
 * Discover models independently from the active model selection. Source, repo, and time filters
 * still scope the list so the menu only offers models present in the current slice.
 */
export function useAgentModelOptions(filterParams: Record<string, string | number>): string[] {
  const query = useTinybirdQuery<AgentUsageBreakdownRow>({
    pipe: 'agent_usage_breakdown',
    params: {
      ...filterParams,
      dimension: 'model',
      order_by: 'message_count',
      limit: MODEL_OPTION_LIMIT,
    },
  });

  return useMemo(() => modelOptionsFromRows(query.data?.data ?? []), [query.data]);
}
