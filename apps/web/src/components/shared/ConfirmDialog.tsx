'use client';

import { type ReactNode, useState } from 'react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { buttonVariants } from '@/components/ui/button';

interface ConfirmDialogProps<T> {
  target: T | null;
  onClose: () => void;
  onConfirm: (target: T) => void;
  title: (target: T) => string;
  description: (target: T) => ReactNode;
  confirmLabel: string;
}

export function ConfirmDialog<T>({
  target,
  onClose,
  onConfirm,
  title,
  description,
  confirmLabel,
}: ConfirmDialogProps<T>) {
  // Keep rendering the last target while the close animation plays.
  const [shown, setShown] = useState(target);
  if (target !== null && target !== shown) setShown(target);

  return (
    <AlertDialog open={target !== null} onOpenChange={(open) => !open && onClose()}>
      {shown !== null && (
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{title(shown)}</AlertDialogTitle>
            <AlertDialogDescription>{description(shown)}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className={buttonVariants({ variant: 'destructive' })}
              onClick={() => onConfirm(shown)}
            >
              {confirmLabel}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      )}
    </AlertDialog>
  );
}
