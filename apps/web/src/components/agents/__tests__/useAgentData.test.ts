import { describe, expect, it } from 'vitest';
import type { TinybirdResponse } from '@/components/usage/types';
import { getFreshFirstRow, getFreshRows } from '../useAgentData';

type Row = { value: number };

function snapshot(data: Row[] | null, error: Error | null) {
  return {
    data: data ? ({ data } satisfies TinybirdResponse<Row>) : null,
    error,
  };
}

describe('useAgentData helpers', () => {
  it('suppresses stale rows when the latest query failed', () => {
    const query = snapshot([{ value: 1 }], new Error('Tinybird unavailable'));

    expect(getFreshRows(query)).toEqual([]);
    expect(getFreshFirstRow(query)).toBeNull();
  });

  it('returns rows from the latest successful query', () => {
    const query = snapshot([{ value: 1 }], null);

    expect(getFreshRows(query)).toEqual([{ value: 1 }]);
    expect(getFreshFirstRow(query)).toEqual({ value: 1 });
  });
});
