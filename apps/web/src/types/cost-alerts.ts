export type CostAlertSeverity = 'info' | 'warning' | 'error';

export type CostAlertWindow = 'last_hour' | 'last_24_hours' | 'month_to_date';

export interface CostAlertScope {
  provider?: string;
  model?: string;
  baggageOperation?: string;
  baggageUserId?: string;
}

export type CostAlertConditionType =
  | 'absolute_spend_threshold'
  | 'projected_monthly_over'
  | 'hourly_spend_spike'
  | 'model_approval_and_pricing';

export const COST_ALERT_CONDITION_LABELS: Record<CostAlertConditionType, string> = {
  absolute_spend_threshold: 'Hard Threshold',
  projected_monthly_over: 'Projected Monthly Over',
  hourly_spend_spike: 'Hourly Spend Spike',
  model_approval_and_pricing: 'Model Approval',
};

export const COST_ALERT_WINDOW_LABELS: Record<CostAlertWindow, string> = {
  last_hour: 'Last Hour',
  last_24_hours: 'Last 24 Hours',
  month_to_date: 'Month to Date',
};

export const COST_ALERT_SEVERITY_LABELS: Record<CostAlertSeverity, string> = {
  info: 'Info',
  warning: 'Warning',
  error: 'Error',
};
