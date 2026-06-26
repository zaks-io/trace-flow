'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useAction, useQuery } from 'convex/react';
import { useUIMessages } from '@convex-dev/agent/react';
import { api } from '@convex/_generated/api';
import type { Id } from '@convex/_generated/dataModel';
import { usePathname } from 'next/navigation';
import {
  ChevronDown,
  Loader2,
  PanelRightClose,
  PanelRightOpen,
  Plus,
  Send,
  Sparkles,
  Square,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { useAnalyst } from './AnalystContext';
import { AnalystMessageList, type AnalystMessage } from './AnalystMessageList';
import { AnalystRunStatusBar, getAnalystRunState, type QueuedAnalystRun } from './AnalystRunStatus';
import type { SandboxRun } from './AnalystSandboxRuns';
import { isActive } from './piRunEvents';
import { useResizableSidebar } from './useResizableSidebar';
import { buildMessagePageContextReferences, type AnalystPageContextReference } from './pageContext';

type AnalystThread = {
  _id: Id<'analystThreads'>;
  title: string;
  updatedAt: number;
};

const EXAMPLE_PROMPTS = [
  'What did I spend on agents in the last 7 days?',
  'Which repos drove the most token usage this week?',
  'Show me daily active usage and any notable changes.',
];

export function AnalystSidebar() {
  const {
    open,
    setOpen,
    currentThreadId,
    selectThread,
    selectedReferences,
    removeReference,
    clearReferences,
    selectionMode,
    setSelectionMode,
  } = useAnalyst();
  const threads = useQuery(api.analyst.listThreads) as AnalystThread[] | undefined;
  const sendMessage = useAction(api.analyst.sendMessage);
  const stopRun = useAction(api.analyst.stopRun);
  const pathname = usePathname();
  const [prompt, setPrompt] = useState('');
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [queuedRun, setQueuedRun] = useState<QueuedAnalystRun | null>(null);
  const [error, setError] = useState<string | null>(null);
  const messageScrollRef = useRef<HTMLDivElement | null>(null);
  const { width, resizing, handleProps } = useResizableSidebar();

  const currentThread = useMemo(
    () => threads?.find((thread) => thread._id === currentThreadId) ?? null,
    [threads, currentThreadId],
  );

  const messages = useUIMessages(
    api.analyst.listMessages,
    currentThreadId ? { threadId: currentThreadId } : 'skip',
    { initialNumItems: 30, stream: true },
  );
  const sandboxRuns = useQuery(
    api.analyst.listSandboxRuns,
    currentThreadId ? { threadId: currentThreadId } : 'skip',
  ) as SandboxRun[] | undefined;
  const activeSandboxRuns = useMemo(
    () => (sandboxRuns ?? []).filter((run) => isActive(run.status)),
    [sandboxRuns],
  );
  const messageResults = useMemo(
    () => (messages.results as AnalystMessage[] | undefined) ?? [],
    [messages.results],
  );
  const latestMessage = messageResults.at(-1);
  const latestRun = sandboxRuns?.[0];
  const scrollKey = [
    currentThreadId,
    latestMessage?.id,
    latestMessage?.order,
    latestMessage?.stepOrder,
    latestMessage?.status,
    latestMessage?.text.length ?? 0,
    latestMessage?.parts.length ?? 0,
    latestRun?._id,
    latestRun?.status,
    latestRun?.lastEventAt,
    latestRun?.nextSeq,
  ].join(':');
  const runState = useMemo(
    () =>
      getAnalystRunState({
        sending,
        currentThreadId,
        queuedRun,
        messages: messageResults,
        sandboxRuns: sandboxRuns ?? [],
      }),
    [sending, currentThreadId, queuedRun, messageResults, sandboxRuns],
  );
  const analystBusy = runState.busy;
  const canSelectPageContext = pathname.startsWith('/app/agents');
  const canStopAnalyst =
    Boolean(currentThreadId) &&
    (runState.phase === 'queued' || runState.phase === 'running' || activeSandboxRuns.length > 0);
  const messagePageContextReferences = useMemo(
    () => buildMessagePageContextReferences(pathname, selectedReferences),
    [pathname, selectedReferences],
  );

  useEffect(() => {
    if (!canSelectPageContext && selectionMode) setSelectionMode(false);
  }, [canSelectPageContext, selectionMode, setSelectionMode]);

  useEffect(() => {
    if (queuedRun && queuedRun.threadId === currentThreadId && runState.phase !== 'queued') {
      setQueuedRun(null);
    }
  }, [currentThreadId, queuedRun, runState.phase]);

  useEffect(() => {
    const element = messageScrollRef.current;
    if (!element) return;
    // Only stick to the bottom when the user is already there. If they've scrolled
    // up to review history, don't yank them back down as new content streams in.
    const distanceFromBottom = element.scrollHeight - element.scrollTop - element.clientHeight;
    if (distanceFromBottom > 120) return;
    window.requestAnimationFrame(() => {
      element.scrollTop = element.scrollHeight;
    });
  }, [scrollKey]);

  function handleSelectThread(threadId: Id<'analystThreads'> | null) {
    setQueuedRun(null);
    selectThread(threadId);
  }

  async function handleSend(text?: string) {
    const nextPrompt = (text ?? prompt).trim();
    if (!nextPrompt || analystBusy) return;

    setSending(true);
    setError(null);
    const afterOrder = Math.max(0, ...messageResults.map((message) => message.order));
    try {
      const result = await sendMessage({
        threadId: currentThreadId ?? undefined,
        prompt: nextPrompt,
        pageContextReferences: messagePageContextReferences,
      });
      setQueuedRun({ threadId: result.threadId, afterOrder });
      selectThread(result.threadId);
      setPrompt('');
      clearReferences();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send message');
    } finally {
      setSending(false);
    }
  }

  async function handleStop() {
    if (!currentThreadId || stopping) return;

    setStopping(true);
    setError(null);
    try {
      await stopRun({ threadId: currentThreadId });
      setQueuedRun(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to stop Analyst run');
    } finally {
      setStopping(false);
    }
  }

  if (!open) {
    return (
      <Button
        type="button"
        size="icon"
        className="fixed bottom-6 right-6 z-40 shadow-lg"
        onClick={() => setOpen(true)}
        aria-label="Open Analyst"
      >
        <PanelRightOpen className="h-4 w-4" />
      </Button>
    );
  }

  return (
    <aside
      style={{ width }}
      className={cn(
        'relative flex h-full shrink-0 flex-col border-l border-border bg-background shadow-xl',
        !resizing && 'transition-[width] duration-150 motion-reduce:transition-none',
      )}
    >
      <div
        {...handleProps}
        className={cn(
          'group absolute -left-1 top-0 z-20 h-full w-2 cursor-col-resize touch-none',
          'focus-visible:outline-none',
        )}
      >
        <span
          className={cn(
            'absolute left-1 top-0 h-full w-px bg-border transition-colors',
            'group-hover:bg-primary/60 group-focus-visible:bg-primary',
            resizing && 'bg-primary',
          )}
          aria-hidden
        />
      </div>

      <header className="flex min-h-14 items-center gap-2 border-b border-border bg-card/40 px-3">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Sparkles className="h-4 w-4" />
        </span>
        <ThreadDropdown
          threads={threads ?? []}
          currentThread={currentThread}
          onSelect={handleSelectThread}
          onNew={() => handleSelectThread(null)}
        />
        {canSelectPageContext && (
          <Button
            type="button"
            variant={selectionMode ? 'secondary' : 'ghost'}
            size="icon-sm"
            onClick={() => setSelectionMode(!selectionMode)}
            aria-label="Toggle page context selection"
            aria-pressed={selectionMode}
          >
            <Plus className="h-4 w-4" />
          </Button>
        )}
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={() => setOpen(false)}
          aria-label="Close Analyst"
        >
          <PanelRightClose className="h-4 w-4" />
        </Button>
      </header>

      <AnalystRunStatusBar
        state={runState}
        onStop={canStopAnalyst ? () => void handleStop() : undefined}
        stopping={stopping}
      />

      <div ref={messageScrollRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {currentThreadId ? (
          <AnalystMessageList
            messages={messageResults}
            loadMore={() => messages.loadMore(20)}
            canLoadMore={messages.status === 'CanLoadMore'}
            busy={analystBusy}
          />
        ) : (
          <EmptyState onPick={(text) => void handleSend(text)} disabled={analystBusy} />
        )}
      </div>

      <footer className="border-t border-border bg-card/40 p-3">
        {selectedReferences.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-2">
            {selectedReferences.map((reference) => (
              <ContextChip
                key={`${reference.surface}:${reference.objectId}`}
                reference={reference}
                onRemove={() => removeReference(reference)}
              />
            ))}
          </div>
        )}
        {error && <p className="mb-2 text-xs text-destructive">{error}</p>}
        <div className="flex items-end gap-2 rounded-xl border border-input bg-background p-1.5 transition-colors focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/30">
          <textarea
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                if (canStopAnalyst) return;
                void handleSend();
              }
            }}
            rows={3}
            placeholder="Ask about costs, usage, or selected context"
            className="min-h-16 flex-1 resize-none bg-transparent px-2 py-1 text-sm outline-none placeholder:text-muted-foreground"
          />
          <Button
            type="button"
            size="icon"
            variant={canStopAnalyst ? 'outline' : 'default'}
            disabled={canStopAnalyst ? stopping : analystBusy || !prompt.trim()}
            onClick={canStopAnalyst ? () => void handleStop() : () => void handleSend()}
            aria-label={canStopAnalyst ? 'Stop Analyst run' : 'Send message'}
          >
            {canStopAnalyst ? (
              stopping ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Square className="h-4 w-4" />
              )
            ) : analystBusy ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Send className="h-4 w-4" />
            )}
          </Button>
        </div>
      </footer>
    </aside>
  );
}

