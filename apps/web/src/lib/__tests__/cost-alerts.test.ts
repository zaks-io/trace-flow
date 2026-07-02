import { describe, expect, it } from 'vitest';
import {
  alertFormFromRule,
  buildAlertInput,
  buildAlertScopeInput,
  buildChannelConfigInput,
  formatScope,
  formatCondition,
  formatProviderModelPairs,
  parseProviderModelPairs,
  parseRecipients,
  sanitizeHeaderRows,
} from '../cost-alerts';

describe('cost alert helpers', () => {
  it('parses email recipients from mixed separators', () => {
    expect(parseRecipients('Ops@example.com, finance@example.com\nops@example.com')).toEqual([
      'ops@example.com',
      'finance@example.com',
    ]);
  });

  it('sanitizes webhook header rows', () => {
    expect(
      sanitizeHeaderRows([
        { key: ' X-Test ', value: ' hello ' },
        { key: '', value: 'ignored' },
      ]),
    ).toEqual([{ key: 'X-Test', value: 'hello' }]);
  });

  it('parses provider/model pairs from line input', () => {
    expect(
      parseProviderModelPairs('OpenAI, gpt-4o\nanthropic, claude/sonnet\nopenai, gpt-4o'),
    ).toEqual([
      { provider: 'openai', model: 'gpt-4o' },
      { provider: 'anthropic', model: 'claude/sonnet' },
    ]);

    expect(() => parseProviderModelPairs('openai gpt-4o')).toThrow(
      'Provider/model pairs must use "provider, model" format',
    );
  });

  it('builds email channel config', () => {
    expect(
      buildChannelConfigInput({
        name: 'Ops',
        type: 'email',
        recipientsText: 'ops@example.com, finance@example.com',
        webhookUrl: '',
        webhookSecret: '',
        webhookHeaders: [],
      }),
    ).toEqual({
      type: 'email',
      recipients: ['ops@example.com', 'finance@example.com'],
    });
  });

  it('builds spike alert input', () => {
    expect(
      buildAlertInput({
        name: 'Spike',
        severity: 'warning',
        conditionType: 'hourly_spend_spike',
        window: 'last_24_hours',
        thresholdUsd: '',
        baselineHours: '48',
        multiplier: '2.5',
        minCurrentHourUsd: '15',
        minIncreaseUsd: '10',
        approvedModelsText: '',
        zeroCostModelsText: '',
        cooldownMinutes: '30',
        notifyOnRecovery: true,
        apiKeyIds: ['api_1'],
        provider: ' anthropic ',
        model: ' claude-sonnet-4 ',
        baggageOperation: ' review ',
        baggageUserId: ' user_123 ',
        channelIds: ['channel_1'],
      }),
    ).toEqual({
      name: 'Spike',
      severity: 'warning',
      channelIds: ['channel_1'],
      cooldownMinutes: 30,
      notifyOnRecovery: true,
      apiKeyIds: ['api_1'],
      scope: {
        provider: 'anthropic',
        model: 'claude-sonnet-4',
        baggageOperation: 'review',
        baggageUserId: 'user_123',
      },
      condition: {
        type: 'hourly_spend_spike',
        baselineHours: 48,
        multiplier: 2.5,
        minCurrentHourUsd: 15,
        minIncreaseUsd: 10,
      },
    });
  });

  it('builds model approval alert input with zero-cost allowances', () => {
    expect(
      buildAlertInput({
        name: 'Model guard',
        severity: 'error',
        conditionType: 'model_approval_and_pricing',
        window: 'last_hour',
        thresholdUsd: '',
        baselineHours: '24',
        multiplier: '2',
        minCurrentHourUsd: '10',
        minIncreaseUsd: '5',
        approvedModelsText: 'OpenAI, gpt-4o-mini\nopenai, free-tier',
        zeroCostModelsText: 'openai, free-tier',
        cooldownMinutes: '0',
        notifyOnRecovery: false,
        apiKeyIds: ['api_1'],
        provider: '',
        model: '',
        baggageOperation: ' checkout ',
        baggageUserId: '',
        channelIds: ['channel_1'],
      }),
    ).toEqual({
      name: 'Model guard',
      severity: 'error',
      channelIds: ['channel_1'],
      cooldownMinutes: 0,
      notifyOnRecovery: false,
      apiKeyIds: ['api_1'],
      scope: {
        baggageOperation: 'checkout',
      },
      condition: {
        type: 'model_approval_and_pricing',
        window: 'last_hour',
        approvedModels: [
          { provider: 'openai', model: 'gpt-4o-mini', allowZeroCost: undefined },
          { provider: 'openai', model: 'free-tier', allowZeroCost: true },
        ],
      },
    });
  });

  it('roundtrips and displays scoped alert filters', () => {
    const rule = {
      _id: 'alert_1',
      name: 'Scoped spend',
      severity: 'warning',
      apiKeyIds: ['api_1'],
      scope: {
        provider: 'openai',
        model: 'gpt-4o',
        baggageOperation: 'checkout',
        baggageUserId: 'user_456',
      },
      channelIds: ['channel_1'],
      cooldownMinutes: 60,
      notifyOnRecovery: true,
      condition: {
        type: 'absolute_spend_threshold',
        window: 'last_24_hours',
        thresholdUsd: 25,
      },
    } as const;

    expect(alertFormFromRule(rule as never)).toMatchObject({
      provider: 'openai',
      model: 'gpt-4o',
      baggageOperation: 'checkout',
      baggageUserId: 'user_456',
      apiKeyIds: ['api_1'],
    });
    expect(
      formatScope(rule as never, [{ _id: 'api_1' as never, name: 'Production', key: 'key-1' }]),
    ).toBe('Production · Provider: openai · Model: gpt-4o · Operation: checkout · User: user_456');
  });

  it('keeps empty scope fields unscoped for saves', () => {
    expect(
      buildAlertScopeInput({
        name: 'Budget',
        severity: 'warning',
        conditionType: 'projected_monthly_over',
        window: 'last_24_hours',
        thresholdUsd: '1000',
        baselineHours: '24',
        multiplier: '2',
        minCurrentHourUsd: '10',
        minIncreaseUsd: '5',
        approvedModelsText: '',
        zeroCostModelsText: '',
        cooldownMinutes: '60',
        notifyOnRecovery: true,
        apiKeyIds: [],
        provider: ' ',
        model: '',
        baggageOperation: '',
        baggageUserId: '',
        channelIds: ['channel_1'],
      }),
    ).toEqual({});
  });

  it('formats condition summaries for threshold rules', () => {
    expect(
      formatCondition({
        type: 'projected_monthly_over',
        thresholdUsd: 1000,
      }),
    ).toBe('Projected Monthly Over: $1000.00');
  });

  it('roundtrips and displays model approval conditions', () => {
    const approvedModels = [
      { provider: 'openai', model: 'gpt-4o-mini' },
      { provider: 'openai', model: 'free-tier', allowZeroCost: true },
    ];

    const rule = {
      _id: 'alert_1',
      name: 'Model guard',
      severity: 'error',
      channelIds: ['channel_1'],
      cooldownMinutes: 0,
      notifyOnRecovery: false,
      condition: {
        type: 'model_approval_and_pricing',
        window: 'last_hour',
        approvedModels,
      },
    } as const;

    expect(alertFormFromRule(rule as never)).toMatchObject({
      conditionType: 'model_approval_and_pricing',
      approvedModelsText: 'openai, gpt-4o-mini\nopenai, free-tier',
      zeroCostModelsText: 'openai, free-tier',
    });
    expect(formatProviderModelPairs(approvedModels, { zeroCostOnly: true })).toBe(
      'openai, free-tier',
    );
    expect(formatCondition(rule.condition as never)).toBe(
      'Model Approval: 2 approved pairs in Last Hour',
    );
  });
});
