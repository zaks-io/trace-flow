'use client';

import type { ReactNode } from 'react';
import { Inbox, type LucideIcon } from 'lucide-react';
import { formatNumber } from '@/lib/format';

export function AgentSection({
  icon: Icon,
  title,
  subtitle,
  count,
  countLabel,
  children,
}: {
  icon: LucideIcon;
  title: string;
  subtitle: string;
  count: number;
  countLabel: string;
  children: ReactNode;
}) {
  return (
    <div className="rounded-xl bg-card/40 p-6">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
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
      {children}
    </div>
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
