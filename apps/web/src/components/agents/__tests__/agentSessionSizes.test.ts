import { describe, expect, it } from 'vitest';
import {
  buildSizeBands,
  buildSizeHistogram,
  generatedTokenShare,
  medianMessagesPerSession,
  throughputVerdict,
} from '../agentSessionSizes';
import type { AgentSessionSizeRow } from '../types';

function makeRow(overrides: Partial<AgentSessionSizeRow> = {}): AgentSessionSizeRow {
  const zero = {
    session_count: 0,
    prior_session_count: 0,
    messages_p50: 0,
    prior_messages_p50: 0,
    messages_p90: 0,
    prior_messages_p90: 0,
    messages_p95: 0,
    prior_messages_p95: 0,
    messages_max: 0,
    prior_messages_max: 0,
    tokens_p50: 0,
    prior_tokens_p50: 0,
    tokens_p90: 0,
    prior_tokens_p90: 0,
    tokens_p95: 0,
    prior_tokens_p95: 0,
    tokens_max: 0,
    prior_tokens_max: 0,
    total_messages: 0,
    prior_total_messages: 0,
    total_generated_tokens: 0,
    prior_total_generated_tokens: 0,
    total_cache_inclusive_tokens: 0,
    prior_total_cache_inclusive_tokens: 0,
    total_cost_usd: 0,
    prior_total_cost_usd: 0,
    bin_1_2: 0,
    prior_bin_1_2: 0,
    bin_3_5: 0,
    prior_bin_3_5: 0,
    bin_6_10: 0,
    prior_bin_6_10: 0,
    bin_11_25: 0,
    prior_bin_11_25: 0,
    bin_26_50: 0,
    prior_bin_26_50: 0,
    bin_51_plus: 0,
    prior_bin_51_plus: 0,
    small_sessions: 0,
    prior_small_sessions: 0,
    medium_sessions: 0,
    prior_medium_sessions: 0,
    large_sessions: 0,
    prior_large_sessions: 0,
    small_cost_usd: 0,
    medium_cost_usd: 0,
    large_cost_usd: 0,
  } satisfies AgentSessionSizeRow;
  return { ...zero, ...overrides };
}

describe('buildSizeHistogram', () => {
  it('maps every fixed bin in order with current + prior counts', () => {
    const bins = buildSizeHistogram(
      makeRow({ bin_1_2: 5, prior_bin_1_2: 2, bin_51_plus: 1, prior_bin_51_plus: 0 }),
    );
    expect(bins.map((b) => b.label)).toEqual(['1–2', '3–5', '6–10', '11–25', '26–50', '51+']);
    expect(bins[0]).toEqual({ label: '1–2', current: 5, prior: 2 });
    expect(bins[5]).toEqual({ label: '51+', current: 1, prior: 0 });
  });
});

describe('buildSizeBands', () => {
  it('computes per-band shares against the session total', () => {
    const bands = buildSizeBands(
      makeRow({
        session_count: 10,
        small_sessions: 6,
        medium_sessions: 3,
        large_sessions: 1,
        small_cost_usd: 1,
        medium_cost_usd: 2,
        large_cost_usd: 7,
      }),
    );
    expect(bands.map((b) => b.share)).toEqual([0.6, 0.3, 0.1]);
    expect(bands[2]).toMatchObject({ key: 'large', sessions: 1, costUsd: 7 });
  });

  it('returns zero shares (not NaN) when there are no sessions', () => {
    const bands = buildSizeBands(makeRow());
    expect(bands.every((b) => b.share === 0)).toBe(true);
  });
});

describe('throughputVerdict', () => {
  it('is "none" with no conversations', () => {
    expect(throughputVerdict(makeRow())).toBe('none');
  });

  it('is "many-small" when small dominates and large is rare', () => {
    const row = makeRow({ session_count: 10, small_sessions: 8, medium_sessions: 2 });
    expect(throughputVerdict(row)).toBe('many-small');
  });

  it('is "few-big" when large conversations are the majority', () => {
    const row = makeRow({
      session_count: 10,
      small_sessions: 2,
      medium_sessions: 2,
      large_sessions: 6,
    });
    expect(throughputVerdict(row)).toBe('few-big');
  });

  it('is "few-big" when large conversations carry the cost even if not the count', () => {
    const row = makeRow({
      session_count: 10,
      small_sessions: 7,
      medium_sessions: 2,
      large_sessions: 1,
      small_cost_usd: 1,
      medium_cost_usd: 1,
      large_cost_usd: 8,
    });
    expect(throughputVerdict(row)).toBe('few-big');
  });

  it('is "mixed" when no band dominates', () => {
    const row = makeRow({
      session_count: 10,
      small_sessions: 4,
      medium_sessions: 4,
      large_sessions: 2,
      small_cost_usd: 3,
      medium_cost_usd: 3,
      large_cost_usd: 4,
    });
    expect(throughputVerdict(row)).toBe('mixed');
  });
});

describe('medianMessagesPerSession', () => {
  it('returns the p50 message count', () => {
    expect(medianMessagesPerSession(makeRow({ messages_p50: 7 }))).toBe(7);
  });
});

describe('generatedTokenShare', () => {
  it('is the generated fraction of tokens processed', () => {
    const row = makeRow({
      total_cache_inclusive_tokens: 1000,
      total_generated_tokens: 250,
    });
    expect(generatedTokenShare(row)).toBe(0.25);
  });

  it('is 0 (not NaN) when nothing was processed', () => {
    expect(generatedTokenShare(makeRow())).toBe(0);
  });

  it('clamps to 1 if generated somehow exceeds processed', () => {
    const row = makeRow({ total_cache_inclusive_tokens: 100, total_generated_tokens: 150 });
    expect(generatedTokenShare(row)).toBe(1);
  });
});
