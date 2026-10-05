'use client';

import { useState } from 'react';
import { ChevronRight } from 'lucide-react';
import {
  decisionProbabilityEntries,
  formatDecisionValue,
  type DecisionBodyData,
  type DecisionField,
} from './decisionBody';

function DecisionFieldValue({ field }: { field: DecisionField }) {
  const probabilities = field.probabilities ? decisionProbabilityEntries(field.value) : null;

  return (
    <div className="min-w-0 space-y-1">
      <dt className="text-xs text-muted-foreground">{field.label}</dt>
      <dd>
        {probabilities ? (
          <dl className="space-y-1 text-xs">
            {probabilities.map(([option, probability]) => (
              <div key={option} className="flex items-start justify-between gap-3">
                <dt className="min-w-0 break-words text-foreground">{option}</dt>
                <dd className="shrink-0 tabular-nums text-muted-foreground">
                  {formatDecisionValue(probability, true)}
                </dd>
              </div>
            ))}
          </dl>
        ) : (
          <pre className="max-h-[300px] overflow-auto whitespace-pre-wrap break-words rounded border border-border/20 bg-zinc-950 p-2 text-xs text-zinc-300">
            {formatDecisionValue(field.value, field.probability)}
          </pre>
        )}
      </dd>
    </div>
  );
}

export function DecisionBodyDetails({ data }: { data: DecisionBodyData }) {
  const [collapsedEntries, setCollapsedEntries] = useState<Set<string>>(new Set());

  function toggleEntry(name: string) {
    setCollapsedEntries((previous) => {
      const next = new Set(previous);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  return (
    <div className="space-y-3">
      {data.kind === 'request' && (
        <div className="space-y-1">
          <h4 className="text-xs font-medium text-foreground">State</h4>
          <pre className="max-h-[300px] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border/30 bg-zinc-950 p-3 font-mono text-xs leading-relaxed text-zinc-300">
            {formatDecisionValue(data.state)}
          </pre>
        </div>
      )}
      <div className="space-y-1.5">
        <h4 className="text-xs font-medium text-foreground">
          {data.kind === 'request' ? 'Questions' : 'Answers'}
        </h4>
        {data.entries.length === 0 && (
          <p className="text-xs text-muted-foreground">
            No {data.kind === 'request' ? 'questions' : 'answers'} captured
          </p>
        )}
        {data.entries.map((entry) => {
          const expanded = !collapsedEntries.has(entry.name);
          return (
            <div
              key={entry.name}
              className="space-y-2 rounded-lg border border-border/30 bg-muted/10 p-2"
            >
              <button
                type="button"
                aria-expanded={expanded}
                onClick={() => toggleEntry(entry.name)}
                className="flex w-full items-center gap-2 rounded text-left transition-opacity hover:opacity-80 focus-visible:outline-2 focus-visible:outline-ring"
              >
                <ChevronRight
                  className={`h-3 w-3 shrink-0 text-muted-foreground transition-transform ${expanded ? 'rotate-90' : ''}`}
                />
                <span className="min-w-0 flex-1 break-words text-xs text-foreground">
                  {entry.name}
                </span>
                <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                  {entry.type === 'unknown' ? 'Unknown type' : entry.type}
                </span>
              </button>
              {expanded && (
                <dl className="ml-5 space-y-2">
                  {entry.fields.map((field) => (
                    <DecisionFieldValue key={field.label} field={field} />
                  ))}
                </dl>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
