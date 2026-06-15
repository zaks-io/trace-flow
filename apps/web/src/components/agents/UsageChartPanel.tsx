'use client';

import { Bot, DollarSign, Hash, MessageSquare, Wrench } from 'lucide-react';
import { AgentUsageChart } from './AgentUsageChart';
import {
  AGENT_METRICS,
  AGENT_METRIC_LABEL,
  AGENT_GROUP_BY,
  AGENT_GROUP_BY_LABEL,
  AGENT_GRANULARITIES,
  AGENT_GRANULARITY_LABEL,
  type AgentChartStyle,
  type AgentGranularity,
  type AgentGroupBy,
  type AgentMetric,
  type AgentTimeseriesRow,
} from './types';

const METRIC_ICON: Record<AgentMetric, React.ComponentType<{ className?: string }>> = {
  cost: DollarSign,
  tokens: Hash,
  messages: MessageSquare,
  sessions: Bot,
  'tool-events': Wrench,
};

function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  optionLabel,
  isDisabled,
  disabledTitle,
}: {
  options: readonly T[];
  value: T;
  onChange: (v: T) => void;
  optionLabel: (v: T) => string;
  isDisabled?: (v: T) => boolean;
  disabledTitle?: string;
}) {
  return (
    <div className="flex rounded-lg border border-border bg-background">
      {options.map((option) => {
        const disabled = isDisabled?.(option) ?? false;
        return (
          <button
            type="button"
            key={option}
            disabled={disabled}
            onClick={() => onChange(option)}
            title={disabled ? disabledTitle : undefined}
            className={`px-3 py-1 text-xs font-medium capitalize transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
              value === option
                ? 'bg-primary/10 text-primary'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {optionLabel(option)}
          </button>
        );
      })}
    </div>
  );
}

/**
 * The "where is my usage over time" hero: a metric/group-by/bucket/style-controlled time chart.
 * Owns no data — `metric` is lifted so the sibling driver panels rank by the same metric.
 */
export function UsageChartPanel({
  data,
  metric,
  onMetricChange,
  groupBy,
  onGroupByChange,
  granularity,
  onGranularityChange,
  chartStyle,
  onChartStyleChange,
  onGroupClick,
  labelFor,
}: {
  data: AgentTimeseriesRow[];
  metric: AgentMetric;
  onMetricChange: (m: AgentMetric) => void;
  groupBy: AgentGroupBy;
  onGroupByChange: (g: AgentGroupBy) => void;
  granularity: AgentGranularity;
  onGranularityChange: (g: AgentGranularity) => void;
  chartStyle: AgentChartStyle;
  onChartStyleChange: (s: AgentChartStyle) => void;
  onGroupClick: (value: string) => void;
  labelFor: (value: string) => string;
}) {
  const MetricIcon = METRIC_ICON[metric];
  // Tool Events carry no model, so Model grouping is unavailable for that metric.
  const groupDisabled = (g: AgentGroupBy) => g === 'model' && metric === 'tool-events';

  return (
    <div className="rounded-xl bg-card/40 p-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <MetricIcon className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-base font-medium text-foreground">
            {AGENT_METRIC_LABEL[metric]} over time
          </h2>
          {metric === 'cost' && (
            <span
              className="rounded-full border border-border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground"
              title="Agent Session Authoring Cost is an API-equivalent estimate, not provider spend. Some sources (notably Cursor) report only partial economics."
            >
              Estimated
            </span>
          )}
        </div>
        <SegmentedControl
          options={AGENT_METRICS}
          value={metric}
          onChange={onMetricChange}
          optionLabel={(m) => AGENT_METRIC_LABEL[m]}
        />
      </div>

      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">Group by</span>
          <SegmentedControl
            options={AGENT_GROUP_BY}
            value={groupBy}
            onChange={onGroupByChange}
            optionLabel={(g) => AGENT_GROUP_BY_LABEL[g]}
            isDisabled={groupDisabled}
            disabledTitle="Tool events are not attributed to a model"
          />
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">Bucket</span>
            <SegmentedControl
              options={AGENT_GRANULARITIES}
              value={granularity}
              onChange={onGranularityChange}
              optionLabel={(g) => AGENT_GRANULARITY_LABEL[g]}
            />
          </div>
          <SegmentedControl
            options={['stacked', 'line'] as AgentChartStyle[]}
            value={chartStyle}
            onChange={onChartStyleChange}
            optionLabel={(s) => s}
          />
        </div>
      </div>

      <AgentUsageChart
        data={data}
        metric={metric}
        groupBy={groupBy}
        granularity={granularity}
        chartStyle={chartStyle}
        onGroupClick={onGroupClick}
        labelFor={labelFor}
      />
    </div>
  );
}
