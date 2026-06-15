'use client';

import { useState } from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { UsageChartPanel } from './UsageChartPanel';
import { AgentBreakdownPanels } from './AgentBreakdownPanels';
import { AgentBurnRatePanel } from './AgentBurnRatePanel';
import { AgentContextHealthPanel } from './AgentContextHealthPanel';
import { FailureLeaderboardTable } from './FailureLeaderboardTable';
import { ToolDeltaTable } from './ToolDeltaTable';
import { AgentSessionsTable } from './AgentSessionsTable';
import type {
  AgentBreakdownDimension,
  AgentChartStyle,
  AgentContextBreakdownDimension,
  AgentContextHealthRow,
  AgentGranularity,
  AgentGroupBy,
  AgentMetric,
  AgentSummaryRow,
  AgentTimeseriesRow,
  FailureLeaderboardRow,
  ToolDeltaRow,
} from './types';

const TABS = [
  { value: 'usage', label: 'Usage' },
  { value: 'cost', label: 'Cost & pace' },
  { value: 'context', label: 'Context' },
  { value: 'tools', label: 'Tools' },
  { value: 'sessions', label: 'Sessions' },
] as const;

interface AgentTabsProps {
  summary: AgentSummaryRow | null;
  timeseries: AgentTimeseriesRow[];
  burnSeries: AgentTimeseriesRow[];
  priorBurnSeries: AgentTimeseriesRow[];
  contextHealth: AgentContextHealthRow | null;
  failures: FailureLeaderboardRow[];
  deltas: ToolDeltaRow[];
  burnCurrentError: Error | null;
  burnPriorError: Error | null;
  contextError: Error | null;
  filterParams: Record<string, string | number>;
  timezone: string;
  attentionThresholdTokens: number;
  models: string[];
  calendarDays: number;
  groupBy: AgentGroupBy;
  onGroupByChange: (g: AgentGroupBy) => void;
  granularity: AgentGranularity;
  onGranularityChange: (g: AgentGranularity) => void;
  onGroupClick: (value: string) => void;
  labelFor: (value: string) => string;
  repoLabelMap: Map<string, string>;
  breakdownSelected: (dimension: AgentBreakdownDimension) => string[];
  breakdownToggle: (dimension: AgentBreakdownDimension, value: string) => void;
  contextSelected: (dimension: AgentContextBreakdownDimension) => string[];
  contextToggle: (dimension: AgentContextBreakdownDimension, value: string) => void;
}

/**
 * The drill-down layer below the Overview: each deep surface gets its own tab so the page reads
 * as an instrument panel instead of a wall of stacked sections.
 */
export function AgentTabs(props: AgentTabsProps) {
  const [metric, setMetric] = useState<AgentMetric>('cost');
  const [chartStyle, setChartStyle] = useState<AgentChartStyle>('stacked');

  const selectMetric = (m: AgentMetric) => {
    setMetric(m);
    // Tool events have no model grain; fall back to ungrouped if Model was selected.
    if (m === 'tool-events' && props.groupBy === 'model') props.onGroupByChange('none');
  };

  return (
    <Tabs defaultValue="usage">
      <TabsList variant="line" className="mb-2">
        {TABS.map((tab) => (
          <TabsTrigger key={tab.value} value={tab.value}>
            {tab.label}
          </TabsTrigger>
        ))}
      </TabsList>

      <TabsContent value="usage" className="space-y-6">
        <UsageChartPanel
          data={props.timeseries}
          metric={metric}
          onMetricChange={selectMetric}
          groupBy={props.groupBy}
          onGroupByChange={props.onGroupByChange}
          granularity={props.granularity}
          onGranularityChange={props.onGranularityChange}
          chartStyle={chartStyle}
          onChartStyleChange={setChartStyle}
          onGroupClick={props.onGroupClick}
          labelFor={props.labelFor}
        />
        <AgentBreakdownPanels
          filterParams={props.filterParams}
          metric={metric}
          labelFor={props.labelFor}
          selectedFor={props.breakdownSelected}
          onToggle={props.breakdownToggle}
          calendarDays={props.calendarDays}
        />
      </TabsContent>

      <TabsContent value="cost" className="space-y-6">
        <AgentBurnRatePanel
          summary={props.summary}
          currentRows={props.burnSeries}
          priorRows={props.priorBurnSeries}
          currentError={props.burnCurrentError}
          priorError={props.burnPriorError}
          filterParams={props.filterParams}
          timezone={props.timezone}
        />
      </TabsContent>

      <TabsContent value="context" className="space-y-6">
        <AgentContextHealthPanel
          row={props.contextHealth}
          error={props.contextError}
          filterParams={props.filterParams}
          models={props.models}
          attentionThresholdTokens={props.attentionThresholdTokens}
          labelFor={props.labelFor}
          selectedFor={props.contextSelected}
          onToggle={props.contextToggle}
        />
      </TabsContent>

      <TabsContent value="tools" className="space-y-4">
        <h2 className="text-base font-medium text-foreground">Tool reliability</h2>
        <FailureLeaderboardTable data={props.failures} />
        <ToolDeltaTable data={props.deltas} />
      </TabsContent>

      <TabsContent value="sessions" className="space-y-6">
        <AgentSessionsTable filterParams={props.filterParams} repoLabelMap={props.repoLabelMap} />
      </TabsContent>
    </Tabs>
  );
}
