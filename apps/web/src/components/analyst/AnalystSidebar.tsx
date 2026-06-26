'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useAction, useQuery } from 'convex/react';
import { useUIMessages } from '@convex-dev/agent/react';
import { api } from '@convex/_generated/api';
import type { Id } from '@convex/_generated/dataModel';
import { usePathname } from 'next/navigation';
import {
  Bot,
  ChevronDown,
  Loader2,
  MessageSquare,
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
import { useAnalyst } from './AnalystContext';
import { AnalystMessageList, type AnalystMessage } from './AnalystMessageList';
import { AnalystRunStatusBar, getAnalystRunState, type QueuedAnalystRun } from './AnalystRunStatus';
import type { SandboxRun } from './AnalystSandboxRuns';
import { buildMessagePageContextReferences, type AnalystPageContextReference } from './pageContext';

type AnalystThread = {
  _id: Id<'analystThreads'>;
  title: string;
  updatedAt: number;
};

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
    () => (sandboxRuns ?? []).filter((run) => isActiveSandboxRunStatus(run.status)),
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
    window.requestAnimationFrame(() => {
      element.scrollTop = element.scrollHeight;
    });
  }, [scrollKey]);

  function handleSelectThread(threadId: Id<'analystThreads'> | null) {
    setQueuedRun(null);
    selectThread(threadId);
  }

  async function handleSend() {
    const nextPrompt = prompt.trim();
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
    <aside className="flex h-full w-[420px] shrink-0 flex-col border-l border-border bg-background shadow-xl">
      <header className="flex min-h-14 items-center gap-2 border-b border-border px-3">
        <Bot className="h-4 w-4 text-muted-foreground" />
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
          >
            <Sparkles className="h-4 w-4" />
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
          <div className="flex h-full items-center justify-center text-center text-sm text-muted-foreground">
            <div>
              <MessageSquare className="mx-auto mb-3 h-8 w-8 opacity-60" />
              <p>Ask the Analyst a question.</p>
            </div>
          </div>
        )}
      </div>

      <footer className="border-t border-border p-3">
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
        <div className="flex items-end gap-2">
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
            placeholder="Ask about traces, costs, usage, or selected context"
            className="min-h-20 flex-1 resize-none rounded-md border border-input bg-transparent px-3 py-2 text-sm outline-none transition-[color,box-shadow] placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
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
          <span className="truncate">{currentThread?.title ?? 'New conversation'}</span>
          <ChevronDown className="h-4 w-4" />
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

function isActiveSandboxRunStatus(status: SandboxRun['status']) {
  return status === 'queued' || status === 'starting' || status === 'running';
}
