'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useAction, useQuery } from 'convex/react';
import type { Id } from '@convex/_generated/dataModel';
import { api } from '@convex/_generated/api';
import { Ban, CheckCircle2, Clock3, Loader2, Square, Terminal, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { formatStructuredValue } from './structuredValue';

const CLIENT_RUN_TIMEOUT_GRACE_MS = 30_000;

export type SandboxRunStatus =
  | 'queued'
  | 'starting'
  | 'running'
  | 'completed'
  | 'failed'
  | 'timed_out'
  | 'cancelled';

export type SandboxRun = {
  _id: Id<'analystSandboxRuns'>;
  _creationTime: number;
  status: SandboxRunStatus;
  updatedAt: number;
  startedAt?: number;
  completedAt?: number;
  lastEventAt?: number;
  maxRuntimeMs: number;
  nextSeq?: number;
  resultText?: string;
  error?: string;
  needsStatusRefresh?: boolean;
};

export type SandboxRunEvent = {
  _id: Id<'analystSandboxRunEvents'>;
  seq: number;
  type: string;
  message?: string;
  data?: unknown;
  emittedAt: number;
};

export type PiAgentStartOutput = {
  ok?: boolean;
  type: 'async_pi_agent_run';
  async?: boolean;
  runId?: string;
  status?: string;
  maxRuntimeMinutes?: number;
  message?: string;
  error?: string;
};

export function AnalystSandboxRuns({ threadId }: { threadId: Id<'analystThreads'> | null }) {
  const runs = useQuery(api.analyst.listSandboxRuns, threadId ? { threadId } : 'skip') as
    | SandboxRun[]
    | undefined;

  if (!threadId || !runs?.length) return null;

  const visibleRuns = runs.filter((run, index) => isActive(run.status) || index === 0).slice(0, 3);
  if (visibleRuns.length === 0) return null;

  return (
    <div className="space-y-2 border-b border-border bg-muted/20 p-3">
      {visibleRuns.map((run) => (
        <AnalystSandboxRunCard key={run._id} run={run} />
      ))}
    </div>
  );
}

export function AnalystSandboxRunInline({
  runId,
  output,
  toolName,
  toolState,
}: {
  runId: string;
  output: PiAgentStartOutput;
  toolName: string;
  toolState: string;
}) {
  const convexRunId = runId as Id<'analystSandboxRuns'>;
  const run = useQuery(api.analyst.getSandboxRun, { runId: convexRunId }) as
    | SandboxRun
    | null
    | undefined;
  const fallbackRun = useMemo(
    () => buildFallbackRun(convexRunId, output),
    [convexRunId, output.error, output.maxRuntimeMinutes, output.status],
  );

  return (
    <AnalystSandboxRunCard
      run={run ?? fallbackRun}
      startMessage={output.message}
      toolName={toolName}
      toolState={toolState}
      variant="inline"
    />
  );
}

function AnalystSandboxRunCard({
  run,
  startMessage,
  toolName,
  toolState,
  variant = 'strip',
}: {
  run: SandboxRun;
  startMessage?: string;
  toolName?: string;
  toolState?: string;
  variant?: 'inline' | 'strip';
}) {
  const events = useQuery(api.analyst.listSandboxRunEvents, {
    runId: run._id,
    limit: 100,
  }) as SandboxRunEvent[] | undefined;
  const cancelRun = useAction(api.analyst.cancelSandboxRun);
  const refreshRunStatus = useAction(api.analyst.refreshSandboxRunStatus);
  const shouldRefreshStatus = isActive(run.status) || Boolean(run.needsStatusRefresh);
  const now = useNowWhileActive(shouldRefreshStatus);
  const refreshKeyRef = useRef<string | null>(null);
  const eventListRef = useRef<HTMLDivElement | null>(null);
  const resultRef = useRef<HTMLDivElement | null>(null);
  const displayRun = withClientDerivedTimeout(run, events, now);
  const active = isActive(displayRun.status);
  const Icon = statusIcon[displayRun.status];
  const refreshDeadline = clientTimeoutDeadlineMs(run, events) + CLIENT_RUN_TIMEOUT_GRACE_MS;
  const activity = latestRunActivity(displayRun, events, now);
  const usage = latestUsageSummary(events);
  const trustLabel = runTrustLabel(events);
  const formattedEvents = compactRunEvents(
    (events ?? []).map(formatRunEvent).filter(isFormattedRunEvent),
  )
    .filter((event) => !isFinalRunEventDuplicate(displayRun, event))
    .slice(-12);
  const latestFormattedEventKey = formattedEvents.at(-1)?.key;

  useEffect(() => {
    if (!shouldRefreshStatus) {
      refreshKeyRef.current = null;
      return;
    }
    if (!run.needsStatusRefresh && now < refreshDeadline) return;

    const refreshKey = `${run._id}:${refreshDeadline}`;
    if (refreshKeyRef.current === refreshKey) return;
    refreshKeyRef.current = refreshKey;
    void refreshRunStatus({ runId: run._id }).catch(() => {
      refreshKeyRef.current = null;
    });
  }, [
    now,
    refreshDeadline,
    refreshRunStatus,
    run._id,
    run.needsStatusRefresh,
    shouldRefreshStatus,
  ]);

  useEffect(() => {
    const element = eventListRef.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
  }, [formattedEvents.length, latestFormattedEventKey, displayRun.status]);

  useEffect(() => {
    const element = resultRef.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
  }, [displayRun.resultText, displayRun.error]);

  return (
    <div
      className={cn(
        'rounded-md border px-3 py-2 text-xs',
        variant === 'inline' ? 'border-border/70 bg-background/60' : 'border-border bg-background',
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2 font-medium">
            <Icon className={cn('h-3.5 w-3.5', active && 'animate-spin')} />
            <span>Pi analysis</span>
            {toolState && (
              <span className="rounded-full border border-border px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground">
                {toolState}
              </span>
            )}
            <span className="rounded-full border border-border px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground">
              {displayRun.status.replace('_', ' ')}
            </span>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-muted-foreground">
            <span>{runtimeLabel(displayRun, now)}</span>
            <span className="font-mono">{shortRunId(displayRun._id)}</span>
            {displayRun.nextSeq !== undefined && <span>{displayRun.nextSeq} events</span>}
            {toolName && <span>{toolName}</span>}
          </div>
        </div>
        {active && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void cancelRun({ runId: displayRun._id })}
            aria-label="Cancel Pi analysis"
          >
            <Square className="h-3.5 w-3.5" />
            Stop
          </Button>
        )}
      </div>

      {startMessage && (
        <div className="mt-2 rounded border border-border/70 bg-muted/30 px-2 py-1 text-[11px] text-muted-foreground">
          {startMessage}
        </div>
      )}

      {(activity || usage || trustLabel) && (
        <div className="mt-2 space-y-1 rounded border border-border/70 bg-muted/20 px-2 py-1 text-[11px] text-muted-foreground">
          {activity && (
            <div className="flex flex-wrap gap-x-2 gap-y-1">
              <span>phase {formatPhase(activity.phase)}</span>
              {activity.latestToolName && <span>tool {activity.latestToolName}</span>}
              {activity.idleMs !== undefined && <span>idle {formatDuration(activity.idleMs)}</span>}
              {activity.piEventCount !== undefined && (
                <span>{activity.piEventCount} Pi events</span>
              )}
              {activity.resultTextChars !== undefined && (
                <span>{formatCount(activity.resultTextChars)} chars</span>
              )}
            </div>
          )}
          {usage && <div>{usage}</div>}
          {trustLabel && <div>{trustLabel}</div>}
        </div>
      )}

      <div
        ref={eventListRef}
        className="mt-2 max-h-40 space-y-1 overflow-auto rounded border border-border/70 bg-muted/30 p-2 text-[11px] leading-relaxed"
      >
        {formattedEvents.map((event) => (
          <RunEventLine key={event.key} event={event} />
        ))}
        {!formattedEvents.length && (
          <div className="text-muted-foreground">
            {events === undefined ? 'Loading run activity...' : 'Waiting for run activity...'}
          </div>
        )}
      </div>

      {(displayRun.resultText || displayRun.error) && (
        <div
          ref={resultRef}
          className={cn(
            'mt-2 max-h-32 overflow-auto whitespace-pre-wrap rounded border px-2 py-1 text-[11px]',
            displayRun.error
              ? 'border-destructive/30 bg-destructive/10 text-destructive'
              : 'border-border/70 bg-muted/30',
          )}
        >
          {displayRun.error ?? displayRun.resultText}
        </div>
      )}
    </div>
  );
}

function RunEventLine({ event }: { event: FormattedRunEvent }) {
  return (
    <div className="grid grid-cols-[5.5rem_1fr] gap-2">
      <span
        className={cn(
          'truncate font-medium',
          event.tone === 'danger' ? 'text-destructive' : 'text-muted-foreground',
        )}
      >
        {event.label}
      </span>
      <span className="min-w-0 whitespace-pre-wrap break-words">{event.text}</span>
    </div>
  );
}

function isActive(status: SandboxRunStatus) {
  return status === 'queued' || status === 'starting' || status === 'running';
}

function useNowWhileActive(active: boolean) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const interval = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [active]);

  return active ? now : Date.now();
}

