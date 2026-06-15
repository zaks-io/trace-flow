'use client';

import type { ReactNode } from 'react';
import { ChevronDown, Inbox, type LucideIcon } from 'lucide-react';
import { formatNumber } from '@/lib/format';
import { cn } from '@/lib/utils';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { useSectionOpen } from './useSectionOpen';

function SectionHeader({
  icon: Icon,
  title,
  subtitle,
  count,
  countLabel,
  chevron,
}: {
  icon: LucideIcon;
  title: string;
  subtitle: string;
  count: number;
  countLabel: string;
  chevron?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="flex items-center gap-2">
        {chevron && (
          <ChevronDown className="h-4 w-4 text-muted-foreground transition-transform group-data-[state=closed]/section:-rotate-90" />
        )}
        <Icon className="h-4 w-4 text-muted-foreground" />
        <div>
          <h2 className="text-base font-medium text-foreground">{title}</h2>
          <p className="text-xs text-muted-foreground">{subtitle}</p>
        </div>
      </div>
      <span className="rounded-md bg-muted/60 px-2 py-1 font-mono text-xs tabular-nums text-muted-foreground">
        {formatNumber(count)} {countLabel}
      </span>
    </div>
  );
}

export function AgentSection({
  icon,
  title,
  subtitle,
  count,
  countLabel,
  collapsible = false,
  defaultOpen = true,
  storageKey,
  children,
}: {
  icon: LucideIcon;
  title: string;
  subtitle: string;
  count: number;
  countLabel: string;
  /** When true the header toggles the body open/closed. */
  collapsible?: boolean;
  /** Initial state when no persisted value exists (collapsible only). */
  defaultOpen?: boolean;
  /** Persist open/closed under this key (collapsible only). */
  storageKey?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useSectionOpen(storageKey, defaultOpen);

  if (!collapsible) {
    return (
      <div className="rounded-xl bg-card/40 p-6">
        <div className="mb-4">
          <SectionHeader
            icon={icon}
            title={title}
            subtitle={subtitle}
            count={count}
            countLabel={countLabel}
          />
        </div>
        {children}
      </div>
    );
  }

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="group/section rounded-xl bg-card/40 p-6"
    >
      <CollapsibleTrigger className="w-full text-left">
        <SectionHeader
          icon={icon}
          title={title}
          subtitle={subtitle}
          count={count}
          countLabel={countLabel}
          chevron
        />
      </CollapsibleTrigger>
      <CollapsibleContent className={cn('mt-4')}>{children}</CollapsibleContent>
    </Collapsible>
  );
}

export function AgentTableEmpty({ message }: { message: string }) {
  return (
    <div className="flex flex-col items-center gap-2 py-12 text-center">
      <Inbox className="h-8 w-8 text-muted-foreground/40" />
      <p className="text-sm text-muted-foreground">{message}</p>
    </div>
  );
}
