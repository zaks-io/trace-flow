import { action, type ActionCtx } from '../_generated/server';
import { v } from 'convex/values';
import { internal } from '../_generated/api';
import { requireAuthenticated } from '../auth/auth';

const DEFAULT_EXPLORER_LIMIT = 100;
const MAX_EXPLORER_LIMIT = 500;
const DEFAULT_EXPORT_LIMIT = 1000;
const MAX_EXPORT_LIMIT = 5000;
const DEFAULT_ADVANCED_LIMIT = 200;
const MAX_ADVANCED_LIMIT = 1000;

const breakdownDimensions = [
  'provider',
  'statusCode',
  'operation',
  'model',
  'skipReason',
  'orgId',
] as const;
type BreakdownDimension = (typeof breakdownDimensions)[number];

const filterArgs = {
  startTimeMs: v.number(),
  endTimeMs: v.number(),
  orgId: v.optional(v.string()),
  provider: v.optional(v.string()),
  statusCode: v.optional(v.string()),
  operation: v.optional(v.string()),
  skipReason: v.optional(v.string()),
  isSse: v.optional(v.union(v.literal('0'), v.literal('1'))),
  model: v.optional(v.string()),
} as const;

interface AnalyticsFilters {
  startTimeMs: number;
  endTimeMs: number;
  orgId?: string;
  provider?: string;
  statusCode?: string;
  operation?: string;
  skipReason?: string;
  isSse?: '0' | '1';
  model?: string;
}

type SqlValue = string | number | boolean | null;
type SqlRow = Record<string, SqlValue>;

interface SqlResponse {
  meta: { name: string; type: string }[];
  data: SqlRow[];
  rows: number;
}

interface BreakdownResultRow {
  dimension: string;
  serverErrorCount: number;
  skipCount: number;
  requestCount: number;
  serverErrorRate: number;
  skipRate: number;
  p95LatencyMs: number;
  totalTokens: number;
  responseBytes: number;
}

const columnValidator = v.object({
  name: v.string(),
  type: v.string(),
});

const filterOptionsValidator = v.object({
  providers: v.array(v.string()),
  statusCodes: v.array(v.string()),
  operations: v.array(v.string()),
  skipReasons: v.array(v.string()),
  models: v.array(v.string()),
  orgIds: v.array(v.string()),
});

const summaryValidator = v.object({
  requestCount: v.number(),
  serverErrorCount: v.number(),
  serverErrorRate: v.number(),
  skipCount: v.number(),
  skipRate: v.number(),
  avgLatencyMs: v.number(),
  p50LatencyMs: v.number(),
  p95LatencyMs: v.number(),
  p99LatencyMs: v.number(),
  avgTtfbMs: v.number(),
  p95TtfbMs: v.number(),
  totalTokens: v.number(),
  promptTokens: v.number(),
  completionTokens: v.number(),
  cacheReadTokens: v.number(),
  responseBytes: v.number(),
});

const timeseriesRowValidator = v.object({
  bucket: v.string(),
  requestCount: v.number(),
  serverErrorRate: v.number(),
  skipRate: v.number(),
  p95LatencyMs: v.number(),
  p95TtfbMs: v.number(),
  totalTokens: v.number(),
  responseBytes: v.number(),
});

const breakdownRowValidator = v.object({
  dimension: v.string(),
  requestCount: v.number(),
  serverErrorCount: v.number(),
  serverErrorRate: v.number(),
  skipCount: v.number(),
  skipRate: v.number(),
  p95LatencyMs: v.number(),
  totalTokens: v.number(),
  responseBytes: v.number(),
});

const breakdownMapValidator = v.object({
  provider: v.array(breakdownRowValidator),
  statusCode: v.array(breakdownRowValidator),
  operation: v.array(breakdownRowValidator),
  model: v.array(breakdownRowValidator),
  skipReason: v.array(breakdownRowValidator),
  orgId: v.array(breakdownRowValidator),
});

const explorerRowValidator = v.object({
  timestamp: v.string(),
  sampleInterval: v.number(),
  orgId: v.string(),
  provider: v.string(),
  statusCode: v.string(),
  operation: v.string(),
  skipReason: v.string(),
  isSse: v.string(),
  model: v.string(),
  totalLatencyMs: v.number(),
  prepLatencyMs: v.number(),
  ttfbMs: v.number(),
  isServerError: v.number(),
  totalTokens: v.number(),
  promptTokens: v.number(),
  completionTokens: v.number(),
  cacheReadTokens: v.number(),
  responseBytes: v.number(),
});

