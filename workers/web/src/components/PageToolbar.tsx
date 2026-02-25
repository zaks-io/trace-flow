import type { ReactNode } from 'react';
import { SidebarTrigger } from '@/components/ui/sidebar';
import { cn } from '@/lib/utils';

export function PageToolbar({ children, className }: { children?: ReactNode; className?: string }) {
  return (
    <div className={cn('mb-4 flex items-center gap-3', className)}>
      <SidebarTrigger className="-ml-1" />
      {children}
    </div>
  );
}
