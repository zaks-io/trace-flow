import { useMemo, useState } from 'react';
import { type TimeRange, TIME_RANGES } from '@/components/usage/types';
import { snapToMinute } from '@/lib/tinybird';
import type { AgentGroupBy, AgentSource } from './types';

type AgentFiltersState = {
  timeRange: TimeRange;
  setTimeRange: (v: TimeRange) => void;
  source: AgentSource;
  setSource: (v: AgentSource) => void;
  groupBy: AgentGroupBy;
  setGroupBy: (v: AgentGroupBy) => void;
  /** Agent pipes take ms (not the ns the llm_* pipes use); org_id + retention_days are JWT-stamped. */
  filterParams: Record<string, string | number>;
};

export function useAgentFilters(): AgentFiltersState {
  const [timeRange, setTimeRange] = useState<TimeRange>('7d');
  const [source, setSource] = useState<AgentSource>('');
  const [groupBy, setGroupBy] = useState<AgentGroupBy>('none');

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
    if (source) params.source = source;
    return params;
  }, [startTimeMs, endTimeMs, source]);

  return { timeRange, setTimeRange, source, setSource, groupBy, setGroupBy, filterParams };
}
