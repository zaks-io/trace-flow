import { useMemo } from 'react';
import { useTinybirdQuery } from '@/hooks/useTinybirdQuery';
import { snapToMinute } from '@/lib/tinybird';
import {
  accountOptionLabel,
  tryParseAccountKey,
  UNRECOGNIZED_ACCOUNT_LABEL,
} from '@/lib/upstreamAccount';

// Retention is enforced server-side; this only needs to reach past any plan's retention window.
const OPTION_LOOKBACK_MS = 400 * 24 * 60 * 60 * 1000;

export interface UpstreamAccountOptions {
  options: string[];
  labelMap: Map<string, string>;
  error: Error | null;
}

interface AccountOptionRow {
  account_key: string;
}

function optionLabel(key: string): string {
  const account = tryParseAccountKey(key);
  return account ? accountOptionLabel(account) : UNRECOGNIZED_ACCOUNT_LABEL;
}

/** Account filter options come from proxy execution facts so Requests matches Usage. */
export function useUpstreamAccountOptions(selected: string | null): UpstreamAccountOptions {
  const params = useMemo(() => {
    const now = snapToMinute(Date.now());
    return {
      start_time_ns: (now - OPTION_LOOKBACK_MS) * 1_000_000,
      end_time_ns: now * 1_000_000,
    };
  }, []);
  const { data, error } = useTinybirdQuery<AccountOptionRow>({
    pipe: 'llm_usage_by_account',
    params,
  });

  return useMemo(() => {
    const keys = (data?.data ?? []).map((row) => row.account_key);
    const labelMap = new Map<string, string>();
    for (const key of selected ? [...keys, selected] : keys) labelMap.set(key, optionLabel(key));
    return { options: keys, labelMap, error };
  }, [data, selected, error]);
}
