'use client';

import { useState } from 'react';
import { useMutation } from 'convex/react';
import { api } from '@convex/_generated/api';
import { ConvexError } from 'convex/values';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { FEEDBACK_MAX_MESSAGE_LENGTH } from '@trace-flow/types';

export function FeedbackDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const submitFeedback = useMutation(api.feedback.submit);
  const [message, setMessage] = useState('');
  const [status, setStatus] = useState<'idle' | 'submitting' | 'error'>('idle');
  const [error, setError] = useState('');

  const trimmedLength = message.trim().length;
  const isOverLimit = trimmedLength > FEEDBACK_MAX_MESSAGE_LENGTH;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!message.trim() || isOverLimit || status === 'submitting') return;

    setStatus('submitting');
    setError('');

    try {
      await submitFeedback({ message });
      setMessage('');
      setStatus('idle');
      onOpenChange(false);
    } catch (err) {
      setStatus('error');
      if (err instanceof ConvexError) {
        const data = err.data;
        if (typeof data === 'string') {
          setError(data);
        } else if (
          data &&
          typeof data === 'object' &&
          'kind' in data &&
          data.kind === 'RateLimited'
        ) {
          setError('Too many submissions. Please try again later.');
        } else {
          setError('Something went wrong. Please try again.');
        }
      } else if (err instanceof Error) {
        setError(err.message);
      } else {
        setError('Something went wrong. Please try again.');
      }
    }
  }

  function handleOpenChange(next: boolean) {
    if (!next) {
      setMessage('');
      setStatus('idle');
      setError('');
    }
    onOpenChange(next);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-md p-6">
        <DialogHeader>
          <DialogTitle>Send Feedback</DialogTitle>
          <DialogDescription>
            Let us know how we can improve. Bug reports, feature requests, or general thoughts.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <textarea
              value={message}
              onChange={(e) => {
                setMessage(e.target.value);
                if (error) setError('');
              }}
              placeholder="What's on your mind?"
              rows={5}
              className="w-full resize-none rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:ring-offset-background disabled:opacity-50"
              disabled={status === 'submitting'}
              autoFocus
            />
            <div className="flex items-center justify-between text-xs">
              {error && <p className="text-destructive">{error}</p>}
              {!error && <span />}
              <span
                className={`tabular-nums ${isOverLimit ? 'text-destructive' : 'text-muted-foreground'}`}
              >
                {trimmedLength.toLocaleString()} / {FEEDBACK_MAX_MESSAGE_LENGTH.toLocaleString()}
              </span>
            </div>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => handleOpenChange(false)}
              disabled={status === 'submitting'}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={!message.trim() || isOverLimit || status === 'submitting'}
            >
              {status === 'submitting' ? 'Sending...' : 'Send Feedback'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
