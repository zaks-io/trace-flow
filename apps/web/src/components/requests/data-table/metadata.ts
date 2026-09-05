import type { TraceAlertSummary } from '@/types/alerts';

const COLUMN_CATEGORIES = new Set(['standard', 'ai', 'http', 'alerts']);

export interface TraceColumnMeta {
  category: 'standard' | 'ai' | 'http' | 'alerts';
  label: string;
}

export interface TraceTableMeta {
  alertSummary?: Map<string, TraceAlertSummary>;
}

export function readTraceColumnMeta(meta: unknown): TraceColumnMeta | undefined {
  if (meta === undefined) return undefined;
  if (typeof meta !== 'object' || meta === null) {
    throw new TypeError('Column metadata must be an object');
  }

  const { category, label } = meta as Record<string, unknown>;
  if (
    typeof category !== 'string' ||
    !COLUMN_CATEGORIES.has(category) ||
    typeof label !== 'string'
  ) {
    throw new TypeError('Column metadata must include a valid category and label');
  }

  return { category: category as TraceColumnMeta['category'], label };
}

export function readAlertSummary(meta: unknown): Map<string, TraceAlertSummary> | undefined {
  if (meta === undefined) return undefined;
  if (typeof meta !== 'object' || meta === null) {
    throw new TypeError('Table metadata must be an object');
  }

  const { alertSummary } = meta as Record<string, unknown>;
  if (alertSummary === undefined) return undefined;
  if (!(alertSummary instanceof Map)) {
    throw new TypeError('Table alert summary must be a Map');
  }
  return alertSummary as Map<string, TraceAlertSummary>;
}
