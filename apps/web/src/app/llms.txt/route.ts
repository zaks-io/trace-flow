import { getDocMarkdownPath, getDocs } from '@/lib/docs';

function buildLlmsTxt(siteUrl: string) {
  const docs = getDocs();

  const docLinks = docs
    .map((doc) => {
      const markdownUrl = `${siteUrl}${getDocMarkdownPath(doc.slug)}`;
      return `- [${doc.title}](${markdownUrl}): ${doc.description}`;
    })
    .join('\n');

  return `# Trace Flow

> Trace Flow is an LLM observability platform for tracing requests, token usage, latency, and costs across providers.

Use this file as your starting point. Fetch only the linked documentation you need for the current task.
If you are integrating Trace Flow into a codebase, read /agents.md first, then fetch /docs/quick-start.md for env vars and the first traced request.

## Core Documentation

${docLinks}

## Agent Bootstrap

- [Agent Bootstrap Markdown](${siteUrl}/agents.md): Canonical instructions for AI assistants

## Optional

- [Documentation Index](${siteUrl}/docs): Human-friendly docs landing page
`;
}

export async function GET(request: Request) {
  const envSiteUrl = process.env.NEXT_PUBLIC_SITE_URL;
  const siteUrl = envSiteUrl ?? new URL(request.url).origin;

  return new Response(buildLlmsTxt(siteUrl), {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, max-age=300, s-maxage=300',
    },
  });
}
