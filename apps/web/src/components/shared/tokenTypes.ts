import type { Segment } from './BarCard';
import { seriesDash } from './seriesDash';

/**
 * Stack order shared by every token-type chart. The order is part of the color validation in
 * ADR 0010: Reasoning only ever stacks against Output, so the one slot pair that fails all-pairs
 * (Cache Read and Reasoning) never touches when zero segments drop out.
 */
export const TOKEN_TYPES = ['input', 'cacheRead', 'cacheWrite', 'output', 'reasoning'] as const;

export type TokenType = (typeof TOKEN_TYPES)[number];

export const TOKEN_TYPE_SERIES: Record<TokenType, { label: string; color: string }> = {
  input: { label: 'Input', color: 'var(--color-chart-4)' },
  cacheRead: { label: 'Cache Read', color: 'var(--color-chart-1)' },
  cacheWrite: { label: 'Cache Write', color: 'var(--color-chart-6)' },
  output: { label: 'Output', color: 'var(--color-chart-5)' },
  reasoning: { label: 'Reasoning', color: 'var(--color-chart-7)' },
};

export function tokenTypeDash(type: TokenType): string | undefined {
  return seriesDash(TOKEN_TYPES.indexOf(type));
}

export function buildTokenSegments(values: Record<TokenType, number>): Segment[] {
  return TOKEN_TYPES.filter((type) => values[type] > 0).map((type) => ({
    key: type,
    label: TOKEN_TYPE_SERIES[type].label,
    value: values[type],
    color: TOKEN_TYPE_SERIES[type].color,
  }));
}
