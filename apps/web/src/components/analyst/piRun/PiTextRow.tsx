import { MessageSquareText } from 'lucide-react';
import { AnalystMarkdown } from '../analystMarkdown';
import { PiRunRowShell } from './PiRunRowShell';

export function PiTextRow({ text }: { text: string }) {
  const trimmed = text.trim();
  if (!trimmed) return null;

  return (
    <PiRunRowShell icon={<MessageSquareText className="h-3.5 w-3.5 text-chart-1" />}>
      <AnalystMarkdown>{trimmed}</AnalystMarkdown>
    </PiRunRowShell>
  );
}
