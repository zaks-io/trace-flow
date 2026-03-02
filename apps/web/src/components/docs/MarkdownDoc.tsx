import React from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeSlug from 'rehype-slug';
import remarkGfm from 'remark-gfm';
import { CodeBlock } from '@/components/docs/CodeBlock';

type MarkdownDocProps = {
  content: string;
};

export function MarkdownDoc({ content }: MarkdownDocProps) {
  return (
    <div className="space-y-6">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeSlug]}
        components={{
          h1: ({ children }) => (
            <h1 className="bg-gradient-to-r from-foreground to-foreground/70 bg-clip-text text-4xl font-bold tracking-tight text-transparent sm:text-5xl">
              {children}
            </h1>
          ),
          h2: ({ children, ...props }) => (
            <h2
              className="mt-12 scroll-mt-20 text-2xl font-semibold tracking-tight text-foreground"
              {...props}
            >
              {children}
            </h2>
          ),
          h3: ({ children, ...props }) => (
            <h3 className="mt-10 scroll-mt-20 text-xl font-semibold text-foreground" {...props}>
              {children}
            </h3>
          ),
          p: ({ children }) => <p className="leading-7 text-foreground/90">{children}</p>,
          a: ({ href, children }) => (
            <a
              href={href}
              className="text-primary underline decoration-primary/40 underline-offset-4 hover:decoration-primary"
            >
              {children}
            </a>
          ),
          ul: ({ children }) => (
            <ul className="list-disc space-y-2 pl-6 text-foreground/90">{children}</ul>
          ),
          ol: ({ children }) => (
            <ol className="list-decimal space-y-2 pl-6 text-foreground/90">{children}</ol>
          ),
          li: ({ children }) => <li>{children}</li>,
          blockquote: ({ children }) => (
            <blockquote className="rounded-lg border border-primary/20 bg-primary/5 px-4 py-3 text-foreground/90">
              {children}
            </blockquote>
          ),
          table: ({ children }) => (
            <div className="overflow-x-auto rounded-lg border border-border/50">
              <table className="w-full text-sm">{children}</table>
            </div>
          ),
          thead: ({ children }) => <thead className="bg-card/40 text-left">{children}</thead>,
          tbody: ({ children }) => <tbody className="divide-y divide-border/40">{children}</tbody>,
          th: ({ children }) => (
            <th className="px-4 py-3 font-medium text-muted-foreground">{children}</th>
          ),
          td: ({ children }) => (
            <td className="px-4 py-3 align-top text-foreground/90">{children}</td>
          ),
          hr: () => <hr className="my-10 border-border/60" />,
          code: ({ children, ...props }) => {
            return (
              <code
                className="rounded bg-primary/10 px-1.5 py-0.5 font-mono text-sm text-primary"
                {...props}
              >
                {children}
              </code>
            );
          },
          pre: ({ children }) => {
            const child = Array.isArray(children) ? children[0] : children;

            if (!React.isValidElement(child)) {
              return <pre className="overflow-x-auto">{children}</pre>;
            }

            const props = child.props as { className?: string; children?: React.ReactNode };
            const className = props.className ?? '';
            const langMatch = /language-([\w-]+)/.exec(className);
            const lang = langMatch?.[1] ?? 'text';
            const code = String(props.children ?? '').replace(/\n$/, '');

            if (!code) {
              return <pre className="overflow-x-auto">{children}</pre>;
            }

            return <CodeBlock code={code} lang={lang} />;
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
