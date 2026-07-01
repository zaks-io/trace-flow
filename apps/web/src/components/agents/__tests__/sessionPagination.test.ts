import { describe, expect, it } from 'vitest';
import { paginateAgentSessions, SESSION_TABLE_PAGE_SIZE } from '../SpendConcentrationDetail';
import type { AgentSessionRow } from '../types';

function session(index: number): AgentSessionRow {
  return {
    session_pk: `session-${index}`,
    source: 'claude',
    model: 'claude-opus-4-7',
    repo_fingerprint: 'repo_abc',
    message_count: 1,
    file_event_count: 0,
    unique_file_count: 0,
    cost_usd: index,
    duration_ms: 0,
    last_event_ms: 1_779_256_800_000 + index,
  };
}

describe('agent session table pagination', () => {
  it('paginates priciest conversations with stable bounds', () => {
    const sessions = Array.from({ length: SESSION_TABLE_PAGE_SIZE + 2 }, (_, i) => session(i + 1));

    const first = paginateAgentSessions(sessions, 0);
    const second = paginateAgentSessions(sessions, 1);

    expect(first.rows.map((row) => row.session_pk)).toEqual(
      Array.from({ length: SESSION_TABLE_PAGE_SIZE }, (_, i) => `session-${i + 1}`),
    );
    expect(first).toMatchObject({ pageIndex: 0, pageCount: 2, start: 0, end: 10 });
    expect(second.rows.map((row) => row.session_pk)).toEqual(['session-11', 'session-12']);
    expect(second).toMatchObject({ pageIndex: 1, pageCount: 2, start: 10, end: 12 });
  });

  it('clamps stale cursors when a filtered result has fewer pages', () => {
    const sessions = [session(1), session(2)];

    expect(paginateAgentSessions(sessions, 99)).toMatchObject({
      pageIndex: 0,
      pageCount: 1,
      start: 0,
      end: 2,
    });
  });
});
