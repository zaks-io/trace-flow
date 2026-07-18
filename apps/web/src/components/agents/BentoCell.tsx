'use client';

import type { ReactNode } from 'react';
import { Check, ChevronDown, ChevronUp } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useOptionalAnalyst } from '@/components/analyst/AnalystContext';
import type { AnalystPageContextReference } from '@/components/analyst/pageContext';

/**
 * Uniform chrome for one bento answer: a titled card that always shows its headline answer
 * and optionally expands in place to a deeper view of the SAME question. Expansion never
 * swaps the metric or routes away — the other cells stay visible.
 */
export function BentoCell({
  title,
  hint,
  caveat,
  className,
  expandable,
  expanded,
  onToggleExpand,
  toolbar,
  contextReference,
  children,
  expandedContent,
}: {
  title: string;
  /** Short standard-term sublabel under the title (e.g. "messages per session"). */
  hint?: string;
  /** Plain-language assumption shown as a quiet footnote (estimate, lower bound, etc.). */
  caveat?: ReactNode;
  className?: string;
  expandable?: boolean;
  expanded?: boolean;
  onToggleExpand?: () => void;
  /** Right-aligned controls in the header (e.g. a lens toggle). */
  toolbar?: ReactNode;
  contextReference?: AnalystPageContextReference;
  children: ReactNode;
  expandedContent?: ReactNode;
}) {
  const analyst = useOptionalAnalyst();
  const selectable = Boolean(analyst?.selectionMode && contextReference);
  const selected = contextReference
    ? (analyst?.isReferenceSelected(contextReference) ?? false)
    : false;
  const toggleSelection = () => {
    if (contextReference) analyst?.toggleReference(contextReference);
  };

  return (
    <section
      role={selectable ? 'button' : undefined}
      tabIndex={selectable ? 0 : undefined}
      aria-pressed={selectable ? selected : undefined}
      onClick={(event) => {
        if (!selectable) return;
        const target = event.target as HTMLElement;
        if (target !== event.currentTarget && target.closest('button,a,input,select,textarea')) {
          return;
        }
        toggleSelection();
      }}
      onKeyDown={(event) => {
        if (!selectable || (event.key !== 'Enter' && event.key !== ' ')) return;
        event.preventDefault();
        toggleSelection();
      }}
      className={cn(
        'relative flex min-w-0 flex-col rounded-2xl border border-border/60 bg-card/40 p-5',
        selectable && 'cursor-pointer transition-colors hover:border-primary/50',
        selected && 'border-primary/70 ring-2 ring-primary/30',
        className,
      )}
    >
      {selected && (
        <span className="absolute right-3 top-3 rounded-full bg-primary p-1 text-primary-foreground">
          <Check className="h-3 w-3" />
        </span>
      )}
      <header className="mb-3 flex flex-col items-start gap-3 sm:flex-row sm:justify-between">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold tracking-tight text-foreground">{title}</h2>
          {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
        </div>
        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:shrink-0 sm:justify-end">
          {toolbar}
          {expandable && (
            <button
              type="button"
              onClick={onToggleExpand}
              aria-expanded={expanded}
              className="flex items-center gap-1 rounded-lg border border-border/60 px-2 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              {expanded ? (
                <>
                  Less <ChevronUp className="h-3 w-3" />
                </>
              ) : (
                <>
                  Details <ChevronDown className="h-3 w-3" />
                </>
              )}
            </button>
          )}
        </div>
      </header>

      <div className="min-w-0 flex-1">{children}</div>

      {expanded && expandedContent && (
        <div className="mt-4 border-t border-border/60 pt-4">{expandedContent}</div>
      )}

      {caveat && (
        <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground/80">{caveat}</p>
      )}
    </section>
  );
}
