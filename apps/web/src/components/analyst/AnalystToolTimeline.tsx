'use client';

import { useState } from 'react';
import type { DynamicToolUIPart, ToolUIPart } from 'ai';
import { AlertCircle, Brain, CheckCircle2, ChevronRight, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { AnalystSandboxRunInline, type PiAgentStartOutput } from './AnalystSandboxRuns';
import { StructuredValue, type AnalystMessagePart } from './AnalystMessagePartView';
import { getPiToolConfig } from './piToolConfig';

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
      toolName: string;
      state: string;
      running: boolean;
      input?: unknown;
      output?: unknown;
      errorText?: string;
      piRun?: PiAgentStartOutput | null;
    };

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
    const toolName = canonicalToolName(toolPart);
    const label = toolLabel(toolPart);
    const state = toolState(toolPart);
    return {
      type: 'tool',
      key,
      label,
      toolName,
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

export function AnalystToolStep({ part }: { part: TimelinePart }) {
  if (part.type === 'reasoning' && part.text === '[REDACTED]') return null;
  return <TimelineStep part={part} />;
}

function TimelineStep({ part }: { part: TimelinePart }) {
  const [open, setOpen] = useState(
    part.type === 'reasoning' ||
      Boolean(part.piRun) ||
      (part.type === 'tool' &&
        (part.state === 'output-available' || part.state === 'output-error')),
  );
  const config = part.type === 'reasoning' ? null : getPiToolConfig(part.toolName);
  const Icon = config?.icon ?? Brain;
  const accent = config?.accent ?? 'text-chart-3';
  const isError = part.type === 'tool' && part.state === 'output-error';
  const hasDetail =
    part.type === 'reasoning' ||
    Boolean(part.piRun) ||
    Boolean(part.errorText) ||
    part.input !== undefined ||
    part.output !== undefined;
  const isPiRun = part.type === 'tool' && Boolean(part.piRun?.runId);

  // The analysis run renders inline as a continuation of this turn — no label row,
  // no nested boundary — so it reads as one seamless agent call.
  if (isPiRun && part.type === 'tool' && part.piRun?.runId) {
    return (
      <AnalystSandboxRunInline
        runId={part.piRun.runId}
        output={part.piRun}
        toolState={part.state}
      />
    );
  }

  return (
    <div className="relative flex gap-2">
      <div className="relative flex flex-col items-center">
        <span className="z-10 mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center">
          {part.running ? (
            <Loader2 className={cn('h-4 w-4 animate-spin', accent)} />
          ) : isError ? (
            <AlertCircle className="h-4 w-4 text-destructive" />
          ) : (
            <Icon className={cn('h-4 w-4', accent)} />
          )}
        </span>
        <span className="mt-0.5 w-px flex-1 bg-border/70 last:hidden" aria-hidden />
      </div>

      <div className="min-w-0 flex-1 pb-2">
        <button
          type="button"
          disabled={!hasDetail}
          onClick={() => hasDetail && setOpen((current) => !current)}
          className={cn(
            'flex min-h-5 w-full items-center gap-1.5 text-left text-xs',
            hasDetail && 'cursor-pointer',
          )}
        >
          <span className={cn('font-medium', isError ? 'text-destructive' : 'text-foreground/80')}>
            {part.type === 'reasoning' ? 'Reasoning' : part.label}
          </span>
          {part.type === 'tool' && <StepStatusPill state={part.state} running={part.running} />}
          {hasDetail && !isPiRun && (
            <ChevronRight
              className={cn(
                'h-3 w-3 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none',
                open && 'rotate-90',
              )}
            />
          )}
        </button>
        {open && hasDetail && (
          <div className="mt-1">
            {part.type === 'reasoning' ? (
              <p className="whitespace-pre-wrap text-[13px] italic leading-relaxed text-muted-foreground">
                {part.text}
              </p>
            ) : (
              <div className="space-y-2">
                {part.errorText && (
                  <div className="rounded-md border border-destructive/30 bg-destructive/10 px-2 py-1 text-destructive">
                    {part.errorText}
                  </div>
                )}
                {part.input !== undefined && <StructuredValue label="Input" value={part.input} />}
                {part.output !== undefined && (
                  <StructuredValue label="Output" value={part.output} />
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function StepStatusPill({ state, running }: { state: string; running: boolean }) {
  if (running) {
    return (
      <span className="text-[10px] uppercase tracking-wide text-muted-foreground">working</span>
    );
  }
  if (state === 'output-error') {
    return <AlertCircle className="h-3 w-3 text-destructive" />;
  }
  if (state === 'output-available') {
    return <CheckCircle2 className="h-3 w-3 text-muted-foreground/60" />;
  }
  return <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{state}</span>;
}

function toolLabel(part: AnalystToolPart) {
  if ('title' in part && typeof part.title === 'string' && part.title) return part.title;
  const config = getPiToolConfig(canonicalToolName(part));
  if (config.label !== 'Tool') return config.label;
  if ('toolName' in part && typeof part.toolName === 'string' && part.toolName) {
    return part.toolName;
  }
  return part.type.replace(/^tool-/, '');
}

function canonicalToolName(part: AnalystToolPart) {
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
