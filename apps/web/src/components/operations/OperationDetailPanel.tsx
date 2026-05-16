'use client';

import { useRef } from 'react';
import { Users } from 'lucide-react';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';
import { type OperationLeaderboardRow, type OperationUserRow } from '@/components/usage/types';
import { SummaryCards } from './SummaryCards';
import { UsersTable } from './UsersTable';

interface OperationDetailPanelProps {
  operation: OperationLeaderboardRow | null;
  operationName: string;
  users: OperationUserRow[];
  isUsersLoading: boolean;
  isOpen: boolean;
  onClose: () => void;
}

export function OperationDetailPanel({
  operation,
  operationName,
  users,
  isUsersLoading,
  isOpen,
  onClose,
}: OperationDetailPanelProps) {
  const displayNameRef = useRef(operationName);
  const displayOperationRef = useRef(operation);
  if (operationName) displayNameRef.current = operationName;
  if (operation) displayOperationRef.current = operation;

  const handleOpenChange = (open: boolean) => {
    if (!open) onClose();
  };

  const displayName = displayNameRef.current;
  const displayOperation = displayOperationRef.current;

  return (
    <Sheet open={isOpen} onOpenChange={handleOpenChange}>
      <SheetContent
        side="right"
        className="flex w-[640px] flex-col overflow-hidden p-0 sm:max-w-[640px]"
      >
        <SheetHeader className="flex-shrink-0 space-y-1 border-b border-border/50 px-6 py-4">
          <SheetTitle className="text-base font-medium text-foreground">User breakdown</SheetTitle>
          <SheetDescription className="text-xs text-muted-foreground">
            Per-user metrics for{' '}
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px] text-foreground">
              {displayName}
            </code>
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto">
          <div className="space-y-6 p-6">
            {displayOperation && <SummaryCards operation={displayOperation} />}

            <div>
              <div className="mb-3 flex items-center gap-2">
                <Users className="h-4 w-4 text-muted-foreground" />
                <h3 className="text-sm font-medium text-foreground">Users</h3>
              </div>

              {isUsersLoading ? (
                <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
                  <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
                  Loading user breakdown...
                </div>
              ) : (
                <UsersTable data={users} />
              )}
            </div>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
