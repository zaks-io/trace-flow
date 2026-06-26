'use client';

import { Streamdown } from 'streamdown';
import { cn } from '@/lib/utils';
import './analystMarkdown.css';

/**
 * Markdown renderer for everything the agent emits — assistant replies, the Pi
 * coding agent's composed answer, and Pi text rows. Streamdown renders GFM
 * (tables, headings, lists, code, bold) and tolerates partial markdown mid-stream,
 * so the answer reads as formatted prose instead of a raw `**bold**`/`| table |` blob.
 */
export function AnalystMarkdown({ children, className }: { children: string; className?: string }) {
  return <Streamdown className={cn('analyst-markdown', className)}>{children}</Streamdown>;
}
