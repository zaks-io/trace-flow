import { validateSpanId, validateTraceId } from '@trace-flow/utils';
import { formatModelDisplay, formatNumber } from '@/lib/format';
import type { CostTailRiskRow, TokenRatioDriftRow } from './types';

type TraceLinkSource = Pick<
  CostTailRiskRow | TokenRatioDriftRow,
  'trace_id' | 'span_id' | 'TraceId' | 'SpanId'
>;

export const MIN_TAIL_RISK_REQUESTS = 20;

export function usageSliceLabel(
  row: Pick<
    CostTailRiskRow | TokenRatioDriftRow,
    'provider' | 'model' | 'operation_name' | 'baggage_operation'
  >,
): { primary: string; secondary: string } {
  return {
    primary: row.baggage_operation || row.operation_name || 'unknown operation',
    secondary: formatModelDisplay(row.model || 'unknown model', row.provider || undefined),
  };
}

export function buildTraceHref(row: TraceLinkSource): string | null {
  const traceId = validateTraceId(row.trace_id ?? row.TraceId);
  if (!traceId) return null;

  const spanId = validateSpanId(row.span_id ?? row.SpanId);
  return spanId ? `/app/trace/${traceId}?span=${spanId}` : `/app/trace/${traceId}`;
}

export function isTailRiskInsufficient(
  row: Pick<CostTailRiskRow, 'request_count' | 'p99_p50_ratio'>,
): boolean {
  return row.request_count < MIN_TAIL_RISK_REQUESTS || row.p99_p50_ratio == null;
}

export function formatRatio(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '-';
  if (Math.abs(value) >= 10) return `${value.toFixed(1)}x`;
  return `${value.toFixed(2)}x`;
}

export function formatTokensPerRequest(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '-';
  return formatNumber(Math.round(value));
}

export function formatSignedPercentDelta(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '-';
  const sign = value > 0 ? '+' : '';
  const magnitude = Math.abs(value) < 1 ? value.toFixed(1) : Math.round(value).toString();
  return `${sign}${magnitude}%`;
}

export function isTokenRatioInsufficient(row: Pick<TokenRatioDriftRow, 'state'>): boolean {
  return row.state === 'insufficient_data';
}
