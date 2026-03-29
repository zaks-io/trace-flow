import type { Id } from '@convex/_generated/dataModel';
import type {
  CostAlertConditionType,
  CostAlertSeverity,
  CostAlertWindow,
} from '../types/cost-alerts';
import { COST_ALERT_CONDITION_LABELS, COST_ALERT_WINDOW_LABELS } from '../types/cost-alerts';

export interface ChannelHeaderFormRow {
  key: string;
  value: string;
}

export interface ChannelFormData {
  name: string;
  type: 'email' | 'webhook';
  recipientsText: string;
  webhookUrl: string;
  webhookSecret: string;
  webhookHeaders: ChannelHeaderFormRow[];
}

export interface AlertFormData {
  name: string;
  severity: CostAlertSeverity;
  conditionType: CostAlertConditionType;
  window: CostAlertWindow;
  thresholdUsd: string;
  baselineHours: string;
  multiplier: string;
  minCurrentHourUsd: string;
  minIncreaseUsd: string;
  cooldownMinutes: string;
  notifyOnRecovery: boolean;
  apiKeyIds: string[];
  channelIds: string[];
}

interface ApiKeyOption {
  _id: Id<'apiKeys'>;
  name?: string;
  key: string;
}

interface CostAlertChannelLike {
  _id: Id<'costAlertChannels'>;
  name: string;
  config:
    | { type: 'email'; recipients: string[] }
    | { type: 'webhook'; url: string; secret?: string; headers?: { key: string; value: string }[] };
}

interface CostAlertRuleLike {
  _id: Id<'costAlerts'>;
  name: string;
  severity: CostAlertSeverity;
  apiKeyIds?: Id<'apiKeys'>[];
  channelIds: Id<'costAlertChannels'>[];
  cooldownMinutes: number;
  notifyOnRecovery: boolean;
  condition:
    | { type: 'absolute_spend_threshold'; window: CostAlertWindow; thresholdUsd: number }
    | { type: 'projected_monthly_over'; thresholdUsd: number }
    | {
        type: 'hourly_spend_spike';
        baselineHours: number;
        multiplier: number;
        minCurrentHourUsd: number;
        minIncreaseUsd: number;
      };
}

export const DEFAULT_CHANNEL_FORM_DATA: ChannelFormData = {
  name: '',
  type: 'email',
  recipientsText: '',
  webhookUrl: '',
  webhookSecret: '',
  webhookHeaders: [],
};

export const DEFAULT_ALERT_FORM_DATA: AlertFormData = {
  name: '',
  severity: 'warning',
  conditionType: 'absolute_spend_threshold',
  window: 'last_24_hours',
  thresholdUsd: '',
  baselineHours: '24',
  multiplier: '2',
  minCurrentHourUsd: '10',
  minIncreaseUsd: '5',
  cooldownMinutes: '60',
  notifyOnRecovery: true,
  apiKeyIds: [],
  channelIds: [],
};

export function parseRecipients(text: string): string[] {
  return Array.from(
    new Set(
      text
        .split(/[\n,]/)
        .map((part) => part.trim().toLowerCase())
        .filter((part) => part.length > 0),
    ),
  );
}

export function sanitizeHeaderRows(rows: ChannelHeaderFormRow[]): ChannelHeaderFormRow[] {
  return rows
    .map((row) => ({ key: row.key.trim(), value: row.value.trim() }))
    .filter((row) => row.key.length > 0 && row.value.length > 0);
}

export function buildChannelConfigInput(form: ChannelFormData) {
  if (form.type === 'email') {
    return {
      type: 'email' as const,
      recipients: parseRecipients(form.recipientsText),
    };
  }

  return {
    type: 'webhook' as const,
    url: form.webhookUrl.trim(),
    secret: form.webhookSecret.trim() || undefined,
    headers: sanitizeHeaderRows(form.webhookHeaders),
  };
}

export function buildAlertInput(form: AlertFormData) {
  const base = {
    name: form.name.trim(),
    severity: form.severity,
    channelIds: form.channelIds as Id<'costAlertChannels'>[],
    cooldownMinutes: Number(form.cooldownMinutes || 0),
    notifyOnRecovery: form.notifyOnRecovery,
    apiKeyIds: form.apiKeyIds.length > 0 ? (form.apiKeyIds as Id<'apiKeys'>[]) : undefined,
  };

  if (form.conditionType === 'absolute_spend_threshold') {
    return {
      ...base,
      condition: {
        type: 'absolute_spend_threshold' as const,
        window: form.window,
        thresholdUsd: Number(form.thresholdUsd || 0),
      },
    };
  }

  if (form.conditionType === 'projected_monthly_over') {
    return {
      ...base,
      condition: {
        type: 'projected_monthly_over' as const,
        thresholdUsd: Number(form.thresholdUsd || 0),
      },
    };
  }

  return {
    ...base,
    condition: {
      type: 'hourly_spend_spike' as const,
      baselineHours: Number(form.baselineHours || 0),
      multiplier: Number(form.multiplier || 0),
      minCurrentHourUsd: Number(form.minCurrentHourUsd || 0),
      minIncreaseUsd: Number(form.minIncreaseUsd || 0),
    },
  };
}

