import type { ToolCallResult } from '../protocol';

const DEFAULT_AGENT_HOURS = 168;
const MAX_AGENT_HOURS = 24 * 180;
const DEFAULT_AGENT_LIMIT = 25;
const MAX_AGENT_LIMIT = 100;
const DEFAULT_AGENT_TIMESERIES_LIMIT = 50;
const MAX_AGENT_TIMESERIES_LIMIT = 50;
const DEFAULT_AGENT_DISCOVERY_LIMIT = 25;
const MAX_AGENT_DISCOVERY_LIMIT = 50;

export const AGENT_VIEWS = {
  summary: 'agent_usage_summary',
  timeseries: 'agent_usage_timeseries',
  breakdown: 'agent_usage_breakdown',
  sessions: 'agent_sessions_browser',
  tool_failures: 'agent_failure_leaderboard',
  tool_deltas: 'agent_tool_period_delta',
  projects: 'agent_repo_directory',
} as const;

const GROUP_BY_VALUES = ['none', 'source', 'model', 'repo'] as const;
const GRANULARITY_VALUES = ['auto', 'hour', 'day'] as const;
const BREAKDOWN_DIMENSIONS = ['source', 'model', 'repo'] as const;
const BREAKDOWN_ORDER_VALUES = [
  'cost_usd',
  'total_tokens',
  'message_count',
  'session_count',
] as const;
const SESSION_SORT_VALUES = ['recent', 'cost', 'files', 'duration', 'messages'] as const;
const SOURCE_VALUES = ['claude', 'codex', 'cursor'] as const;

type AgentView = keyof typeof AGENT_VIEWS;
type Row = Record<string, unknown>;

interface AgentWindow {
  start_time_ms: number;
  end_time_ms: number;
  hours: number;
  retention_days: number;
}

interface AgentFilters {
  sources?: string[];
  models?: string[];
  repo_fingerprints?: string[];
}

export interface AgentAnalyticsParams {
  view?: string;
  hours?: number;
  start_time?: string;
  end_time?: string;
  start_time_ms?: number;
  end_time_ms?: number;
  filters?: AgentFilters;
  group_by?: string;
  granularity?: string;
  dimension?: string;
  order_by?: string;
  sort?: string;
  min_events?: number;
  limit?: number;
  offset?: number;
}

export interface AgentAnalyticsDescribeParams extends AgentAnalyticsParams {
  include_values?: boolean;
}

export function agentPageLimit(params: AgentAnalyticsParams, view: AgentView): number | undefined {
  if (view === 'summary') return undefined;
  if (view === 'timeseries') {
    return clampNumber(params.limit, DEFAULT_AGENT_TIMESERIES_LIMIT, MAX_AGENT_TIMESERIES_LIMIT);
  }
  return clampNumber(params.limit, DEFAULT_AGENT_LIMIT, MAX_AGENT_LIMIT);
}

export function toolError(message: string): ToolCallResult {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}

export function isAgentView(value: string | undefined): value is AgentView {
  return Boolean(value && Object.prototype.hasOwnProperty.call(AGENT_VIEWS, value));
}

function enumParam<T extends string>(
  value: string | undefined,
  allowed: readonly T[],
  fallback: T,
): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

function clampNumber(value: number | undefined, fallback: number, max: number): number {
  const candidate = value ?? fallback;
  const finite = Number.isFinite(candidate) ? candidate : fallback;
  return Math.max(1, Math.min(Math.floor(finite), max));
}

function nonNegativeNumber(value: number | undefined): number {
  const candidate = value ?? 0;
  const finite = Number.isFinite(candidate) ? candidate : 0;
  return Math.max(0, Math.floor(finite));
}