function withClientDerivedTimeout(
  run: SandboxRun,
  events: SandboxRunEvent[] | undefined,
  now = Date.now(),
): SandboxRun {
  if (!isActive(run.status)) return run;
  const latestEventAt = latestRunEventMs(run, events);
  const deadline = clientTimeoutDeadlineMs(run, events);
  if (now < deadline + CLIENT_RUN_TIMEOUT_GRACE_MS) return run;

  const startedAt = latestEventAt ? Math.min(runStartMs(run), latestEventAt) : runStartMs(run);
  return {
    ...run,
    status: 'timed_out',
    startedAt,
    completedAt: deadline,
    lastEventAt: latestEventAt,
    error:
      run.error ??
      'Run exceeded its configured max runtime and the sandbox did not send a completion callback.',
  };
}

function clientTimeoutDeadlineMs(run: SandboxRun, events: SandboxRunEvent[] | undefined) {
  const latestEventAt = latestRunEventMs(run, events);
  const startDeadline = runStartMs(run) + run.maxRuntimeMs;
  if (!latestEventAt) return startDeadline;
  return Math.min(startDeadline, latestEventAt + run.maxRuntimeMs);
}

function latestRunEventMs(run: SandboxRun, events: SandboxRunEvent[] | undefined) {
  return Math.max(run.lastEventAt ?? 0, ...(events ?? []).map((event) => event.emittedAt));
}

