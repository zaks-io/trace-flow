import { DOCS_CONTENT } from '@/generated/docs-content';

type DocDefinition = {
  slug: string;
  title: string;
  description: string;
  tag: string;
  filePath?: string;
};

const DOCS: DocDefinition[] = [
  {
    slug: 'quick-start',
    title: 'Quick Start',
    description:
      'Start here: add TRACE_FLOW_API_KEY, point your provider at the gateway, and send the first traced request.',
    tag: 'Start Here',
  },
  {
    slug: 'sdk-reference',
    title: 'SDK Reference',
    description:
      'Provider-specific examples for OpenAI, Anthropic, Google, OpenRouter, and Groq with Vercel AI SDK and native SDKs.',
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
      'Hand your coding agent a single machine-readable guide for env vars, gateway wiring, and first-run verification.',
    tag: 'Agents',
    filePath: 'agents.md',
  },
  {
    slug: 'collector',
    title: 'Coding-Agent Collector',
    description:
      'Install the desktop collector, understand supported sources, and review its local parsing and privacy boundaries.',
    tag: 'Collector',
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

export function getDocPath(slug: string): string {
  return `/docs/${slug}`;
}

export function getDocMarkdownPath(slug: string): string {
  const doc = getDocBySlug(slug);
  if (doc?.filePath) {
    return `/${doc.filePath}`;
  }
  return `/docs/${slug}.md`;
}

/**
 * Returns markdown content bundled at build time. The actual file reads happen
 * in scripts/generate-docs-content.ts (Node), so nothing here depends on a
 * runtime filesystem, fetch, or ASSETS binding.
 */
export function readDocMarkdown(slug: string): string | null {
  return DOCS_CONTENT[slug] ?? null;
}
