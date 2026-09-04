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

> Trace Flow is Zaks.io's internal development tooling for model API requests and coding-agent sessions, shared as source under Apache-2.0.

Hosted URLs refer to the company deployment and require access. Agent Conversation Analytics is not production-ready.
See the repository README and roadmap for setup limits and unfinished work.

Use this file as your starting point. Fetch only the linked documentation you need for the current task.
For model API integration, read /agents.md first, then fetch /docs/quick-start.md for env vars and the first traced request.
For local Claude Code, Codex CLI, or Cursor analytics, fetch /docs/collector.md.

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
