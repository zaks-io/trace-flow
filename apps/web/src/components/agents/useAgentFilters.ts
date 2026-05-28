import { useCallback, useMemo, useState } from 'react';
import { type TimeRange, TIME_RANGES } from '@/components/usage/types';
import { snapToMinute } from '@/lib/tinybird';
import { toggleInList } from './filters';
import type { AgentGroupBy } from './types';

type AgentFiltersState = {
  timeRange: TimeRange;
  setTimeRange: (v: TimeRange) => void;
  /** Multi-select Source IN-list; empty = all sources. Scopes every agent pipe. */
  sources: string[];
  toggleSource: (v: string) => void;
  /** Multi-select Model IN-list; empty = all models. Scopes the usage surfaces only. */
  models: string[];
  toggleModel: (v: string) => void;
  groupBy: AgentGroupBy;
  setGroupBy: (v: AgentGroupBy) => void;
  hasFilters: boolean;
  clearFilters: () => void;
  /**
   * Shared params for every agent pipe: ms window (agent pipes take ms, not the ns the
   * llm_* pipes use) + the sources IN-list. org_id + retention_days are JWT-stamped.
   * models is applied per-query (usage surfaces only), not here.
   */
  filterParams: Record<string, string | number>;
};

export function useAgentFilters(): AgentFiltersState {
  const [timeRange, setTimeRange] = useState<TimeRange>('7d');
  const [sources, setSources] = useState<string[]>([]);
  const [models, setModels] = useState<string[]>([]);
  const [groupBy, setGroupBy] = useState<AgentGroupBy>('none');

  const toggleSource = useCallback((v: string) => setSources((prev) => toggleInList(prev, v)), []);
  const toggleModel = useCallback((v: string) => setModels((prev) => toggleInList(prev, v)), []);
  const clearFilters = useCallback(() => {
    setSources([]);
    setModels([]);
  }, []);

  const { startTimeMs, endTimeMs } = useMemo(() => {
    const config = TIME_RANGES.find((range) => range.value === timeRange);
    if (config?.getRange) {
      const { start, end } = config.getRange();
      return { startTimeMs: snapToMinute(start), endTimeMs: snapToMinute(end) };
    }
    const now = Date.now();
    const rangeMs = config?.ms ?? 7 * 24 * 60 * 60 * 1000;
    return { startTimeMs: snapToMinute(now - rangeMs), endTimeMs: snapToMinute(now) };
  }, [timeRange]);

  const filterParams = useMemo(() => {
    const params: Record<string, string | number> = {
      start_time_ms: startTimeMs,
      end_time_ms: endTimeMs,
    };
    if (sources.length > 0) params.sources = sources.join(',');
    return params;
  }, [startTimeMs, endTimeMs, sources]);

  return {
    timeRange,
    setTimeRange,
    sources,
    toggleSource,
    models,
    toggleModel,
    groupBy,
    setGroupBy,
    hasFilters: sources.length > 0 || models.length > 0,
    clearFilters,
    filterParams,
  };
}
