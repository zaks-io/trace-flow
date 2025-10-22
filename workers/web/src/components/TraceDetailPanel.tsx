'use client';

import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { TraceDetailContent } from './TraceDetailContent';

interface TraceDetailPanelProps {
  traceId: string;
  isOpen: boolean;
  onClose: () => void;
}

export function TraceDetailPanel({ traceId, isOpen, onClose }: TraceDetailPanelProps) {
  return (
    <Sheet open={isOpen} onOpenChange={onClose}>
      <SheetContent side="right" className="w-full sm:max-w-3xl overflow-y-auto">
        <SheetHeader>
          <SheetTitle>Trace Details</SheetTitle>
        </SheetHeader>

        <div className="px-4 space-y-6">
          <TraceDetailContent traceId={traceId} enabled={isOpen} />
        </div>
      </SheetContent>
    </Sheet>
  );
}
