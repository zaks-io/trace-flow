'use client';

import type { ReactNode } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { cn } from '@/lib/utils';

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
  children: ReactNode;
  expandedContent?: ReactNode;
}) {
  return (
    <section
      className={cn(
        'flex min-w-0 flex-col rounded-2xl border border-border/60 bg-card/40 p-5',
        className,
      )}
    >
      <header className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold tracking-tight text-foreground">{title}</h2>
          {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
        </div>
        <div className="flex shrink-0 items-center gap-2">
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
