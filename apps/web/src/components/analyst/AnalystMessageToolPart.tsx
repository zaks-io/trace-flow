'use client';

import { useState } from 'react';
import type { DynamicToolUIPart, ToolUIPart } from 'ai';
import { AlertCircle, Brain, CheckCircle2, ChevronRight, Loader2, Wrench } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { AnalystMessagePart } from './AnalystMessagePartView';
import { StructuredValue } from './StructuredValue';

export function AnalystMessageToolPart({ part }: { part: AnalystMessagePart }) {
  const reasoning = part.type === 'reasoning' ? part : null;
  const tool = reasoning ? null : (part as DynamicToolUIPart | ToolUIPart);
  const state = tool?.state;
  const [open, setOpen] = useState(state === 'output-available' || state === 'output-error');

  if (reasoning && (!reasoning.text.trim() || reasoning.text === '[REDACTED]')) return null;

  const input = tool && 'input' in tool ? tool.input : undefined;
  const output = tool && 'output' in tool ? tool.output : undefined;
  const errorText = tool && 'errorText' in tool ? tool.errorText : undefined;
  const running = reasoning
    ? reasoning.state === 'streaming'
    : !['output-available', 'output-denied', 'output-error'].includes(state ?? '');
  const isError = state === 'output-error';
  const hasDetail = Boolean(reasoning || errorText) || input !== undefined || output !== undefined;
  const Icon = reasoning ? Brain : Wrench;
  const accent = reasoning ? 'text-chart-3' : 'text-muted-foreground';
  const label = reasoning
    ? 'Thinking'
    : tool?.title ||
      (tool?.type === 'dynamic-tool' ? tool.toolName : tool?.type.replace(/^tool-/, ''));

  return (
    <div className="relative flex gap-2">
      <div className="relative flex flex-col items-center">
        <span className="z-10 mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center">
          {running ? (
            <Loader2 className={cn('h-4 w-4 animate-spin', accent)} />
          ) : isError ? (
            <AlertCircle className="h-4 w-4 text-destructive" />
          ) : (
            <Icon className={cn('h-4 w-4', accent)} />
          )}
        </span>
        {/* Parts are interleaved with text, so each step retains its connector rail. */}
        <span className="mt-0.5 w-px flex-1 bg-border/70" aria-hidden />
      </div>
      <div className="min-w-0 flex-1 pb-2">
        <button
          type="button"
          disabled={!hasDetail}
          aria-expanded={hasDetail ? open : undefined}
          onClick={() => hasDetail && setOpen((current) => !current)}
          className={cn(
            'flex min-h-5 w-full items-center gap-1.5 text-left text-xs',
            hasDetail && 'cursor-pointer',
          )}
        >
          <span className={cn('font-medium', isError ? 'text-destructive' : 'text-foreground/80')}>
            {label}
          </span>
          {tool && <ToolStatus state={tool.state} running={running} />}
          {hasDetail && (
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
            {reasoning ? (
              <p className="whitespace-pre-wrap text-[13px] italic leading-relaxed text-muted-foreground">
                {reasoning.text}
              </p>
            ) : (
              <div className="space-y-2">
                {errorText && (
                  <div className="rounded-md border border-destructive/30 bg-destructive/10 px-2 py-1 text-destructive">
                    {errorText}
                  </div>
                )}
                {input !== undefined && <StructuredValue label="Input" value={input} />}
                {output !== undefined && <StructuredValue label="Output" value={output} />}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function ToolStatus({ state, running }: { state: string; running: boolean }) {
  if (running) {
    return (
      <span className="text-[10px] uppercase tracking-wide text-muted-foreground">working</span>
    );
  }
  if (state === 'output-error') return <AlertCircle className="h-3 w-3 text-destructive" />;
  if (state === 'output-available')
    return <CheckCircle2 className="h-3 w-3 text-muted-foreground/60" />;
  return <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{state}</span>;
}