function EmptyState({ onPick, disabled }: { onPick: (prompt: string) => void; disabled: boolean }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-5 text-center">
      <div className="space-y-1.5">
        <span className="mx-auto flex h-11 w-11 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <Sparkles className="h-5 w-5" />
        </span>
        <h2 className="text-sm font-semibold text-foreground">Ask the Analyst</h2>
        <p className="mx-auto max-w-[18rem] text-xs leading-relaxed text-muted-foreground">
          It reads your usage and cost data, then digs into the details to answer.
        </p>
      </div>
      <div className="w-full max-w-[20rem] space-y-2">
        {EXAMPLE_PROMPTS.map((example) => (
          <button
            key={example}
            type="button"
            disabled={disabled}
            onClick={() => onPick(example)}
            className="w-full rounded-xl border border-border/60 bg-card/40 px-3 py-2 text-left text-xs text-foreground/90 transition-colors hover:border-primary/50 hover:bg-card disabled:cursor-not-allowed disabled:opacity-50"
          >
            {example}
          </button>
        ))}
      </div>
    </div>
  );
}

function ThreadDropdown({
  threads,
  currentThread,
  onSelect,
  onNew,
}: {
  threads: AnalystThread[];
  currentThread: AnalystThread | null;
  onSelect: (threadId: Id<'analystThreads'>) => void;
  onNew: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="ghost" className="min-w-0 flex-1 justify-between">
          <span className="truncate font-medium">{currentThread?.title ?? 'New conversation'}</span>
          <ChevronDown className="h-4 w-4 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-80">
        <DropdownMenuItem onClick={onNew}>
          <Plus className="h-4 w-4" />
          New conversation
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>History</DropdownMenuLabel>
        {threads.length === 0 ? (
          <DropdownMenuItem disabled>No conversations yet</DropdownMenuItem>
        ) : (
          threads.map((thread) => (
            <DropdownMenuItem key={thread._id} onClick={() => onSelect(thread._id)}>
              <span className="min-w-0 flex-1 truncate">{thread.title}</span>
              <span className="text-[11px] text-muted-foreground">
                {new Date(thread.updatedAt).toLocaleDateString()}
              </span>
            </DropdownMenuItem>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ContextChip({
  reference,
  onRemove,
}: {
  reference: AnalystPageContextReference;
  onRemove: () => void;
}) {
  return (
    <span className="inline-flex max-w-full items-center gap-1 rounded-full border border-border bg-muted px-2 py-1 text-xs text-muted-foreground">
      <span className="truncate">{reference.label}</span>
      <button type="button" onClick={onRemove} aria-label={`Remove ${reference.label}`}>
        <X className="h-3 w-3" />
      </button>
    </span>
  );
}
