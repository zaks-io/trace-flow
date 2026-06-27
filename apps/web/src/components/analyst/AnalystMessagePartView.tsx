'use client';

import type { FileUIPart, SourceDocumentUIPart, SourceUrlUIPart } from 'ai';
import { useSmoothText } from '@convex-dev/agent/react';
import { CircleAlert, FileText, LinkIcon } from 'lucide-react';
import type { AnalystMessage } from './analystMessageModel';
import { AnalystMarkdown } from './analystMarkdown';
import { formatStructuredValue } from './structuredValue';

export type AnalystMessagePart = AnalystMessage['parts'][number];
export type AnalystDataPart = Extract<AnalystMessagePart, { type: `data-${string}` }>;

/** Source URLs come from agent/tool output, so only http(s) may become a clickable link (no javascript:/data:). */
function isSafeHttpUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

export function AnalystMessagePartView({
  part,
  isStreaming,
}: {
  part: AnalystMessagePart;
  isStreaming: boolean;
}) {
  switch (part.type) {
    case 'text':
      return <TextPart text={part.text} streaming={isStreaming || part.state === 'streaming'} />;
    case 'source-url':
      return <SourceUrlPart part={part} />;
    case 'source-document':
      return <SourceDocumentPart part={part} />;
    case 'file':
      return <FilePart part={part} />;
    case 'step-start':
    case 'reasoning':
    case 'dynamic-tool':
      return null;
    default:
      if (part.type.startsWith('tool-')) return null;
      if (part.type.startsWith('data-')) return <DataPart part={part as AnalystDataPart} />;
      return null;
  }
}

export function TextPart({ text, streaming }: { text: string; streaming: boolean }) {
  const [visibleText] = useSmoothText(text, { startStreaming: streaming });
  const content = streaming ? visibleText || text : visibleText;

  if (!content.trim()) return null;
  return <AnalystMarkdown>{content}</AnalystMarkdown>;
}

function SourceUrlPart({ part }: { part: SourceUrlUIPart }) {
  const label = part.title ?? part.url;
  if (!isSafeHttpUrl(part.url)) {
    return (
      <span className="inline-flex max-w-full items-center gap-1 rounded-md border border-border/70 bg-background/60 px-2 py-1 text-xs text-muted-foreground">
        <LinkIcon className="h-3 w-3 shrink-0" />
        <span className="truncate">{label}</span>
      </span>
    );
  }
  return (
    <a
      href={part.url}
      target="_blank"
      rel="noreferrer"
      className="inline-flex max-w-full items-center gap-1 rounded-md border border-border/70 bg-background/60 px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
    >
      <LinkIcon className="h-3 w-3 shrink-0" />
      <span className="truncate">{label}</span>
    </a>
  );
}

function SourceDocumentPart({ part }: { part: SourceDocumentUIPart }) {
  return (
    <div className="inline-flex max-w-full items-center gap-1 rounded-md border border-border/70 bg-background/60 px-2 py-1 text-xs text-muted-foreground">
      <FileText className="h-3 w-3 shrink-0" />
      <span className="truncate">{part.title ?? part.filename ?? part.sourceId}</span>
      <span className="shrink-0 text-[10px] uppercase">{part.mediaType}</span>
    </div>
  );
}

function FilePart({ part }: { part: FileUIPart }) {
  const label = part.filename ?? part.url;

  return (
    <a
      href={part.url}
      target="_blank"
      rel="noreferrer"
      className="inline-flex max-w-full items-center gap-1 rounded-md border border-border/70 bg-background/60 px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
    >
      <FileText className="h-3 w-3 shrink-0" />
      <span className="truncate">{label}</span>
    </a>
  );
}

function DataPart({ part }: { part: AnalystDataPart }) {
  return (
    <div className="rounded-md border border-border/70 bg-background/60 px-2 py-1 text-xs text-muted-foreground">
      <div className="flex items-center gap-1 font-medium">
        <CircleAlert className="h-3 w-3" />
        {part.type.replace(/^data-/, '') || 'Data'}
      </div>
      <StructuredValue value={part.data} />
    </div>
  );
}

export function StructuredValue({ label, value }: { label?: string; value: unknown }) {
  const rendered = formatStructuredValue(value);
  if (!rendered) return null;

  return (
    <div className="space-y-1">
      {label && <div className="font-medium text-muted-foreground">{label}</div>}
      <div className="max-h-56 overflow-auto whitespace-pre-wrap rounded border border-border/60 bg-muted/40 px-2 py-1 font-mono text-[11px] leading-relaxed">
        {rendered}
      </div>
    </div>
  );
}