function runStartMs(run: SandboxRun) {
  return run.startedAt ?? run._creationTime;
}

export function runtimeLabel(run: SandboxRun, now = Date.now()) {
  const start = runStartMs(run);
  const end = run.completedAt ?? now;
  const elapsedSeconds = Math.max(0, Math.round((end - start) / 1000));
  const maxMinutes = Math.round(run.maxRuntimeMs / 60_000);
  return `${elapsedSeconds}s elapsed, max ${maxMinutes}m`;
}

type RunActivity = {
  phase?: string;
  latestToolName?: string;
  idleMs?: number;
  piEventCount?: number;
  resultTextChars?: number;
};

function latestRunActivity(
  run: SandboxRun,
  events: SandboxRunEvent[] | undefined,
  now = Date.now(),
): RunActivity | null {
  const eventList = events ?? [];
  const heartbeat = [...eventList]
    .reverse()
    .find((event) => isHeartbeatEvent(event) && isRecord(event.data));
  if (heartbeat && isRecord(heartbeat.data)) {
    return {
      phase: readString(heartbeat.data.phase),
      latestToolName: readString(heartbeat.data.latestToolName),
      idleMs: readNumber(heartbeat.data.idleMs),
      piEventCount: readNumber(heartbeat.data.piEventCount),
      resultTextChars: readNumber(heartbeat.data.resultTextChars),
    };
  }

  const latestStructured = [...eventList].reverse().find((event) => isRecord(event.data));
  if (!latestStructured || !isRecord(latestStructured.data)) {
    const latestEventAt = latestRunEventMs(run, events);
    return latestEventAt && isActive(run.status) ? { idleMs: now - latestEventAt } : null;
  }

  const data = latestStructured.data;
  const latestEventAt = latestRunEventMs(run, events);
  const phase =
    readString(data.phase) ??
    readString(data.eventType) ??
    readString(data.assistantEventType) ??
    readString(latestStructured.message) ??
    latestStructured.type;

  return {
    phase,
    latestToolName: readString(data.latestToolName) ?? readString(data.toolName),
    idleMs: isActive(run.status) && latestEventAt ? now - latestEventAt : undefined,
    piEventCount: run.nextSeq,
  };
}

