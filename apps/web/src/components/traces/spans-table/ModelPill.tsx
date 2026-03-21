'use client';

import { cn } from '@/lib/utils';
import { formatModelDisplay } from '@/lib/format';

const PROVIDER_STYLES: Record<string, string> = {
  gpt: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/25',
  openai: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/25',
  claude: 'bg-orange-500/15 text-orange-300 border-orange-500/25',
  anthropic: 'bg-orange-500/15 text-orange-300 border-orange-500/25',
  gemini: 'bg-blue-500/15 text-blue-400 border-blue-500/25',
  google: 'bg-blue-500/15 text-blue-400 border-blue-500/25',
  llama: 'bg-purple-500/15 text-purple-400 border-purple-500/25',
  groq: 'bg-purple-500/15 text-purple-400 border-purple-500/25',
  mistral: 'bg-amber-500/15 text-amber-400 border-amber-500/25',
  deepseek: 'bg-cyan-500/15 text-cyan-400 border-cyan-500/25',
  openrouter: 'bg-rose-500/15 text-rose-400 border-rose-500/25',
};

const DEFAULT_STYLE = 'bg-muted/50 text-muted-foreground border-border/50';

function getProviderStyle(model: string, provider?: string): string {
  const candidates = provider ? `${provider} ${model}` : model;
  const lower = candidates.toLowerCase();
  for (const [prefix, style] of Object.entries(PROVIDER_STYLES)) {
    if (lower.includes(prefix)) return style;
  }
  return DEFAULT_STYLE;
}

export function ModelPill({ model, provider }: { model: string; provider?: string }) {
  return (
    <code
      className={cn(
        'inline-flex items-center rounded-md border px-1.5 py-0.5 font-mono text-[11px] leading-tight',
        getProviderStyle(model, provider),
      )}
    >
      {formatModelDisplay(model, provider)}
    </code>
  );
}
