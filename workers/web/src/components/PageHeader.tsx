'use client';

import { MoreHorizontal } from 'lucide-react';
import { Link } from 'react-router-dom';
import { usePageHeaderContext, type PageHeaderAction } from './PageHeaderContext';
import { SidebarTrigger } from '@/components/ui/sidebar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';

function ActionItem({ action }: { action: PageHeaderAction }) {
  const Icon = action.icon;
  const content = (
    <>
      {Icon && <Icon className="h-4 w-4" />}
      <span>{action.label}</span>
    </>
  );

  if (action.href) {
    return (
      <DropdownMenuItem asChild disabled={action.disabled}>
        <Link to={action.href}>{content}</Link>
      </DropdownMenuItem>
    );
  }

  return (
    <DropdownMenuItem
      onClick={action.onClick}
      disabled={action.disabled}
      className={cn(action.variant === 'destructive' && 'text-destructive focus:text-destructive')}
    >
      {content}
    </DropdownMenuItem>
  );
}

export function PageHeader() {
  const { title, actions } = usePageHeaderContext();

  return (
    <header className="flex h-14 shrink-0 items-center gap-4 border-b border-border bg-background/80 px-6 backdrop-blur-sm">
      <SidebarTrigger className="-ml-2" />

      <div className="flex h-6 items-center">
        <div className="h-4 w-px bg-border" />
      </div>

      <h1 className="text-sm font-medium tracking-tight text-foreground">
        {title || 'Trace Flow'}
      </h1>

      <div className="flex-1" />

      {actions.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              className={cn(
                'flex h-8 items-center gap-1.5 rounded-md px-2.5 text-sm font-medium',
                'text-muted-foreground transition-colors',
                'hover:bg-muted hover:text-foreground',
                'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
              )}
            >
              <span>Actions</span>
              <MoreHorizontal className="h-4 w-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-[160px]">
            {actions.map((action) => (
              <ActionItem key={action.id} action={action} />
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </header>
  );
}
