'use client';

import type { Id } from '@trace-flow/convex/_generated/dataModel';
import { AlertCircle, CheckCircle2, Clock3, Loader2, Square } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { hasAnalystMessageContent, type AnalystMessage } from './analystMessageModel';

export const ANALYST_MAX_STEPS = 50;

export type QueuedAnalystRun = {
  threadId: Id<'analystThreads'>;
  afterOrder: number;
};

export type AnalystRunState = {
  phase: 'idle' | 'submitting' | 'queued' | 'running' | 'background' | 'failed';
  label: string;
  detail: string;
  busy: boolean;
};

export type AnalystRunStatusSandboxRun = {
  status: string;
};

export function getAnalystRunState({
  sending,
  currentThreadId,
  queuedRun,
  messages,
  sandboxRuns = [],
}: {
  sending: boolean;
  currentThreadId: Id<'analystThreads'> | null;
  queuedRun: QueuedAnalystRun | null;
  messages: AnalystMessage[];
  sandboxRuns?: AnalystRunStatusSandboxRun[];
}): AnalystRunState {
  if (sending) {
    return {
      phase: 'submitting',
      label: 'Submitting',
      detail: 'Saving the message and scheduling the run.',
      busy: true,
    };
  }

  if (!currentThreadId) {
    return {
      phase: 'idle',
      label: 'Ready',
      detail: 'Start a new Analyst run.',
      busy: false,
    };
  }

  const ordered = [...messages].sort((left, right) => {
    if (left.order !== right.order) return left.order - right.order;
    return left.stepOrder - right.stepOrder;
  });
  const active = [...ordered].reverse().find(isActiveMessage);
  if (active) {
    return {
      phase: 'running',
      label: active.status === 'pending' ? 'Starting' : 'Running',
      detail: activeToolDetail(active) ?? 'Streaming the Analyst response.',
      busy: true,
    };
  }

  const latest = ordered.at(-1);
  if (latest?.status === 'failed') {
    return {
      phase: 'failed',
      label: 'Failed',
      detail: 'The last Analyst run failed before completing.',
      busy: false,
    };
  }

  if (queuedRun?.threadId === currentThreadId) {
    const completedAfterQueue = ordered.some(
      (message) =>
        message.order > queuedRun.afterOrder &&
        message.role === 'assistant' &&
        message.status === 'success',
    );
    if (!completedAfterQueue) {
      return {
        phase: 'queued',
        label: 'Queued',
        detail: 'Convex accepted the message. Waiting for the stream to start.',
        busy: true,
      };
    }
  }

  const activeSandboxRun = sandboxRuns.find((run) => isActiveSandboxRunStatus(run.status));
  if (activeSandboxRun) {
    return {
      phase: 'background',
      label: 'Analyzing',
      detail: 'Working through your data in the background.',
      busy: false,
    };
  }

  return {
    phase: 'idle',
    label: 'Ready',
    detail: 'No Analyst run is active.',
    busy: false,
  };
}

export function AnalystRunStatusBar({
  state,
  onStop,
  stopping = false,
}: {
  state: AnalystRunState;
  onStop?: () => void;
  stopping?: boolean;
}) {
  const Icon = stateIcon[state.phase];
  const canStop = Boolean(onStop) && (state.phase === 'running' || state.phase === 'background');

  if (state.phase === 'idle') return null;

  return (
    <div className="border-b border-border bg-muted/20 px-3 py-1.5">
      <div className="flex items-center justify-between gap-3 text-xs">
        <div className="flex min-w-0 items-center gap-2">
          <Icon
            className={cn(
              'h-3.5 w-3.5 shrink-0',
              (state.busy || state.phase === 'background') && 'animate-spin',
              state.phase === 'failed' && 'text-destructive',
            )}
          />
          <span
            className={cn(
              'shrink-0 font-medium',
              state.phase === 'failed' ? 'text-destructive' : 'text-foreground',
            )}
          >
            {state.label}
          </span>
          <span className="truncate text-muted-foreground">{state.detail}</span>
        </div>
        {canStop && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={stopping}
            onClick={onStop}
            aria-label="Stop Analyst run"
            title={`Up to ${ANALYST_MAX_STEPS} steps per run`}
          >
            {stopping ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Square className="h-3.5 w-3.5" />
            )}
            Stop
          </Button>
        )}
      </div>
    </div>
  );
}

function isActiveMessage(message: AnalystMessage) {
  return (
    message.status === 'streaming' ||
    (message.status === 'pending' && !hasAnalystMessageContent(message))
  );
}

function isActiveSandboxRunStatus(status: string) {
  return status === 'queued' || status === 'starting' || status === 'running';
}

function activeToolDetail(message: AnalystMessage): string | null {
  const runningTool = message.parts.find((part) => {
    if (part.type === 'dynamic-tool' || part.type.startsWith('tool-')) {
      return (
        'state' in part &&
        typeof part.state === 'string' &&
        !['output-available', 'output-denied'].includes(part.state)
      );
    }
    return false;
  });
  if (!runningTool) return null;

  const label =
    runningTool.type === 'dynamic-tool'
      ? (runningTool.title ?? runningTool.toolName ?? 'tool')
      : runningTool.type.replace(/^tool-/, '');

  return `Running ${label}.`;
}

const stateIcon = {
  idle: CheckCircle2,
  submitting: Loader2,
  queued: Clock3,
  running: Loader2,
  background: Loader2,
  failed: AlertCircle,
} satisfies Record<AnalystRunState['phase'], typeof CheckCircle2>;