const queryRunnerValidator = v.object({
  sql: v.string(),
  columns: v.array(columnValidator),
  rows: v.array(v.array(v.string())),
  rowCount: v.number(),
});

async function requireAdminAction(ctx: ActionCtx) {
  await requireAuthenticated(ctx);
  const isAdmin = await ctx.runQuery(internal.auth.users.isAdminInternal);
  if (!isAdmin) {
    throw new Error('Admin access required');
  }
}

function getAnalyticsConfig() {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = process.env.CLOUDFLARE_ANALYTICS_API_TOKEN ?? process.env.CLOUDFLARE_API_TOKEN;
  const dataset = process.env.CLOUDFLARE_ANALYTICS_DATASET;

  if (!accountId) {
    throw new Error('CLOUDFLARE_ACCOUNT_ID environment variable is not set');
  }
  if (!apiToken) {
    throw new Error(
      'CLOUDFLARE_ANALYTICS_API_TOKEN or CLOUDFLARE_API_TOKEN environment variable is not set',
    );
  }
  if (!dataset) {
    throw new Error('CLOUDFLARE_ANALYTICS_DATASET environment variable is not set');
  }

  return { accountId, apiToken, dataset };
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(Math.floor(value), min), max);
}

function assertValidTimeRange(startTimeMs: number, endTimeMs: number) {
  if (!Number.isFinite(startTimeMs) || !Number.isFinite(endTimeMs)) {
    throw new Error('Invalid time range');
  }
  if (startTimeMs >= endTimeMs) {
    throw new Error('startTimeMs must be less than endTimeMs');
  }
}

