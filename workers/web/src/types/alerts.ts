import type { Doc } from '@convex/_generated/dataModel';

export type AlertField =
  | 'duration_ms'
  | 'tokens_per_second'
  | 'total_tokens'
  | 'prompt_tokens'
  | 'completion_tokens'
  | 'ttft_ms'
  | 'is_error'
  | 'http_status_code'
  | 'cost_total';

export type AlertOperator = 'gt' | 'lt' | 'gte' | 'lte' | 'eq' | 'neq';

export type AlertSeverity = 'info' | 'warning' | 'error';

export type Alert = Doc<'alerts'>;

export interface TriggeredAlert {
  alert: Alert;
  actualValue: number | string | boolean | null;
}

export interface TraceAlertSummary {
  traceId: string;
  spanId?: string;
  triggeredAlerts: TriggeredAlert[];
  highestSeverity: AlertSeverity | null;
}

export const ALERT_FIELD_LABELS: Record<AlertField, string> = {
  duration_ms: 'Duration (ms)',
  tokens_per_second: 'Tokens/sec',
  total_tokens: 'Total Tokens',
  prompt_tokens: 'Prompt Tokens',
  completion_tokens: 'Completion Tokens',
  ttft_ms: 'Time to First Token (ms)',
  is_error: 'Is Error',
  http_status_code: 'HTTP Status Code',
  cost_total: 'Total Cost ($)',
};

export const ALERT_OPERATOR_LABELS: Record<AlertOperator, string> = {
  gt: '>',
  gte: '>=',
  lt: '<',
  lte: '<=',
  eq: '=',
  neq: '!=',
};

export const ALERT_SEVERITY_ORDER: Record<AlertSeverity, number> = {
  info: 0,
  warning: 1,
  error: 2,
};
