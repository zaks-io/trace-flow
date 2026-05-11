import { CopyCodeButton } from '@/components/docs/CopyCodeButton';

interface CodeBlockProps {
  code: string;
  lang?: string;
}

const LANGUAGE_ALIASES: Record<string, string> = {
  sh: 'bash',
  shell: 'bash',
  ts: 'typescript',
  js: 'javascript',
  yml: 'yaml',
};

export function CodeBlock({ code, lang = 'typescript' }: CodeBlockProps) {
  const resolvedLang = LANGUAGE_ALIASES[lang] ?? lang;

  return (
    <div className="code-block group relative">
      <div className="absolute -inset-px rounded-xl bg-gradient-to-b from-primary/20 to-transparent opacity-0 transition-opacity duration-300 group-hover:opacity-100" />
      <div className="relative overflow-hidden rounded-xl border border-border/50 bg-[oklch(0.1_0.01_260)]">
        <div className="flex items-center justify-between border-b border-border/30 px-4 py-2">
          <div className="flex items-center gap-2">
            <div className="flex gap-1.5">
              <div className="h-3 w-3 rounded-full bg-[oklch(0.6_0.2_25)]" />
              <div className="h-3 w-3 rounded-full bg-[oklch(0.75_0.15_85)]" />
              <div className="h-3 w-3 rounded-full bg-[oklch(0.7_0.18_145)]" />
            </div>
            <span className="ml-2 font-mono text-xs text-muted-foreground">{resolvedLang}</span>
          </div>
          <CopyCodeButton code={code} />
        </div>
        <pre className="overflow-x-auto p-4 text-sm leading-relaxed text-foreground/90">
          <code className={`language-${resolvedLang} font-mono`}>{code}</code>
        </pre>
      </div>
    </div>
  );
}