function escapeSqlString(value: string) {
  return value.replace(/'/g, "''");
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function quoteIdentifier(value: string) {
  return `"${value.replace(/"/g, '""')}"`;
}

function toSqlDateTime(ms: number) {
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

function formatFilterValue(value: string) {
  if (value === '__empty__') {
    return '';
  }
  return value;
}

function buildWhereClause(filters: AnalyticsFilters) {
  const clauses = [
    `timestamp >= toDateTime('${toSqlDateTime(filters.startTimeMs)}')`,
    `timestamp < toDateTime('${toSqlDateTime(filters.endTimeMs)}')`,
  ];

  if (filters.orgId)
    clauses.push(`index1 = '${escapeSqlString(formatFilterValue(filters.orgId))}'`);
  if (filters.provider)
    clauses.push(`blob1 = '${escapeSqlString(formatFilterValue(filters.provider))}'`);
  if (filters.statusCode)
    clauses.push(`blob2 = '${escapeSqlString(formatFilterValue(filters.statusCode))}'`);
  if (filters.operation)
    clauses.push(`blob3 = '${escapeSqlString(formatFilterValue(filters.operation))}'`);
  if (filters.skipReason)
    clauses.push(`blob4 = '${escapeSqlString(formatFilterValue(filters.skipReason))}'`);
  if (filters.isSse) clauses.push(`blob5 = '${filters.isSse}'`);
  if (filters.model) clauses.push(`blob6 = '${escapeSqlString(formatFilterValue(filters.model))}'`);

  return clauses.join(' AND ');
}

function sortStrings(values: string[]) {
  return values.sort((a, b) => a.localeCompare(b));
}

function toNumber(value: SqlValue) {
  if (typeof value === 'number') return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'string' && value.length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function toStringValue(value: SqlValue) {
  if (value == null) return '';
  return String(value);
}

function safeDivide(numerator: number, denominator: number) {
  return denominator === 0 ? 0 : numerator / denominator;
}

function formatBucketTimestamp(seconds: number) {
  return new Date(seconds * 1000).toISOString().slice(0, 19).replace('T', ' ');
}

function pickGranularity(startTimeMs: number, endTimeMs: number) {
  const rangeMs = endTimeMs - startTimeMs;
  if (rangeMs <= 24 * 60 * 60 * 1000) {
    return {
      bucketSql: 'intDiv(toUInt32(timestamp), 60) * 60',
      label: 'minute',
    };
  }
  if (rangeMs <= 7 * 24 * 60 * 60 * 1000) {
    return {
      bucketSql: 'intDiv(toUInt32(timestamp), 3600) * 3600',
      label: 'hour',
    };
  }
  return {
    bucketSql: 'intDiv(toUInt32(timestamp), 86400) * 86400',
    label: 'day',
  };
}

async function runSql(sql: string): Promise<SqlResponse> {
  const { accountId, apiToken } = getAnalyticsConfig();
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/analytics_engine/sql`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiToken}`,
      },
      body: sql,
    },
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Analytics Engine query failed: ${response.status} ${errorText}`);
  }

  const data: unknown = await response.json();
  return data as SqlResponse;
}

async function runJsonQuery(sql: string) {
  const formattedSql = /\bFORMAT\s+JSON\b/i.test(sql) ? sql : `${sql}\nFORMAT JSON`;
  return runSql(formattedSql);
}

function buildSummarySql(filters: AnalyticsFilters, dataset: string) {
  const tableName = quoteIdentifier(dataset);
  return `
SELECT
  SUM(_sample_interval) AS requestCount,
  sumIf(_sample_interval, double4 > 0) AS serverErrorCount,
  sumIf(_sample_interval, blob4 != '') AS skipCount,
  SUM(_sample_interval * double1) AS weightedLatencySum,
  quantileExactWeighted(0.5)(double1, _sample_interval) AS p50LatencyMs,
  quantileExactWeighted(0.95)(double1, _sample_interval) AS p95LatencyMs,
  quantileExactWeighted(0.99)(double1, _sample_interval) AS p99LatencyMs,
  SUM(_sample_interval * double3) AS weightedTtfbSum,
  quantileExactWeighted(0.95)(double3, _sample_interval) AS p95TtfbMs,
  SUM(_sample_interval * double5) AS totalTokens,
  SUM(_sample_interval * double6) AS promptTokens,
  SUM(_sample_interval * double7) AS completionTokens,
  SUM(_sample_interval * double8) AS cacheReadTokens,
  SUM(_sample_interval * double9) AS responseBytes
FROM ${tableName}
WHERE ${buildWhereClause(filters)}
`;
}

function buildTimeseriesSql(filters: AnalyticsFilters, dataset: string) {
  const granularity = pickGranularity(filters.startTimeMs, filters.endTimeMs);
  const tableName = quoteIdentifier(dataset);
  return `
SELECT
  ${granularity.bucketSql} AS bucket,
  SUM(_sample_interval) AS requestCount,
  sumIf(_sample_interval, double4 > 0) AS serverErrorCount,
  sumIf(_sample_interval, blob4 != '') AS skipCount,
  quantileExactWeighted(0.95)(double1, _sample_interval) AS p95LatencyMs,
  quantileExactWeighted(0.95)(double3, _sample_interval) AS p95TtfbMs,
  SUM(_sample_interval * double5) AS totalTokens,
  SUM(_sample_interval * double9) AS responseBytes
FROM ${tableName}
WHERE ${buildWhereClause(filters)}
GROUP BY bucket
ORDER BY bucket ASC
`;
}

function getDimensionExpression(dimension: BreakdownDimension) {
  switch (dimension) {
    case 'provider':
      return "if(blob1 = '', '__empty__', blob1)";
    case 'statusCode':
      return "if(blob2 = '', '__empty__', blob2)";
    case 'operation':
      return "if(blob3 = '', '__empty__', blob3)";
    case 'model':
      return "if(blob6 = '', '__empty__', blob6)";
    case 'skipReason':
      return "if(blob4 = '', '__empty__', blob4)";
    case 'orgId':
      return "if(index1 = '', '__empty__', index1)";
  }
}

function buildBreakdownSql(
  filters: AnalyticsFilters,
  dataset: string,
  dimension: BreakdownDimension,
) {
  const dimensionSql = getDimensionExpression(dimension);
  const tableName = quoteIdentifier(dataset);
  return `
SELECT
  ${dimensionSql} AS dimension,
  SUM(_sample_interval) AS requestCount,
  sumIf(_sample_interval, double4 > 0) AS serverErrorCount,
  sumIf(_sample_interval, blob4 != '') AS skipCount,
  quantileExactWeighted(0.95)(double1, _sample_interval) AS p95LatencyMs,
  SUM(_sample_interval * double5) AS totalTokens,
  SUM(_sample_interval * double9) AS responseBytes
FROM ${tableName}
WHERE ${buildWhereClause(filters)}
GROUP BY dimension
ORDER BY requestCount DESC
LIMIT 50
`;
}

function buildExplorerSql(
  filters: AnalyticsFilters,
  dataset: string,
  limit: number,
  offset: number,
) {
  const tableName = quoteIdentifier(dataset);
  return `
SELECT
  timestamp AS eventTimestamp,
  _sample_interval AS sampleInterval,
  index1 AS orgId,
  blob1 AS provider,
  blob2 AS statusCode,
  blob3 AS operation,
  blob4 AS skipReason,
  blob5 AS isSse,
  blob6 AS model,
  double1 AS totalLatencyMs,
  double2 AS prepLatencyMs,
  double3 AS ttfbMs,
  double4 AS isServerError,
  double5 AS totalTokens,
  double6 AS promptTokens,
  double7 AS completionTokens,
  double8 AS cacheReadTokens,
  double9 AS responseBytes
FROM ${tableName}
WHERE ${buildWhereClause(filters)}
ORDER BY eventTimestamp DESC
LIMIT ${limit}
OFFSET ${offset}
`;
}

function buildCsv(rows: string[][], columns: { name: string }[]) {
  const escapeCell = (value: string) => {
    const escaped = value.replace(/"/g, '""');
    return /[",\n]/.test(escaped) ? `"${escaped}"` : escaped;
  };

  return [
    columns.map((column) => escapeCell(column.name)).join(','),
    ...rows.map((row) => row.map(escapeCell).join(',')),
  ].join('\n');
}

function toQueryRunnerResult(result: SqlResponse, sql: string) {
  return {
    sql,
    columns: result.meta.map((column) => ({
      name: column.name,
      type: column.type,
    })),
    rows: result.data.map((row) =>
      result.meta.map((column) => {
        const value = row[column.name];
        return value == null ? '' : String(value);
      }),
    ),
    rowCount: result.rows,
  };
}

async function awaitAllOrThrow<T>(labeled: { label: string; promise: Promise<T> }[]) {
  const results = await Promise.allSettled(labeled.map((entry) => entry.promise));
  const failedIndex = results.findIndex(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  );
  if (failedIndex !== -1) {
    const failed = results[failedIndex] as PromiseRejectedResult;
    const label = labeled[failedIndex]!.label;
    const message = failed.reason instanceof Error ? failed.reason.message : String(failed.reason);
    throw new Error(`[${label}] ${message}`);
  }
  return results.map((result) => (result as PromiseFulfilledResult<T>).value);
}

function mapBreakdownRows(result: SqlResponse): BreakdownResultRow[] {
  return result.data.map((row) => ({
    dimension: toStringValue(row.dimension),
    requestCount: toNumber(row.requestCount),
    serverErrorCount: toNumber(row.serverErrorCount),
    skipCount: toNumber(row.skipCount),
    serverErrorRate: safeDivide(toNumber(row.serverErrorCount), toNumber(row.requestCount)),
    skipRate: safeDivide(toNumber(row.skipCount), toNumber(row.requestCount)),
    p95LatencyMs: toNumber(row.p95LatencyMs),
    totalTokens: toNumber(row.totalTokens),
    responseBytes: toNumber(row.responseBytes),
  }));
}

function dimensionsFromBreakdown(rows: BreakdownResultRow[]) {
  return sortStrings(rows.map((row) => row.dimension).filter(Boolean));
}

function stripSqlComments(sql: string) {
  return sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

function buildSafeAdvancedSql(sql: string, startTimeMs: number, endTimeMs: number, limit: number) {
  const { dataset } = getAnalyticsConfig();
  const quotedDataset = quoteIdentifier(dataset);
  const trimmed = sql.trim();
  if (!trimmed) {
    throw new Error('SQL query is required');
  }
  if (trimmed.includes(';')) {
    throw new Error('Multiple SQL statements are not allowed');
  }
  if (!/^select\b/i.test(trimmed)) {
    throw new Error('Only SELECT statements are allowed');
  }
  if (
    /\b(show|insert|update|delete|drop|alter|create|truncate|grant|revoke|describe|explain|union|intersect|except|with)\b/i.test(
      trimmed,
    )
  ) {
    throw new Error('Unsupported SQL statement');
  }

  const stripped = stripSqlComments(trimmed);
  if (
    !new RegExp(
      `\\bfrom\\s+(?:${escapeRegex(quotedDataset)}|"${escapeRegex(dataset)}"|${escapeRegex(dataset)})\\b`,
      'i',
    ).test(stripped)
  ) {
    throw new Error(`Query must target the configured dataset: ${dataset}`);
  }
  if (!trimmed.includes('__TIME_FILTER__')) {
    throw new Error('Query must include the __TIME_FILTER__ placeholder');
  }

  const timeFilter = `timestamp >= toDateTime('${toSqlDateTime(startTimeMs)}') AND timestamp < toDateTime('${toSqlDateTime(endTimeMs)}')`;
  const withoutFormat = trimmed.replace(/\bFORMAT\s+\w+\b/i, '').trim();
  const withTimeFilter = withoutFormat.replace(/__TIME_FILTER__/g, timeFilter);
  const withoutLimit = withTimeFilter.replace(/\bLIMIT\s+\d+\b/gi, '').trim();
  return `${withoutLimit}\nLIMIT ${clamp(limit, 1, MAX_ADVANCED_LIMIT)}`;
}

export const getDashboard = action({
  args: filterArgs,
  returns: v.object({
    dataset: v.string(),
    granularity: v.string(),
    summary: summaryValidator,
    timeseries: v.array(timeseriesRowValidator),
    breakdowns: breakdownMapValidator,
    filterOptions: filterOptionsValidator,
  }),
  handler: async (ctx, args) => {
    await requireAdminAction(ctx);
    assertValidTimeRange(args.startTimeMs, args.endTimeMs);
    const { dataset } = getAnalyticsConfig();
    const granularity = pickGranularity(args.startTimeMs, args.endTimeMs).label;

    const [summaryResult, timeseriesResult, ...breakdownResults] = await awaitAllOrThrow([
      { label: 'summary', promise: runJsonQuery(buildSummarySql(args, dataset)) },
      { label: 'timeseries', promise: runJsonQuery(buildTimeseriesSql(args, dataset)) },
      ...breakdownDimensions.map((dimension) => ({
        label: dimension,
        promise: runJsonQuery(buildBreakdownSql(args, dataset, dimension)),
      })),
    ]);

    const summaryRow = summaryResult.data[0] ?? {};
    const breakdowns = Object.fromEntries(
      breakdownDimensions.map((dim, i) => [dim, mapBreakdownRows(breakdownResults[i]!)]),
    ) as Record<BreakdownDimension, BreakdownResultRow[]>;

    return {
      dataset,
      granularity,
      summary: {
        requestCount: toNumber(summaryRow.requestCount ?? 0),
        serverErrorCount: toNumber(summaryRow.serverErrorCount ?? 0),
        serverErrorRate: safeDivide(
          toNumber(summaryRow.serverErrorCount ?? 0),
          toNumber(summaryRow.requestCount ?? 0),
        ),
        skipCount: toNumber(summaryRow.skipCount ?? 0),
        skipRate: safeDivide(
          toNumber(summaryRow.skipCount ?? 0),
          toNumber(summaryRow.requestCount ?? 0),
        ),
        avgLatencyMs: safeDivide(
          toNumber(summaryRow.weightedLatencySum ?? 0),
          toNumber(summaryRow.requestCount ?? 0),
        ),
        p50LatencyMs: toNumber(summaryRow.p50LatencyMs ?? 0),
        p95LatencyMs: toNumber(summaryRow.p95LatencyMs ?? 0),
        p99LatencyMs: toNumber(summaryRow.p99LatencyMs ?? 0),
        avgTtfbMs: safeDivide(
          toNumber(summaryRow.weightedTtfbSum ?? 0),
          toNumber(summaryRow.requestCount ?? 0),
        ),
        p95TtfbMs: toNumber(summaryRow.p95TtfbMs ?? 0),
        totalTokens: toNumber(summaryRow.totalTokens ?? 0),
        promptTokens: toNumber(summaryRow.promptTokens ?? 0),
        completionTokens: toNumber(summaryRow.completionTokens ?? 0),
        cacheReadTokens: toNumber(summaryRow.cacheReadTokens ?? 0),
        responseBytes: toNumber(summaryRow.responseBytes ?? 0),
      },
      timeseries: timeseriesResult.data.map((row) => ({
        bucket: formatBucketTimestamp(toNumber(row.bucket)),
        requestCount: toNumber(row.requestCount),
        serverErrorRate: safeDivide(toNumber(row.serverErrorCount), toNumber(row.requestCount)),
        skipRate: safeDivide(toNumber(row.skipCount), toNumber(row.requestCount)),
        p95LatencyMs: toNumber(row.p95LatencyMs),
        p95TtfbMs: toNumber(row.p95TtfbMs),
        totalTokens: toNumber(row.totalTokens),
        responseBytes: toNumber(row.responseBytes),
      })),
      breakdowns,
      filterOptions: {
        providers: dimensionsFromBreakdown(breakdowns.provider),
        statusCodes: dimensionsFromBreakdown(breakdowns.statusCode),
        operations: dimensionsFromBreakdown(breakdowns.operation),
        skipReasons: dimensionsFromBreakdown(breakdowns.skipReason),
        models: dimensionsFromBreakdown(breakdowns.model),
        orgIds: dimensionsFromBreakdown(breakdowns.orgId),
      },
    };
  },
});

export const getExplorerRows = action({
  args: {
    ...filterArgs,
    limit: v.optional(v.number()),
    offset: v.optional(v.number()),
  },
  returns: v.object({
    sql: v.string(),
    columns: v.array(columnValidator),
    rows: v.array(explorerRowValidator),
    limit: v.number(),
    offset: v.number(),
    hasMore: v.boolean(),
  }),
  handler: async (ctx, args) => {
    await requireAdminAction(ctx);
    assertValidTimeRange(args.startTimeMs, args.endTimeMs);
    const { dataset } = getAnalyticsConfig();
    const limit = clamp(args.limit ?? DEFAULT_EXPLORER_LIMIT, 1, MAX_EXPLORER_LIMIT);
    const offset = clamp(args.offset ?? 0, 0, Number.MAX_SAFE_INTEGER);
    const sql = buildExplorerSql(args, dataset, limit + 1, offset);
    const result = await runJsonQuery(sql);
    const rows = result.data.slice(0, limit).map((row) => ({
      timestamp: toStringValue(row.eventTimestamp),
      sampleInterval: toNumber(row.sampleInterval),
      orgId: toStringValue(row.orgId),
      provider: toStringValue(row.provider),
      statusCode: toStringValue(row.statusCode),
      operation: toStringValue(row.operation),
      skipReason: toStringValue(row.skipReason),
      isSse: toStringValue(row.isSse),
      model: toStringValue(row.model),
      totalLatencyMs: toNumber(row.totalLatencyMs),
      prepLatencyMs: toNumber(row.prepLatencyMs),
      ttfbMs: toNumber(row.ttfbMs),
      isServerError: toNumber(row.isServerError),
      totalTokens: toNumber(row.totalTokens),
      promptTokens: toNumber(row.promptTokens),
      completionTokens: toNumber(row.completionTokens),
      cacheReadTokens: toNumber(row.cacheReadTokens),
      responseBytes: toNumber(row.responseBytes),
    }));

    return {
      sql,
      columns: result.meta.map((column) => ({ name: column.name, type: column.type })),
      rows,
      limit,
      offset,
      hasMore: result.data.length > limit,
    };
  },
});

export const runAdvancedQuery = action({
  args: {
    sql: v.string(),
    startTimeMs: v.number(),
    endTimeMs: v.number(),
    limit: v.optional(v.number()),
  },
  returns: queryRunnerValidator,
  handler: async (ctx, args) => {
    await requireAdminAction(ctx);
    assertValidTimeRange(args.startTimeMs, args.endTimeMs);
    const finalSql = buildSafeAdvancedSql(
      args.sql,
      args.startTimeMs,
      args.endTimeMs,
      args.limit ?? DEFAULT_ADVANCED_LIMIT,
    );
    const result = await runJsonQuery(finalSql);
    return toQueryRunnerResult(result, finalSql);
  },
});

export const exportExplorerCsv = action({
  args: {
    ...filterArgs,
    limit: v.optional(v.number()),
  },
  returns: v.object({
    filename: v.string(),
    csv: v.string(),
    rowCount: v.number(),
  }),
  handler: async (ctx, args) => {
    await requireAdminAction(ctx);
    assertValidTimeRange(args.startTimeMs, args.endTimeMs);
    const { dataset } = getAnalyticsConfig();
    const limit = clamp(args.limit ?? DEFAULT_EXPORT_LIMIT, 1, MAX_EXPORT_LIMIT);
    const sql = buildExplorerSql(args, dataset, limit, 0);
    const result = await runJsonQuery(sql);
    const normalized = toQueryRunnerResult(result, sql);
    const csv = buildCsv(normalized.rows, normalized.columns);
    const filename = `analytics-engine-explorer-${new Date(args.startTimeMs).toISOString().slice(0, 10)}-${new Date(args.endTimeMs).toISOString().slice(0, 10)}.csv`;
    return {
      filename,
      csv,
      rowCount: normalized.rowCount,
    };
  },
});