function latestUsageSummary(events: SandboxRunEvent[] | undefined) {
  const usageEvent = [...(events ?? [])].reverse().find((event) => event.type === 'usage');
  return usageEvent ? formatUsageSummary(usageEvent.data) : null;
}

function runTrustLabel(events: SandboxRunEvent[] | undefined) {
  const runtimeConfigured = [...(events ?? [])].reverse().find((event) => {
    if (!isRecord(event.data)) return false;
    return event.data.projectTrusted === true || isRecord(event.data.discovery);
  });
  if (!runtimeConfigured || !isRecord(runtimeConfigured.data)) return null;
  if (runtimeConfigured.data.projectTrusted !== true) return null;

  const discovery = isRecord(runtimeConfigured.data.discovery)
    ? runtimeConfigured.data.discovery
    : null;
  const discoveryDisabled =
    discovery &&
    ['extensions', 'skills', 'promptTemplates', 'themes', 'contextFiles'].every(
      (key) => discovery[key] === false,
    );

  return discoveryDisabled
    ? 'trusted generated workspace, ambient Pi discovery disabled'
    : 'trusted generated workspace';
}

function isHeartbeatEvent(event: SandboxRunEvent) {
  return event.type === 'status' && event.message === 'Pi runner heartbeat';
}

function formatUsageSummary(data: unknown) {
  if (!isRecord(data) || !isRecord(data.usage)) return null;
  const tokens = isRecord(data.usage.tokens) ? data.usage.tokens : null;
  const cost = isRecord(data.usage.cost) ? data.usage.cost : null;
  const contextUsage = isRecord(data.usage.contextUsage) ? data.usage.contextUsage : null;
  const totalTokens = tokens
    ? (readNumber(tokens.totalTokens) ??
      readNumber(tokens.total) ??
      sumNumbers(tokens, ['input', 'output', 'cacheRead', 'cacheWrite']))
    : undefined;
  const cacheRead = tokens ? readNumber(tokens.cacheRead) : undefined;
  const totalCost = cost
    ? (readNumber(cost.total) ?? sumNumbers(cost, ['input', 'output', 'cacheRead', 'cacheWrite']))
    : undefined;
  const contextPercent =
    contextUsage !== null
      ? (readNumber(contextUsage.percent) ?? readNumber(contextUsage.percentage))
      : undefined;

  const parts: string[] = [];
  if (totalTokens !== undefined) parts.push(`${formatCount(totalTokens)} tokens`);
  if (cacheRead !== undefined && cacheRead > 0) parts.push(`${formatCount(cacheRead)} cached`);
  if (totalCost !== undefined) parts.push(formatCost(totalCost));
  if (contextPercent !== undefined) parts.push(`${Math.round(contextPercent)}% context`);

  return parts.length ? `usage ${parts.join(', ')}` : null;
}

