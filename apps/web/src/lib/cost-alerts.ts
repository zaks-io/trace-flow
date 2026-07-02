import type { Id } from '@trace-flow/convex/_generated/dataModel';
import type {
  CostAlertConditionType,
  CostAlertScope,
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
  approvedModelsText: string;
  zeroCostModelsText: string;
  cooldownMinutes: string;
  notifyOnRecovery: boolean;
  apiKeyIds: string[];
  provider: string;
  model: string;
  baggageOperation: string;
  baggageUserId: string;
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
  scope?: CostAlertScope;
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
      }
    | {
        type: 'model_approval_and_pricing';
        window: CostAlertWindow;
        approvedModels: { provider: string; model: string; allowZeroCost?: boolean }[];
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
  approvedModelsText: '',
  zeroCostModelsText: '',
  cooldownMinutes: '60',
  notifyOnRecovery: true,
  apiKeyIds: [],
  provider: '',
  model: '',
  baggageOperation: '',
  baggageUserId: '',
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

export function parseProviderModelPairs(text: string): { provider: string; model: string }[] {
  const pairs = new Map<string, { provider: string; model: string }>();

  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const separatorIndex = trimmed.indexOf(',');
    if (separatorIndex === -1) {
      throw new Error('Provider/model pairs must use "provider, model" format');
    }

    const provider = trimmed.slice(0, separatorIndex).trim().toLowerCase();
    const model = trimmed.slice(separatorIndex + 1).trim();
    if (!provider || !model) {
      throw new Error('Provider/model pairs must include both provider and model');
    }

    pairs.set(JSON.stringify([provider, model]), { provider, model });
  }

  return Array.from(pairs.values());
}

export function formatProviderModelPairs(
  pairs: { provider: string; model: string; allowZeroCost?: boolean }[],
  options?: { zeroCostOnly?: boolean },
): string {
  return pairs
    .filter((pair) => !options?.zeroCostOnly || pair.allowZeroCost)
    .map((pair) => `${pair.provider}, ${pair.model}`)
    .join('\n');
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

export function buildAlertScopeInput(form: AlertFormData): CostAlertScope {
  const scope: CostAlertScope = {};
  if (form.provider.trim()) scope.provider = form.provider.trim();
  if (form.model.trim()) scope.model = form.model.trim();
  if (form.baggageOperation.trim()) scope.baggageOperation = form.baggageOperation.trim();
  if (form.baggageUserId.trim()) scope.baggageUserId = form.baggageUserId.trim();
  return scope;
}

export function buildAlertInput(form: AlertFormData) {
  const base = {
    name: form.name.trim(),
    severity: form.severity,
    channelIds: form.channelIds as Id<'costAlertChannels'>[],
    cooldownMinutes: Number(form.cooldownMinutes || 0),
    notifyOnRecovery: form.notifyOnRecovery,
    apiKeyIds: form.apiKeyIds as Id<'apiKeys'>[],
    scope: buildAlertScopeInput(form),
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

  if (form.conditionType === 'model_approval_and_pricing') {
    const zeroCostPairs = new Set(
      parseProviderModelPairs(form.zeroCostModelsText).map((pair) =>
        JSON.stringify([pair.provider, pair.model]),
      ),
    );
    const approvedModels = parseProviderModelPairs(form.approvedModelsText).map((pair) => ({
      ...pair,
      allowZeroCost: zeroCostPairs.has(JSON.stringify([pair.provider, pair.model])) || undefined,
    }));

    return {
      ...base,
      condition: {
        type: 'model_approval_and_pricing' as const,
        window: form.window,
        approvedModels,
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
  const base = {
    name: rule.name,
    severity: rule.severity,
    cooldownMinutes: String(rule.cooldownMinutes),
    notifyOnRecovery: rule.notifyOnRecovery,
    apiKeyIds: rule.apiKeyIds?.map((id) => String(id)) ?? [],
    provider: rule.scope?.provider ?? '',
    model: rule.scope?.model ?? '',
    baggageOperation: rule.scope?.baggageOperation ?? '',
    baggageUserId: rule.scope?.baggageUserId ?? '',
    channelIds: rule.channelIds.map((id) => String(id)),
    approvedModelsText: '',
    zeroCostModelsText: '',
  };

  if (rule.condition.type === 'absolute_spend_threshold') {
    return {
      ...base,
      conditionType: rule.condition.type,
      window: rule.condition.window,
      thresholdUsd: String(rule.condition.thresholdUsd),
      baselineHours: '24',
      multiplier: '2',
      minCurrentHourUsd: '10',
      minIncreaseUsd: '5',
    };
  }

  if (rule.condition.type === 'projected_monthly_over') {
    return {
      ...base,
      conditionType: rule.condition.type,
      window: 'last_24_hours',
      thresholdUsd: String(rule.condition.thresholdUsd),
      baselineHours: '24',
      multiplier: '2',
      minCurrentHourUsd: '10',
      minIncreaseUsd: '5',
    };
  }

  if (rule.condition.type === 'model_approval_and_pricing') {
    return {
      ...base,
      conditionType: rule.condition.type,
      window: rule.condition.window,
      thresholdUsd: '',
      baselineHours: '24',
      multiplier: '2',
      minCurrentHourUsd: '10',
      minIncreaseUsd: '5',
      approvedModelsText: formatProviderModelPairs(rule.condition.approvedModels),
      zeroCostModelsText: formatProviderModelPairs(rule.condition.approvedModels, {
        zeroCostOnly: true,
      }),
    };
  }

  return {
    ...base,
    conditionType: rule.condition.type,
    window: 'last_24_hours',
    thresholdUsd: '',
    baselineHours: String(rule.condition.baselineHours),
    multiplier: String(rule.condition.multiplier),
    minCurrentHourUsd: String(rule.condition.minCurrentHourUsd),
    minIncreaseUsd: String(rule.condition.minIncreaseUsd),
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
    case 'model_approval_and_pricing':
      return `${COST_ALERT_CONDITION_LABELS[condition.type]}: ${condition.approvedModels.length} approved pairs in ${COST_ALERT_WINDOW_LABELS[condition.window]}`;
  }
}

export function formatChannelDestination(channel: CostAlertChannelLike): string {
  if (channel.config.type === 'email') {
    return channel.config.recipients.join(', ');
  }

  return channel.config.url;
}

export function formatScope(rule: CostAlertRuleLike, apiKeys: ApiKeyOption[]): string {
  const parts: string[] = [];

  if (rule.apiKeyIds && rule.apiKeyIds.length > 0) {
    const labels = rule.apiKeyIds
      .map((id) => apiKeys.find((apiKey) => apiKey._id === id))
      .filter((apiKey): apiKey is ApiKeyOption => Boolean(apiKey))
      .map((apiKey) => apiKey.name ?? apiKey.key);

    parts.push(labels.length > 0 ? labels.join(', ') : 'Selected API keys');
  } else {
    parts.push('All API keys');
  }

  if (rule.scope?.provider) parts.push(`Provider: ${rule.scope.provider}`);
  if (rule.scope?.model) parts.push(`Model: ${rule.scope.model}`);
  if (rule.scope?.baggageOperation) parts.push(`Operation: ${rule.scope.baggageOperation}`);
  if (rule.scope?.baggageUserId) parts.push(`User: ${rule.scope.baggageUserId}`);

  return parts.join(' · ');
}

function formatCurrency(value: number): string {
  return `$${value.toFixed(2)}`;
}
