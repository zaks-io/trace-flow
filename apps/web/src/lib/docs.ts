import { promises as fs } from 'node:fs';
import path from 'node:path';

type DocDefinition = {
  slug: string;
  title: string;
  description: string;
  tag: string;
};

const DOCS: DocDefinition[] = [
  {
    slug: 'quick-start',
    title: 'Quick Start',
    description:
      'Get full LLM observability in minutes. See user events, API calls, and LLM requests in one unified trace.',
    tag: 'Start Here',
  },
  {
    slug: 'sdk-reference',
    title: 'SDK Reference',
    description:
      'Provider-specific examples for OpenAI, Anthropic, OpenRouter, and Groq with Vercel AI SDK and native SDKs.',
    tag: 'Reference',
  },
  {
    slug: 'opentelemetry',
    title: 'OpenTelemetry',
    description:
      'Advanced setup for custom spans, events, and attributes. Full control over your trace hierarchy.',
    tag: 'Advanced',
  },
  {
    slug: 'agents',
    title: 'AI Agents',
    description:
      'Bootstrap Claude Code, Cursor, or any AI assistant with Trace Flow knowledge. Copy-paste ready.',
    tag: 'Agents',
  },
  {
    slug: 'mcp',
    title: 'MCP Server',
    description:
      'Give AI agents direct access to your trace data. Query traces, analyze costs, and debug issues.',
    tag: 'MCP',
  },
];

export function getDocs(): DocDefinition[] {
  return DOCS;
}

export function getDocBySlug(slug: string): DocDefinition | undefined {
  return DOCS.find((doc) => doc.slug === slug);
}

export function getDocSlugs(): string[] {
  return DOCS.map((doc) => doc.slug);
}

export function getDocPath(slug: string): string {
  return `/docs/${slug}`;
}

export function getDocMarkdownPath(slug: string): string {
  return `/docs/${slug}.md`;
}

function getDocsMarkdownFilePath(slug: string): string {
  return path.resolve(process.cwd(), 'public', 'docs', `${slug}.md`);
}

export async function readDocMarkdown(slug: string): Promise<string | null> {
  const docsDir = path.resolve(process.cwd(), 'public', 'docs');
  const filePath = getDocsMarkdownFilePath(slug);
  const relativePath = path.relative(docsDir, filePath);

  // Guard against path traversal even if callers pass unvalidated slugs.
  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    return null;
  }

  try {
    return await fs.readFile(filePath, 'utf8');
  } catch {
    return null;
  }
}
