import { describe, expect, it } from 'vitest';
import {
  MIN_TAIL_RISK_REQUESTS,
  buildTraceHref,
  formatRatio,
  formatSignedPercentDelta,
  formatTokensPerRequest,
  isTailRiskInsufficient,
  isTokenRatioInsufficient,
  usageSliceLabel,
} from '../usageRisk';

describe('usageSliceLabel', () => {
  it('prefers baggage operation and includes provider/model context', () => {
    expect(
      usageSliceLabel({
        provider: 'anthropic',
        model: 'claude-opus-4-8',
        operation_name: 'chat',
        baggage_operation: 'summarize',
      }),
    ).toEqual({
      primary: 'summarize',
      secondary: 'anthropic/claude-opus-4-8',
    });
  });

  it('falls back to operation_name when no baggage operation exists', () => {
    expect(
      usageSliceLabel({
        provider: 'openai',
        model: 'gpt-4.1',
        operation_name: 'responses',
        baggage_operation: '',
      }).primary,
    ).toBe('responses');
  });
});

describe('buildTraceHref', () => {
  it('returns a trace detail href with a valid span query when both IDs are present', () => {
    expect(
      buildTraceHref({
        trace_id: 'ABCDEF0123456789ABCDEF0123456789',
        span_id: 'ABCDEF0123456789',
      }),
    ).toBe('/app/trace/abcdef0123456789abcdef0123456789?span=abcdef0123456789');
  });

  it('supports TraceId and SpanId field names from existing trace rows', () => {
    expect(
      buildTraceHref({
        TraceId: 'abcdef0123456789abcdef0123456789',
        SpanId: 'abcdef0123456789',
      }),
    ).toBe('/app/trace/abcdef0123456789abcdef0123456789?span=abcdef0123456789');
  });

  it('returns null for invalid or missing trace IDs', () => {
    expect(buildTraceHref({ trace_id: 'bad', span_id: 'abcdef0123456789' })).toBeNull();
    expect(buildTraceHref({ span_id: 'abcdef0123456789' })).toBeNull();
  });
});

describe('tail risk state', () => {
  it('marks thin samples as insufficient', () => {
    expect(
      isTailRiskInsufficient({
        request_count: MIN_TAIL_RISK_REQUESTS - 1,
        p99_p50_ratio: 2,
      }),
    ).toBe(true);
  });

  it('marks missing p99/p50 ratios as insufficient', () => {
    expect(
      isTailRiskInsufficient({
        request_count: MIN_TAIL_RISK_REQUESTS,
        p99_p50_ratio: null,
      }),
    ).toBe(true);
  });
});

describe('ratio formatting', () => {
  it('formats ratios and nulls for compact table cells', () => {
    expect(formatRatio(1)).toBe('1.00x');
    expect(formatRatio(12.345)).toBe('12.3x');
    expect(formatRatio(null)).toBe('-');
  });

  it('formats token-per-request values as rounded counts', () => {
    expect(formatTokensPerRequest(199.6)).toBe('200');
    expect(formatTokensPerRequest(null)).toBe('-');
  });

  it('keeps signed percent deltas explicit', () => {
    expect(formatSignedPercentDelta(100)).toBe('+100%');
    expect(formatSignedPercentDelta(-20.4)).toBe('-20%');
    expect(formatSignedPercentDelta(0.25)).toBe('+0.3%');
    expect(formatSignedPercentDelta(null)).toBe('-');
  });

  it('detects Tinybird insufficient-data rows', () => {
    expect(isTokenRatioInsufficient({ state: 'insufficient_data' })).toBe(true);
    expect(isTokenRatioInsufficient({ state: 'ok' })).toBe(false);
  });
});
