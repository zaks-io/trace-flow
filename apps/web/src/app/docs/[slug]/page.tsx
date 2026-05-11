import Link from 'next/link';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { FileCode2 } from 'lucide-react';
import { MarkdownDoc } from '@/components/docs/MarkdownDoc';
import { getDocBySlug, getDocMarkdownPath, readDocMarkdown } from '@/lib/docs';

type DocPageProps = {
  params: Promise<{ slug: string }>;
};

export const dynamic = 'force-dynamic';

const ALLOWED_DOC_HOSTS = new Set([
  'trace-flow.dev',
  'localhost:3000',
  'localhost:8788',
  '127.0.0.1:3000',
  '127.0.0.1:8788',
]);

function isAllowedDocHost(host: string): boolean {
  if (ALLOWED_DOC_HOSTS.has(host)) {
    return true;
  }
  // Cloudflare Workers preview and dev hosts (no account-specific subdomain in repo)
  return host.endsWith('.workers.dev');
}

function getDocsOrigin(requestHeaders: Headers): string | null {
  const configuredOrigin = process.env.APP_BASE_URL;
  if (configuredOrigin) {
    try {
      return new URL(configuredOrigin).origin;
    } catch {
      return null;
    }
  }

  const host = requestHeaders.get('host')?.toLowerCase();
  if (!host || !isAllowedDocHost(host)) {
    return null;
  }

  const protocol = host.startsWith('localhost') || host.startsWith('127.0.0.1') ? 'http' : 'https';
  return `${protocol}://${host}`;
}

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

  const origin = getDocsOrigin(await headers());
  if (!origin) {
    notFound();
  }

  const content = await readDocMarkdown(slug, origin);

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
