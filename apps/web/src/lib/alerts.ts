import { parseSpanAttributes, type TraceSpanRow } from '@trace-flow/spans';
import { GEN_AI, GEN_AI_COST, GEN_AI_USAGE, HTTP } from '@trace-flow/otel-conventions';
import type { RequestRow } from '@/components/requests/data-table/columns';
import type {
  Alert,
  AlertField,
  AlertOperator,
  AlertSeverity,
  TriggeredAlert,
  TraceAlertSummary,
} from '@/types/alerts';

type TraceSpanInput = Pick<
  TraceSpanRow,
  | 'Timestamp'
  | 'TraceId'
  | 'SpanId'
  | 'SpanName'
  | 'ServiceName'
  | 'Duration'
  | 'StatusCode'
  | 'SpanAttributes'
  | 'ReceivedAt'
  | 'BaggageOperation'
>;

export function traceSpanToRequestRow(span: TraceSpanInput): RequestRow {
  return {
    ReceivedAt: span.ReceivedAt ?? span.Timestamp,
    Timestamp: span.Timestamp,
    TraceId: span.TraceId,
    SpanId: span.SpanId,
    SpanName: span.SpanName,
    ServiceName: span.ServiceName,
    Duration: span.Duration,
    StatusCode: span.StatusCode,
    SpanAttributes: span.SpanAttributes,
    BaggageOperation: span.BaggageOperation ?? '',
  };
}

function extractMetricValue(row: RequestRow, field: AlertField): number | string | boolean | null {
  const attrs = parseSpanAttributes(row.SpanAttributes);

  switch (field) {
    case 'duration_ms':
      return row.Duration / 1_000_000;

    case 'total_tokens': {
      const input = attrs[GEN_AI_USAGE.INPUT_TOKENS];
      const output = attrs[GEN_AI_USAGE.OUTPUT_TOKENS];
      if (input || output) {
        return (parseInt(input ?? '0', 10) || 0) + (parseInt(output ?? '0', 10) || 0);
      }
      return null;
    }

    case 'prompt_tokens': {
      const prompt = attrs[GEN_AI_USAGE.INPUT_TOKENS];
      return prompt ? parseInt(prompt, 10) : null;
    }

    case 'completion_tokens': {
      const completion = attrs[GEN_AI_USAGE.OUTPUT_TOKENS];
      return completion ? parseInt(completion, 10) : null;
    }

    case 'tokens_per_second': {
      const tps = attrs[GEN_AI.TOKENS_PER_SECOND];
      return tps ? parseFloat(tps) : null;
    }

    case 'ttft_ms': {
      const ttft = attrs[GEN_AI.SERVER_TTFT];
      return ttft ? parseFloat(ttft) : null;
    }

    case 'is_error':
      return row.StatusCode === 'ERROR';

    case 'http_status_code': {
      const statusCode = attrs[HTTP.RESPONSE_STATUS_CODE];
      return statusCode ? parseInt(statusCode, 10) : null;
    }

    case 'cost_total': {
      const cost = attrs[GEN_AI_COST.TOTAL];
      return cost ? parseFloat(cost) : null;
    }

    default:
      return null;
  }
}

function compareValues(
  actual: number | string | boolean | null,
  operator: AlertOperator,
  threshold: number | string | boolean,
): boolean {
  if (actual === null) return false;

  if (typeof actual === 'boolean' || typeof threshold === 'boolean') {
    switch (operator) {
      case 'eq':
        return actual === threshold;
      case 'neq':
        return actual !== threshold;
      default:
        return false;
    }
  }

  const numActual = typeof actual === 'string' ? parseFloat(actual) : actual;
  const numThreshold = typeof threshold === 'string' ? parseFloat(threshold) : threshold;

  if (typeof numActual !== 'number' || typeof numThreshold !== 'number') {
    return false;
  }

  if (isNaN(numActual) || isNaN(numThreshold)) {
    return false;
  }

  switch (operator) {
    case 'gt':
      return numActual > numThreshold;
    case 'lt':
      return numActual < numThreshold;
    case 'gte':
      return numActual >= numThreshold;
    case 'lte':
      return numActual <= numThreshold;
    case 'eq':
      return numActual === numThreshold;
    case 'neq':
      return numActual !== numThreshold;
    default:
      return false;
  }
}

function evaluateAlerts(row: RequestRow, alerts: Alert[]): TriggeredAlert[] {
  const enabledAlerts = alerts.filter((alert) => alert.enabled);
  const triggered: TriggeredAlert[] = [];

  for (const alert of enabledAlerts) {
    const actualValue = extractMetricValue(row, alert.field as AlertField);
    const isTriggered = compareValues(actualValue, alert.operator as AlertOperator, alert.value);

    if (isTriggered) {
      triggered.push({
        alert,
        actualValue,
      });
    }
  }

  return triggered;
}

const SEVERITY_ORDER: Record<AlertSeverity, number> = {
  info: 0,
  warning: 1,
  error: 2,
};

export function getHighestSeverity(severities: AlertSeverity[]): AlertSeverity | null {
  if (severities.length === 0) return null;
  return severities.reduce((highest, current) =>
    SEVERITY_ORDER[current] > SEVERITY_ORDER[highest] ? current : highest,
  );
}

export function evaluateAlertsForTraces(
  rows: RequestRow[],
  alerts: Alert[],
): Map<string, TraceAlertSummary> {
  const summaryMap = new Map<string, TraceAlertSummary>();

  for (const row of rows) {
    const triggered = evaluateAlerts(row, alerts);
    if (triggered.length === 0) continue;

    const existing = summaryMap.get(row.TraceId);
    if (existing) {
      existing.triggeredAlerts.push(...triggered);
      existing.highestSeverity = getHighestSeverity(
        existing.triggeredAlerts.map((t) => t.alert.severity as AlertSeverity),
      );
    } else {
      summaryMap.set(row.TraceId, {
        traceId: row.TraceId,
        triggeredAlerts: triggered,
        highestSeverity: getHighestSeverity(
          triggered.map((t) => t.alert.severity as AlertSeverity),
        ),
      });
    }
  }

  return summaryMap;
}

export function formatAlertValue(
  value: number | string | boolean | null,
  field: AlertField,
): string {
  if (value === null) return '-';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';

  if (typeof value === 'number') {
    switch (field) {
      case 'duration_ms':
      case 'ttft_ms':
        return `${value.toFixed(0)}ms`;
      case 'tokens_per_second':
        return `${value.toFixed(1)}/s`;
      case 'cost_total':
        return `$${value.toFixed(4)}`;
      default:
        return value % 1 === 0 ? value.toString() : value.toFixed(2);
    }
  }

  return String(value);
}

export function evaluateAlertsForSpans(
  rows: RequestRow[],
  alerts: Alert[],
): Map<string, TraceAlertSummary> {
  const summaryMap = new Map<string, TraceAlertSummary>();

  for (const row of rows) {
    const triggered = evaluateAlerts(row, alerts);
    if (triggered.length === 0) continue;

    summaryMap.set(row.SpanId, {
      traceId: row.TraceId,
      spanId: row.SpanId,
      triggeredAlerts: triggered,
      highestSeverity: getHighestSeverity(triggered.map((t) => t.alert.severity as AlertSeverity)),
    });
  }

  return summaryMap;
}
