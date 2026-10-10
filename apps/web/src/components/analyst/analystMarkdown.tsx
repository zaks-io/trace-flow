'use client';

import { Streamdown } from 'streamdown';
import { cn } from '@/lib/utils';
import './analystMarkdown.css';

/**
 * Streamdown renders GFM and tolerates partial markdown as the Analyst streams its answer.
 */
export function AnalystMarkdown({ children, className }: { children: string; className?: string }) {
  return <Streamdown className={cn('analyst-markdown', className)}>{children}</Streamdown>;
}