function formatPhase(value: string | undefined) {
  return value ? value.replaceAll('_', ' ') : 'unknown';
}

function formatDuration(ms: number) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder ? `${minutes}m ${remainder}s` : `${minutes}m`;
}

function formatCount(value: number) {
  return Math.round(value).toLocaleString('en-US');
}

function formatCost(value: number) {
  if (value === 0) return '$0.00';
  if (Math.abs(value) < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

function sumNumbers(record: Record<string, unknown>, keys: string[]) {
  let total = 0;
  let found = false;
  for (const key of keys) {
    const value = readNumber(record[key]);
    if (value === undefined) continue;
    total += value;
    found = true;
  }
  return found ? total : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function readString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function readNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function shortRunId(runId: string) {
  return runId.length > 12 ? `${runId.slice(0, 6)}...${runId.slice(-4)}` : runId;
}

function buildFallbackRun(runId: Id<'analystSandboxRuns'>, output: PiAgentStartOutput): SandboxRun {
  const now = Date.now();
  const status = normalizeRunStatus(output.status);
  return {
    _id: runId,
    _creationTime: now,
    status,
    updatedAt: now,
    startedAt: now,
    maxRuntimeMs: Math.max(1, output.maxRuntimeMinutes ?? 60) * 60_000,
    error: output.error,
  };
}

function normalizeRunStatus(status: string | undefined): SandboxRunStatus {
  if (
    status === 'queued' ||
    status === 'starting' ||
    status === 'running' ||
    status === 'completed' ||
    status === 'failed' ||
    status === 'timed_out' ||
    status === 'cancelled'
  ) {
    return status;
  }
  return 'running';
}

type FormattedRunEvent = {
  key: string;
  label: string;
  text: string;
  mergeKey?: string;
  tone?: 'danger' | 'normal';
};

function isFormattedRunEvent(event: FormattedRunEvent | null): event is FormattedRunEvent {
  return event !== null;
}

function isFinalRunEventDuplicate(run: SandboxRun, event: FormattedRunEvent) {
  if (run.resultText && event.label === 'Result') return true;
  if (run.error && event.label === 'Error') return true;
  return false;
}

export function formatRunEvent(event: SandboxRunEvent): FormattedRunEvent | null {
  if (isHeartbeatEvent(event)) return null;

  if (event.type === 'usage') {
    const usageText = formatUsageSummary(event.data);
    return usageText ? { key: event._id, label: 'Usage', text: usageText } : null;
  }

  const piEvent = parsePiEvent(event.data);
  if (isHiddenPiLifecycleEvent(piEvent)) return null;
  const piText = formatPiEvent(event, piEvent);
  if (piText) return { key: event._id, ...piText };

  const structuredPiText = formatStructuredPiEvent(event);
  if (structuredPiText) return { key: event._id, ...structuredPiText };
  if (isStructuredPiEventData(event.data)) return null;

  const data =
    event.data && typeof event.data === 'object' ? formatStructuredValue(event.data) : '';
  const text = event.message ?? data;

  if (!text && event.type !== 'status') return null;

  if (event.type === 'tool_call') {
    return {
      key: event._id,
      label: 'Data query',
      text: text ? `Calling ${text}` : 'Calling data API',
    };
  }
  if (event.type === 'tool_result') {
    return {
      key: event._id,
      label: 'Data result',
      text: text ? `Received ${text}` : 'Received data',
    };
  }
  if (event.type === 'stderr' || event.type === 'error') {
    return { key: event._id, label: 'Error', text: text || `Event #${event.seq}`, tone: 'danger' };
  }
  if (event.type === 'result') {
    return { key: event._id, label: 'Result', text: text || `Event #${event.seq}` };
  }
  if (event.type === 'control') {
    return { key: event._id, label: 'Control', text: text || `Event #${event.seq}` };
  }
  if (event.type === 'stdout') {
    return { key: event._id, label: 'Output', text: text || `Event #${event.seq}` };
  }

  return { key: event._id, label: 'Status', text: text || `Event #${event.seq}` };
}

function isHiddenPiLifecycleEvent(event: PiEventEnvelope | null) {
  const eventType = typeof event?.type === 'string' ? event.type : undefined;
  const assistantType =
    typeof event?.assistantMessageEvent?.type === 'string'
      ? event.assistantMessageEvent.type
      : undefined;
  const delta =
    event?.assistantMessageEvent && typeof event.assistantMessageEvent.delta === 'string'
      ? event.assistantMessageEvent.delta.trim()
      : '';
  if (isToolCallAssistantEvent(assistantType)) return true;
  if (assistantType === 'text_delta' && isToolCallDelta(delta)) return true;
  if (assistantType && hiddenPiAssistantEvents.has(assistantType)) return true;
  if (!eventType || !hiddenPiLifecycleEvents.has(eventType)) return false;
  if (eventType === 'turn_end') return !piMessageContentText(event?.message);
  return true;
}

type PiEventEnvelope = {
  type?: unknown;
  assistantMessageEvent?: {
    type?: unknown;
    delta?: unknown;
    text?: unknown;
    message?: unknown;
  };
  message?: {
    role?: unknown;
    content?: unknown;
  };
  result?: {
    isError?: unknown;
    content?: unknown;
    details?: unknown;
  };
  arguments?: unknown;
  toolName?: unknown;
};

function parsePiEvent(data: unknown): PiEventEnvelope | null {
  if (!data || typeof data !== 'object') return null;
  const event = (data as { event?: unknown }).event;
  if (typeof event !== 'string') return null;

  try {
    const parsed = JSON.parse(event);
    return parsed && typeof parsed === 'object' ? (parsed as PiEventEnvelope) : null;
  } catch {
    return null;
  }
}

function formatPiEvent(
  event: SandboxRunEvent,
  piEvent: PiEventEnvelope | null,
): Omit<FormattedRunEvent, 'key'> | null {
  if (!piEvent) return null;

  const eventType = typeof piEvent?.type === 'string' ? piEvent.type : undefined;
  const assistant = piEvent?.assistantMessageEvent;
  const assistantType = typeof assistant?.type === 'string' ? assistant.type : undefined;
  const message = typeof event.message === 'string' ? event.message.trim() : '';

  if (eventType === 'turn_end') {
    const messageContent = piMessageContentText(piEvent.message);
    if (!messageContent) return null;
    return {
      label: piEvent.message?.role === 'assistant' ? 'Pi' : 'Message',
      text: messageContent,
    };
  }

  const toolExecution = piToolExecutionText(piEvent);
  if (toolExecution) return toolExecution;

  if (assistantType === 'text_delta') {
    const delta = typeof assistant?.delta === 'string' ? assistant.delta.trim() : '';
    if (isToolCallDelta(delta)) return null;
    return delta ? { label: 'Pi', text: delta, mergeKey: 'pi-delta' } : null;
  }

  if (isToolCallAssistantEvent(assistantType)) {
    return null;
  }

  if (assistantType?.endsWith('_delta')) {
    const delta = typeof assistant?.delta === 'string' ? assistant.delta.trim() : '';
    if (delta) {
      return {
        label: assistantType.includes('thinking') ? 'Reasoning' : 'Pi',
        text: delta,
        mergeKey: assistantType.includes('thinking') ? 'reasoning-delta' : 'pi-delta',
      };
    }
  }

  if (assistantType && hiddenPiAssistantEvents.has(assistantType)) {
    return null;
  }

  if (assistantType) {
    return { label: 'Pi', text: sentenceCase(assistantType.replaceAll('_', ' ')) };
  }

  if (eventType && hiddenPiLifecycleEvents.has(eventType)) {
    return null;
  }

  if (eventType && eventType !== 'message_update') {
    return { label: 'Pi event', text: sentenceCase(eventType.replaceAll('_', ' ')) };
  }

  if (message && message !== 'message_update') {
    return { label: event.type === 'stdout' ? 'Output' : 'Pi', text: message };
  }

  return null;
}

const hiddenPiLifecycleEvents = new Set([
  'agent_start',
  'agent_end',
  'turn_start',
  'turn_end',
  'message_start',
  'message_end',
  'thinking_start',
  'thinking_end',
]);

const hiddenPiAssistantEvents = new Set([
  'text_start',
  'text_end',
  'thinking_start',
  'thinking_end',
  'toolcall_start',
  'toolcall_end',
  'tool_call_start',
  'tool_call_end',
]);

function isToolCallAssistantEvent(value: string | undefined) {
  return Boolean(value?.includes('toolcall') || value?.includes('tool_call'));
}

function isToolCallDelta(value: string) {
  if (!value.startsWith('{')) return false;
  const parsed = parseJsonRecord(value);
  return Boolean(
    parsed && (typeof parsed.toolName === 'string' || typeof parsed.toolCallId === 'string'),
  );
}

function piMessageContentText(message: PiEventEnvelope['message']) {
  if (!message || !Array.isArray(message.content)) return '';

  const text = message.content
    .map((part) => {
      if (!part || typeof part !== 'object') return '';
      const content = part as { type?: unknown; text?: unknown; thinking?: unknown };
      if (content.type === 'text' && typeof content.text === 'string') return content.text.trim();
      return '';
    })
    .filter(Boolean)
    .join('\n\n');

  if (text) return text;

  return message.content
    .map((part) => {
      if (!part || typeof part !== 'object') return '';
      const content = part as { type?: unknown; thinking?: unknown };
      if (content.type === 'thinking' && typeof content.thinking === 'string') {
        return content.thinking.trim();
      }
      return '';
    })
    .filter(Boolean)
    .join('\n\n');
}

function piToolExecutionText(event: PiEventEnvelope): Omit<FormattedRunEvent, 'key'> | null {
  const toolName = typeof event.toolName === 'string' ? event.toolName : 'traceflow_data';
  if (event.type === 'tool_execution_start') {
    return {
      label: 'Tool',
      text: `${toolName} started`,
    };
  }

  if (event.type === 'tool_execution_update') {
    return {
      label: 'Tool',
      text: `${toolName} updated`,
    };
  }

  if (event.type !== 'tool_execution_end' || !event.result) return null;

  const content = Array.isArray(event.result.content)
    ? event.result.content
        .map((part) => {
          if (!part || typeof part !== 'object') return '';
          const text = (part as { text?: unknown }).text;
          return typeof text === 'string' ? text.trim() : '';
        })
        .filter(Boolean)
        .join('\n')
    : '';

  if (event.result.isError === true) {
    return {
      label: 'Data error',
      text: content ? `${toolName}: ${content}` : `${toolName} failed`,
      tone: 'danger',
    };
  }

  return {
    label: 'Data result',
    text: content ? `${toolName}: ${summarizeToolResultContent(content)}` : `${toolName} completed`,
  };
}

function summarizeToolResultContent(content: string) {
  const traceFlowSummary = summarizeTraceFlowToolResult(content);
  if (traceFlowSummary) return traceFlowSummary;
  if (content.length <= 480) return content;
  return `${content.slice(0, 480)}...[truncated]`;
}

function summarizeTraceFlowToolResult(content: string) {
  const outer = parseJsonRecord(content);
  const firstText = Array.isArray(outer?.content)
    ? outer.content
        .map((part) => (isRecord(part) && typeof part.text === 'string' ? part.text : ''))
        .find(Boolean)
    : undefined;
  const payload = parseJsonRecord(firstText);
  const summary = isRecord(payload?.summary) ? payload.summary : null;
  if (!summary) return null;

  const requestCount = readNumber(summary.request_count);
  const errorCount = readNumber(summary.error_count);
  const tokens = isRecord(summary.tokens) ? readNumber(summary.tokens.total) : undefined;
  const cost = isRecord(summary.cost_usd) ? readNumber(summary.cost_usd.total) : undefined;
  const parts: string[] = [];
  if (requestCount !== undefined) parts.push(`${formatCount(requestCount)} requests`);
  if (errorCount !== undefined) parts.push(`${formatCount(errorCount)} errors`);
  if (tokens !== undefined) parts.push(`${formatCount(tokens)} tokens`);
  if (cost !== undefined) parts.push(formatCost(cost));

  return parts.length ? parts.join(', ') : null;
}

function parseJsonRecord(value: unknown) {
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function formatStructuredPiEvent(event: SandboxRunEvent): Omit<FormattedRunEvent, 'key'> | null {
  if (!event.data || typeof event.data !== 'object') return null;

  const data = event.data as { assistantEventType?: unknown; eventType?: unknown };
  const assistantType =
    typeof data.assistantEventType === 'string' ? data.assistantEventType : undefined;
  const eventType = typeof data.eventType === 'string' ? data.eventType : undefined;
  const message = typeof event.message === 'string' ? event.message.trim() : '';

  if (assistantType?.endsWith('_delta') && message) {
    if (isToolCallAssistantEvent(assistantType)) return null;
    return {
      label: assistantType.includes('thinking') ? 'Reasoning' : 'Pi',
      text: message,
      mergeKey: assistantType.includes('thinking') ? 'reasoning-delta' : 'pi-delta',
    };
  }

  if (assistantType && hiddenPiAssistantEvents.has(assistantType)) {
    return null;
  }

  if (assistantType) {
    return { label: 'Pi', text: sentenceCase(assistantType.replaceAll('_', ' ')) };
  }

  if (eventType && hiddenPiLifecycleEvents.has(eventType)) {
    return null;
  }

  if (eventType && eventType !== 'message_update') {
    return { label: 'Pi event', text: sentenceCase(eventType.replaceAll('_', ' ')) };
  }

  return null;
}

function isStructuredPiEventData(data: unknown) {
  if (!data || typeof data !== 'object') return false;
  const eventData = data as { assistantEventType?: unknown; eventType?: unknown };
  return (
    typeof eventData.assistantEventType === 'string' || typeof eventData.eventType === 'string'
  );
}

function sentenceCase(text: string) {
  if (!text) return text;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function compactRunEvents(events: FormattedRunEvent[]) {
  const compacted: FormattedRunEvent[] = [];

  for (const event of events) {
    const previous = compacted.at(-1);
    if (previous?.mergeKey && previous.mergeKey === event.mergeKey) {
      previous.key = event.key;
      previous.text = joinDeltaText(previous.text, event.text);
      continue;
    }
    compacted.push({ ...event });
  }

  return compacted;
}

function joinDeltaText(previous: string, next: string) {
  if (!previous) return next;
  if (!next) return previous;
  if (/^\s/.test(next) || /[\s([{"'`/-]$/.test(previous) || /^[,.;:!?)]/.test(next)) {
    return previous + next;
  }
  return `${previous} ${next}`;
}

const statusIcon = {
  queued: Clock3,
  starting: Loader2,
  running: Loader2,
  completed: CheckCircle2,
  failed: XCircle,
  timed_out: XCircle,
  cancelled: Ban,
} satisfies Record<SandboxRunStatus, typeof Terminal>;
