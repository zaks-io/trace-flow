import { formatNumber } from '../../lib/format';
import type { AgentContextBreakdownDimension, AgentContextHealthRow } from './types';

export const DEFAULT_ATTENTION_THRESHOLD_TOKENS = 140_000;
export const MAX_ATTENTION_THRESHOLD_TOKENS = 2_000_000;

type ContextHealthBand = 'empty' | 'normal' | 'pressured';

export function resolveAttentionThreshold(value: string | null | undefined): number {
  if (!value) return DEFAULT_ATTENTION_THRESHOLD_TOKENS;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_ATTENTION_THRESHOLD_TOKENS;
  return Math.max(1, Math.min(Math.floor(parsed), MAX_ATTENTION_THRESHOLD_TOKENS));
}

export function formatContextTokens(value: number): string {
  return `${formatNumber(Math.round(value))} tokens`;
}

export function contextHealthBand(row: AgentContextHealthRow | null): ContextHealthBand {
  if (!row || row.model_call_count === 0) return 'empty';
  if (row.calls_over_threshold > 0 || row.sessions_over_threshold > 0) return 'pressured';
  return 'normal';
}

export function buildContextHealthParams({
  filterParams,
  models,
  attentionThresholdTokens,
  dimension,
  limit,
}: {
  filterParams: Record<string, string | number>;
  models: string[];
  attentionThresholdTokens: number;
  dimension?: AgentContextBreakdownDimension;
  limit?: number;
}): Record<string, string | number> {
  const params: Record<string, string | number> = {
    ...filterParams,
    attention_threshold_tokens: attentionThresholdTokens,
  };
  if (models.length > 0) params.models = models.join(',');
  if (dimension) params.dimension = dimension;
  if (limit !== undefined) params.limit = limit;
  return params;
}