export function channelFormFromChannel(channel: CostAlertChannelLike): ChannelFormData {
  if (channel.config.type === 'email') {
    return {
      name: channel.name,
      type: 'email',
      recipientsText: channel.config.recipients.join(', '),
      webhookUrl: '',
      webhookSecret: '',
      webhookHeaders: [],
    };
  }

  return {
    name: channel.name,
    type: 'webhook',
    recipientsText: '',
    webhookUrl: channel.config.url,
    webhookSecret: channel.config.secret ?? '',
    webhookHeaders: channel.config.headers ?? [],
  };
}

export function alertFormFromRule(rule: CostAlertRuleLike): AlertFormData {
  if (rule.condition.type === 'absolute_spend_threshold') {
    return {
      name: rule.name,
      severity: rule.severity,
      conditionType: rule.condition.type,
      window: rule.condition.window,
      thresholdUsd: String(rule.condition.thresholdUsd),
      baselineHours: '24',
      multiplier: '2',
      minCurrentHourUsd: '10',
      minIncreaseUsd: '5',
      cooldownMinutes: String(rule.cooldownMinutes),
      notifyOnRecovery: rule.notifyOnRecovery,
      apiKeyIds: rule.apiKeyIds?.map((id) => String(id)) ?? [],
      channelIds: rule.channelIds.map((id) => String(id)),
    };
  }

  if (rule.condition.type === 'projected_monthly_over') {
    return {
      name: rule.name,
      severity: rule.severity,
      conditionType: rule.condition.type,
      window: 'last_24_hours',
      thresholdUsd: String(rule.condition.thresholdUsd),
      baselineHours: '24',
      multiplier: '2',
      minCurrentHourUsd: '10',
      minIncreaseUsd: '5',
      cooldownMinutes: String(rule.cooldownMinutes),
      notifyOnRecovery: rule.notifyOnRecovery,
      apiKeyIds: rule.apiKeyIds?.map((id) => String(id)) ?? [],
      channelIds: rule.channelIds.map((id) => String(id)),
    };
  }

  return {
    name: rule.name,
    severity: rule.severity,
    conditionType: rule.condition.type,
    window: 'last_24_hours',
    thresholdUsd: '',
    baselineHours: String(rule.condition.baselineHours),
    multiplier: String(rule.condition.multiplier),
    minCurrentHourUsd: String(rule.condition.minCurrentHourUsd),
    minIncreaseUsd: String(rule.condition.minIncreaseUsd),
    cooldownMinutes: String(rule.cooldownMinutes),
    notifyOnRecovery: rule.notifyOnRecovery,
    apiKeyIds: rule.apiKeyIds?.map((id) => String(id)) ?? [],
    channelIds: rule.channelIds.map((id) => String(id)),
  };
}

export function formatCondition(condition: CostAlertRuleLike['condition']): string {
  switch (condition.type) {
    case 'absolute_spend_threshold':
      return `${COST_ALERT_CONDITION_LABELS[condition.type]}: ${formatCurrency(condition.thresholdUsd)} in ${COST_ALERT_WINDOW_LABELS[condition.window]}`;
    case 'projected_monthly_over':
      return `${COST_ALERT_CONDITION_LABELS[condition.type]}: ${formatCurrency(condition.thresholdUsd)}`;
    case 'hourly_spend_spike':
      return `${COST_ALERT_CONDITION_LABELS[condition.type]}: ${condition.multiplier}x baseline over ${condition.baselineHours}h`;
  }
}

export function formatChannelDestination(channel: CostAlertChannelLike): string {
  if (channel.config.type === 'email') {
    return channel.config.recipients.join(', ');
  }

  return channel.config.url;
}

export function formatScope(rule: CostAlertRuleLike, apiKeys: ApiKeyOption[]): string {
  if (!rule.apiKeyIds || rule.apiKeyIds.length === 0) {
    return 'All API keys';
  }

  const labels = rule.apiKeyIds
    .map((id) => apiKeys.find((apiKey) => apiKey._id === id))
    .filter((apiKey): apiKey is ApiKeyOption => Boolean(apiKey))
    .map((apiKey) => apiKey.name ?? apiKey.key);

  return labels.length > 0 ? labels.join(', ') : 'Selected API keys';
}

function formatCurrency(value: number): string {
  return `$${value.toFixed(2)}`;
}
