'use client';

import { useMemo, useState } from 'react';
import type { DynamicToolUIPart, ToolUIPart } from 'ai';
import { Brain, ChevronUp, Loader2, Wrench } from 'lucide-react';
import { cn } from '@/lib/utils';
import { AnalystSandboxRunInline, type PiAgentStartOutput } from './AnalystSandboxRuns';
import { StructuredValue, type AnalystMessagePart } from './AnalystMessagePartView';

type AnalystToolPart = DynamicToolUIPart | ToolUIPart;

export type TimelinePart =
  | {
      type: 'reasoning';
      key: string;
      text: string;
      running: boolean;
    }
  | {
      type: 'tool';
      key: string;
      label: string;
      state: string;
      running: boolean;
      input?: unknown;
      output?: unknown;
      errorText?: string;
      piRun?: PiAgentStartOutput | null;
    };

const COLLAPSED_LIMIT = 4;

export function isTimelinePart(part: AnalystMessagePart) {
  return part.type === 'reasoning' || part.type === 'dynamic-tool' || part.type.startsWith('tool-');
}

export function toTimelinePart(part: AnalystMessagePart, key: string): TimelinePart | null {
  if (part.type === 'reasoning') {
    const text = part.text.trim();
    if (!text) return null;
    return {
      type: 'reasoning',
      key,
      text,
      running: part.state === 'streaming',
    };
  }

  if (part.type === 'dynamic-tool' || part.type.startsWith('tool-')) {
    const toolPart = part as AnalystToolPart;
    const label = toolLabel(toolPart);
    const state = toolState(toolPart);
    return {
      type: 'tool',
      key,
      label,
      state,
      running: isRunningToolState(state),
      input: 'input' in toolPart ? toolPart.input : undefined,
      output: 'output' in toolPart ? toolPart.output : undefined,
      errorText: 'errorText' in toolPart ? toolPart.errorText : undefined,
      piRun: getPiAgentStartOutput(toolPart),
    };
  }

  return null;
}

export function AnalystToolTimeline({ parts }: { parts: TimelinePart[] }) {
  const [expanded, setExpanded] = useState(false);
  const visibleParts = useMemo(
    () => parts.filter((part) => part.type !== 'reasoning' || part.text !== '[REDACTED]'),
    [parts],
  );
  const hasOverflow = visibleParts.length > COLLAPSED_LIMIT;
  const earlyParts = hasOverflow ? visibleParts.slice(0, -COLLAPSED_LIMIT) : [];
  const recentParts = hasOverflow ? visibleParts.slice(-COLLAPSED_LIMIT) : visibleParts;

  if (visibleParts.length === 0) return null;

  return (
    <div className="space-y-1 rounded-md border border-border/70 bg-background/50 px-2 py-1.5">
      {hasOverflow && !expanded && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="flex min-h-7 w-full items-center gap-2 text-left text-xs text-muted-foreground hover:text-foreground"
        >
          <span className="flex h-4 w-4 items-center justify-center">
            <span className="h-1 w-1 rounded-full bg-current opacity-60" />
          </span>
          <span>Show {earlyParts.length} earlier</span>
        </button>
      )}
      {hasOverflow && expanded && (
        <button
          type="button"
          onClick={() => setExpanded(false)}
          aria-label="Collapse earlier Analyst steps"
          className="flex min-h-7 w-full items-center gap-2 text-left text-xs text-muted-foreground hover:text-foreground"
        >
          <span className="flex h-4 w-4 items-center justify-center">
            <ChevronUp className="h-3 w-3" />
          </span>
        </button>
      )}
      {expanded &&
        earlyParts.map((part, index) => <TimelineStep key={part.key} part={part} index={index} />)}
      {recentParts.map((part, index) => (
        <TimelineStep key={part.key} part={part} index={earlyParts.length + index} />
      ))}
    </div>
  );
}

function TimelineStep({ part, index }: { part: TimelinePart; index: number }) {
  const [open, setOpen] = useState(
    part.type === 'reasoning' ||
      Boolean(part.piRun) ||
      (part.type === 'tool' &&
        (part.state === 'output-available' || part.state === 'output-error')),
  );
  const Icon = part.type === 'reasoning' ? Brain : Wrench;
  const hasDetail =
    part.type === 'reasoning' ||
    Boolean(part.piRun) ||
    Boolean(part.errorText) ||
    part.input !== undefined ||
    part.output !== undefined;

  return (
    <div
      className="relative"
      style={{
        animationDelay: `${Math.min(index * 30, 150)}ms`,
      }}
    >
      <button
        type="button"
        disabled={!hasDetail}
        onClick={() => hasDetail && setOpen((current) => !current)}
        className={cn(
          'flex min-h-7 w-full items-center gap-2 text-left text-xs',
          hasDetail && 'cursor-pointer',
        )}
      >
        <span className={cn('shrink-0 text-muted-foreground', part.running && 'animate-pulse')}>
          {part.running ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Icon className="h-4 w-4" />
          )}
        </span>
        <span className="font-medium text-foreground/75">
          {part.type === 'reasoning' ? 'Reasoning' : part.label}
        </span>
        {part.type === 'tool' && (
          <span className="truncate text-[10px] uppercase text-muted-foreground">{part.state}</span>
        )}
      </button>
      {open && hasDetail && (
        <div className="ml-2 mt-1 border-l border-border/70 pl-3">
          {part.type === 'reasoning' ? (
            <div className="whitespace-pre-wrap text-xs leading-relaxed text-muted-foreground">
              {part.text}
            </div>
          ) : part.piRun?.runId ? (
            <AnalystSandboxRunInline
              runId={part.piRun.runId}
              output={part.piRun}
              toolName={part.label}
              toolState={part.state}
            />
          ) : (
            <div className="space-y-2">
              {part.errorText && (
                <div className="rounded border border-destructive/30 bg-destructive/10 px-2 py-1 text-destructive">
                  {part.errorText}
                </div>
              )}
              {part.input !== undefined && <StructuredValue label="Input" value={part.input} />}
              {part.output !== undefined && <StructuredValue label="Output" value={part.output} />}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function toolLabel(part: AnalystToolPart) {
  if ('title' in part && typeof part.title === 'string' && part.title) return part.title;
  if ('toolName' in part && typeof part.toolName === 'string' && part.toolName) {
    return part.toolName;
  }
  return part.type.replace(/^tool-/, '');
}

function toolState(part: AnalystToolPart) {
  return 'state' in part && typeof part.state === 'string' ? part.state : 'running';
}

function isRunningToolState(state: string) {
  return !['output-available', 'output-denied', 'output-error'].includes(state);
}

function getPiAgentStartOutput(part: AnalystToolPart): PiAgentStartOutput | null {
  if (!('output' in part) || !part.output || typeof part.output !== 'object') return null;

  const output = part.output as Record<string, unknown>;
  if (output.type !== 'async_pi_agent_run') return null;

  return {
    ok: typeof output.ok === 'boolean' ? output.ok : undefined,
    type: 'async_pi_agent_run',
    async: typeof output.async === 'boolean' ? output.async : undefined,
    runId: typeof output.runId === 'string' ? output.runId : undefined,
    status: typeof output.status === 'string' ? output.status : undefined,
    maxRuntimeMinutes:
      typeof output.maxRuntimeMinutes === 'number' ? output.maxRuntimeMinutes : undefined,
    message: typeof output.message === 'string' ? output.message : undefined,
    error: typeof output.error === 'string' ? output.error : undefined,
  };
}
