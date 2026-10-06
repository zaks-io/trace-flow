import {
  TinybirdAuthError,
  TinybirdInsertError,
  TinybirdQueryError,
} from '@trace-flow/tinybird-client';
import { captureSafeException } from '@trace-flow/utils/sentry-tracing';
import { SnapshotCapturedDaysExpiredError, SnapshotDeadlineError } from './snapshot-runner-support';
import {
  type AGENT_SNAPSHOT_TARGETS,
  SnapshotCopyStartRejectedError,
  SnapshotProviderError,
} from './snapshot-tinybird';

export type SnapshotStage =
  | 'dispatch'
  | 'acquire-capacity'
  | 'read-copy-intent'
  | 'record-copy-intent'
  | 'start-copy'
  | 'attach-copy-receipt'
  | 'prepare-copy-check'
  | 'recover-copy-receipt'
  | 'read-copy-status'
  | 'settle-copy'
  | 'prepare-manifest'
  | 'publish-manifest'
  | 'finish-snapshot'
  | 'continue-snapshot';

interface SnapshotDiagnosticContext {
  stage: SnapshotStage;
  orgId?: string;
  generation?: number;
  copyIndex?: number;
  target?: (typeof AGENT_SNAPSHOT_TARGETS)[number];
  copyAttempt?: number;
  elapsedMs?: number;
}

const STACK_FILENAMES = [
  'index.js',
  'snapshot-runner.ts',
  'snapshot-runner-support.ts',
  'snapshot-tinybird.ts',
  'snapshot-queue.ts',
  'fetchPipe.ts',
  'insertRows.ts',
];

function classifySnapshotError(error: unknown): {
  type: string;
  message: string;
  httpStatus?: number;
} {
  if (error instanceof SnapshotDeadlineError)
    return {
      type: 'SnapshotDeadlineError',
      message: `Snapshot deadline reached ${error.phase} work`,
    };
  if (error instanceof SnapshotCapturedDaysExpiredError)
    return { type: 'SnapshotCapturedDaysExpiredError', message: 'Snapshot captured days expired' };
  if (error instanceof SnapshotCopyStartRejectedError)
    return {
      type: 'SnapshotCopyStartRejectedError',
      message: 'Snapshot Copy start rejected',
      httpStatus: error.status,
    };
  if (error instanceof TinybirdAuthError)
    return {
      type: 'TinybirdAuthError',
      message: 'Snapshot provider authorization failed',
      httpStatus: 403,
    };
  if (error instanceof SnapshotProviderError)
    return {
      type: 'SnapshotProviderError',
      message: 'Snapshot provider request failed',
      httpStatus: error.status,
    };
  if (error instanceof TinybirdQueryError || error instanceof TinybirdInsertError)
    return {
      type: error instanceof TinybirdQueryError ? 'TinybirdQueryError' : 'TinybirdInsertError',
      message: 'Snapshot provider request failed',
      httpStatus: error.status,
    };
  if (error instanceof DOMException && ['AbortError', 'TimeoutError'].includes(error.name))
    return { type: error.name, message: 'Snapshot provider request interrupted' };
  if (error instanceof TypeError)
    return { type: 'TypeError', message: 'Snapshot operation failed' };
  if (error instanceof SyntaxError)
    return { type: 'SyntaxError', message: 'Snapshot response parsing failed' };
  return { type: 'Error', message: 'Agent snapshot processing failed' };
}

export function captureSnapshotException(error: unknown, context: SnapshotDiagnosticContext): void {
  const { type, message, httpStatus } = classifySnapshotError(error);
  captureSafeException(error, {
    message,
    operation: 'agent_snapshot',
    diagnostics: {
      type,
      context: {
        stage: context.stage,
        orgId: context.orgId,
        generation: context.generation,
        copyIndex: context.copyIndex,
        target: context.target,
        copyAttempt: context.copyAttempt,
        elapsedMs: context.elapsedMs,
        httpStatus:
          Number.isSafeInteger(httpStatus) && httpStatus! >= 100 && httpStatus! <= 599
            ? httpStatus
            : undefined,
      },
      stackFilenames: STACK_FILENAMES,
    },
  });
}
