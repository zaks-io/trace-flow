'use client';

import { useMemo } from 'react';
import { useTinybirdQuery } from '@/hooks/useTinybirdQuery';
import type { AgentRepoDirectoryRow } from '@/components/agents/types';
import { buildRepoLabelMap } from '@/components/agents/repoLabel';

/**
 * Resolve repo_fingerprint -> display name via the agent_repo_directory pipe, the same
 * client-side label-join as useApiKeyMap. Only fetches when repo grouping/filtering is
 * active. Pass the window (start/end ms) so names cover the visible range.
 */
export function useRepoDirectory(
  windowParams: Record<string, string | number>,
  enabled: boolean,
): Map<string, string> {
  const query = useTinybirdQuery<AgentRepoDirectoryRow>({
    pipe: 'agent_repo_directory',
    params: windowParams,
    enabled,
  });

  return useMemo(() => buildRepoLabelMap(query.data?.data ?? []), [query.data]);
}
