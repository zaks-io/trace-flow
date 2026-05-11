import { getCloudflareContext } from '@opennextjs/cloudflare';

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

function getDocRelativePath(slug: string): string | null {
  const doc = getDocBySlug(slug);
  if (!doc) return null;
  return doc.filePath ?? `docs/${slug}.md`;
}

/**
 * Reads markdown from the Cloudflare ASSETS binding at runtime. Falls back to
 * `fs.readFile` when no Worker context is available (next dev outside the
 * OpenNext Miniflare runtime, or build-time SSG). The ASSETS binding serves
 * files directly from `.open-next/assets/` without going through middleware or
 * a public self-fetch, so there's no APP_BASE_URL, host allowlist, or
 * subrequest loop in play.
 */
export async function readDocMarkdown(slug: string): Promise<string | null> {
  const relativePath = getDocRelativePath(slug);
  if (!relativePath) return null;

  try {
    const { env } = await getCloudflareContext({ async: true });
    const assets = (env as { ASSETS?: { fetch(request: Request): Promise<Response> } }).ASSETS;
    if (assets) {
      const response = await assets.fetch(new Request(`http://assets/${relativePath}`));
      if (!response.ok) {
        console.warn(`docs: ASSETS.fetch returned ${response.status} for ${relativePath}`);
        return null;
      }
      return await response.text();
    }
  } catch {
    // No CF context (build time / pure Node). Fall through to fs read.
  }

  const { promises: fs } = await import('node:fs');
  const path = await import('node:path');
  const filePath = path.resolve(process.cwd(), 'public', relativePath);
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (error) {
    console.warn(`docs: fs.readFile failed for ${filePath}:`, error);
    return null;
  }
}
