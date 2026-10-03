import { describe, expect, it } from 'vitest';
import type { Id } from '@trace-flow/convex/_generated/dataModel';
import type { RequestRow } from '@/components/requests/data-table/columns';
import type { Alert } from '@/types/alerts';
import { evaluateAlertsForSpans } from '../alerts';

const isErrorAlert: Alert = {
  _id: 'alert_1' as Id<'alerts'>,
  _creationTime: 0,
  name: 'Errored request',
  field: 'is_error',
  operator: 'eq',
  value: true,
  severity: 'error',
  enabled: true,
  userId: 'user_1' as Id<'users'>,
  createdAt: 0,
  updatedAt: 0,
};

function row(spanId: string, statusCode: string): RequestRow {
  return {
    ReceivedAt: 0,
    Timestamp: 0,
    TraceId: 'trace_1',
    SpanId: spanId,
    SpanName: 'chat',
    ServiceName: 'trace-flow',
    Duration: 0,
    StatusCode: statusCode,
    SpanAttributes: '{}',
    AccountKey: '',
    BaggageOperation: '',
  };
}

describe('is_error alerts', () => {
  it('fires for spans stored with the OTel error status', () => {
    const summaries = evaluateAlertsForSpans(
      [row('errored', 'STATUS_CODE_ERROR'), row('ok', 'STATUS_CODE_OK')],
      [isErrorAlert],
    );

    expect([...summaries.keys()]).toEqual(['errored']);
    expect(summaries.get('errored')?.highestSeverity).toBe('error');
  });

  it('does not fire for unset spans', () => {
    expect(evaluateAlertsForSpans([row('unset', 'STATUS_CODE_UNSET')], [isErrorAlert]).size).toBe(
      0,
    );
  });
});