function parseTimeParam(
  msValue: number | undefined,
  isoValue: string | undefined,
): number | undefined {
  if (Number.isFinite(msValue)) return Number(msValue);
  if (isoValue === undefined) return undefined;
  const parsed = Date.parse(isoValue);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function inRetentionWindow(
  value: number | undefined,
  minMs: number,
  maxMs: number,
): number | undefined {
  if (value === undefined || Number.isNaN(value)) return undefined;
  return value >= minMs && value <= maxMs ? value : undefined;
}

export function invalidTimeParam(params: AgentAnalyticsParams): string | undefined {
  if (
    params.start_time !== undefined &&
    Number.isNaN(parseTimeParam(undefined, params.start_time))
  ) {
    return 'start_time';
  }
  if (params.end_time !== undefined && Number.isNaN(parseTimeParam(undefined, params.end_time))) {
    return 'end_time';
  }
  return undefined;
}

function addListParam(
  params: Record<string, string | number>,
  key: string,
  values: string[] | undefined,
): void {
  if (!Array.isArray(values)) return;
  const clean = values.filter((value) => typeof value === 'string' && value.length > 0);
  if (clean.length > 0) params[key] = clean.join(',');
}

export function buildWindowParams(
  params: AgentAnalyticsParams,
  retentionDays: number,
): AgentWindow {
  const nowMs = Date.now();
  const maxHours = Math.min(MAX_AGENT_HOURS, Math.max(1, retentionDays * 24));
  const minAllowedMs = nowMs - maxHours * 3_600_000;
  const parsedEndMs = parseTimeParam(params.end_time_ms, params.end_time);
  const endMs = inRetentionWindow(parsedEndMs, minAllowedMs, nowMs) ?? nowMs;
  const requestedHours = clampNumber(params.hours, DEFAULT_AGENT_HOURS, maxHours);
  const earliestStartMs = endMs - requestedHours * 3_600_000;
  const parsedStartMs = parseTimeParam(params.start_time_ms, params.start_time);
  const startMs = inRetentionWindow(parsedStartMs, minAllowedMs, nowMs) ?? earliestStartMs;
  const boundedStartMs = Math.max(startMs, endMs - maxHours * 3_600_000);
  const resolvedStartMs = Math.min(boundedStartMs, endMs);
  const resolvedEndMs = Math.max(boundedStartMs, endMs);

  return {
    start_time_ms: resolvedStartMs,
    end_time_ms: resolvedEndMs,
    hours: Math.max(1, Math.ceil((resolvedEndMs - resolvedStartMs) / 3_600_000)),
    retention_days: retentionDays,
  };
}

export function buildPipeParams(
  view: AgentView,
  params: AgentAnalyticsParams,
  window: AgentWindow,
): Record<string, string | number> {
  const pipeParams: Record<string, string | number> = {
    start_time_ms: window.start_time_ms,
    end_time_ms: window.end_time_ms,
  };
  addListParam(pipeParams, 'sources', params.filters?.sources);
  addListParam(pipeParams, 'models', params.filters?.models);
  addListParam(pipeParams, 'repos', params.filters?.repo_fingerprints);

  const limit = agentPageLimit(params, view);
  if (limit !== undefined) {
    pipeParams.limit = limit;
    pipeParams.offset = nonNegativeNumber(params.offset);
  }

  if (view === 'timeseries') {
    pipeParams.group_by = enumParam(params.group_by, GROUP_BY_VALUES, 'none');
    pipeParams.granularity = enumParam(params.granularity, GRANULARITY_VALUES, 'auto');
  }
  if (view === 'breakdown') {
    pipeParams.dimension = enumParam(params.dimension, BREAKDOWN_DIMENSIONS, 'source');
    pipeParams.order_by = enumParam(params.order_by, BREAKDOWN_ORDER_VALUES, 'cost_usd');
  }
  if (view === 'sessions') {
    pipeParams.sort = enumParam(params.sort, SESSION_SORT_VALUES, 'recent');
  }
  if (view === 'tool_failures') {
    pipeParams.min_events = clampNumber(params.min_events, 10, 10_000);
  }
  return pipeParams;
}

export function buildDiscoveryParams(
  params: AgentAnalyticsDescribeParams,
  window: AgentWindow,
): Record<string, string | number> {
  const pipeParams: Record<string, string | number> = {
    start_time_ms: window.start_time_ms,
    end_time_ms: window.end_time_ms,
    limit: clampNumber(params.limit, DEFAULT_AGENT_DISCOVERY_LIMIT, MAX_AGENT_DISCOVERY_LIMIT),
  };
  addListParam(pipeParams, 'sources', params.filters?.sources);
  addListParam(pipeParams, 'models', params.filters?.models);
  addListParam(pipeParams, 'repos', params.filters?.repo_fingerprints);
  return pipeParams;
}

export function buildStaticContract(window: AgentWindow) {
  return {
    views: {
      summary: 'KPI row for cost, tokens, messages, sessions, and priced coverage.',
      timeseries: 'Bucketed usage and tool-event metrics.',
      breakdown: 'Ranked usage by source, model, or repo.',
      sessions: 'Agent session rows, sortable by recency, cost, files, duration, or messages.',
      tool_failures: 'Tool failure leaderboard.',
      tool_deltas: 'Period-over-period tool usage movement.',
      projects: 'Repo/project fingerprints for filtering.',
    },
    date_range: {
      params: ['hours', 'start_time', 'end_time', 'start_time_ms', 'end_time_ms'],
      resolved_window: window,
    },
    filters: {
      sources: { type: 'string[]', allowed_values: [...SOURCE_VALUES] },
      models: {
        type: 'string[]',
        values_source: 'discovered from agent_usage_breakdown where dimension="model"',
      },
      repo_fingerprints: {
        type: 'string[]',
        values_source: 'discovered from agent_repo_directory and repo breakdown rows',
      },
    },
    view_parameters: {
      timeseries: { group_by: [...GROUP_BY_VALUES], granularity: [...GRANULARITY_VALUES] },
      breakdown: { dimension: [...BREAKDOWN_DIMENSIONS], order_by: [...BREAKDOWN_ORDER_VALUES] },
      sessions: {
        sort: [...SESSION_SORT_VALUES],
        limit: `1-${MAX_AGENT_LIMIT}`,
        offset: 'zero-based row offset',
      },
      tool_failures: {
        min_events: 'minimum tool events before a row is returned',
        limit: `1-${MAX_AGENT_LIMIT}`,
      },
      tool_deltas: { limit: `1-${MAX_AGENT_LIMIT}` },
    },
  };
}

export function valueRows(rows: Row[]) {
  return rows
    .filter((row) => typeof row.group_value === 'string' && row.group_value.length > 0)
    .map((row) => ({
      value: row.group_value,
      message_count: row.message_count,
      session_count: row.session_count,
      total_tokens: row.total_tokens,
      cost_usd: row.cost_usd,
    }));
}

export function projectRows(directoryRows: Row[], breakdownRows: Row[]) {
  const directoryByRepo = new Map(
    directoryRows
      .filter((row) => typeof row.repo_fingerprint === 'string' && row.repo_fingerprint.length > 0)
      .map((row) => [String(row.repo_fingerprint), row] as const),
  );
  return valueRows(breakdownRows).map((metrics) => {
    const directory = directoryByRepo.get(String(metrics.value));
    return {
      repo_fingerprint: metrics.value,
      normalized_git_remote: directory?.normalized_git_remote,
      repo_path_fallback: directory?.repo_path_fallback,
      repo_source: directory?.repo_source,
      metrics,
    };
  });
}
