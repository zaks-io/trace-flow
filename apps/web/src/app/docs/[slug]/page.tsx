import Link from 'next/link';
import { notFound } from 'next/navigation';
import { FileCode2 } from 'lucide-react';
import { MarkdownDoc } from '@/components/docs/MarkdownDoc';
import { getDocBySlug, getDocMarkdownPath, readDocMarkdown } from '@/lib/docs';

type DocPageProps = {
  params: Promise<{ slug: string }>;
};

// Render at runtime via the ASSETS binding. OpenNext on Cloudflare has no
// incremental cache backend configured for this project, so SSG-prerendered
// HTML for dynamic segments is not served — pages must render on demand.
export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: DocPageProps) {
  const { slug } = await params;
  const doc = getDocBySlug(slug);

  if (!doc) {
    return {};
  }

  return {
    title: `${doc.title} | Trace Flow Docs`,
    description: doc.description,
  };
}

export default async function DocPage({ params }: DocPageProps) {
  const { slug } = await params;
  const doc = getDocBySlug(slug);

  if (!doc) {
    notFound();
  }

  const content = await readDocMarkdown(slug);

  if (!content) {
    notFound();
  }

  return (
    <div className="animate-fade-in">
      <div className="mb-8 flex items-center justify-between gap-4 rounded-xl border border-border/50 bg-card/40 px-4 py-3">
        <span className="rounded-full border border-primary/20 bg-primary/5 px-2.5 py-1 font-mono text-xs text-primary">
          {doc.tag}
        </span>
        <Link
          href={getDocMarkdownPath(slug)}
          className="inline-flex items-center gap-2 rounded-lg border border-border/50 bg-background px-3 py-1.5 font-mono text-xs text-muted-foreground transition-colors hover:border-primary/30 hover:bg-primary/5 hover:text-foreground"
        >
          <FileCode2 className="h-3.5 w-3.5 text-primary" />
          View Markdown
        </Link>
      </div>
      <MarkdownDoc content={content} />
    </div>
  );
}
