import { getDocMarkdownPath, getDocs } from '@/lib/docs';

const SITE_URL = 'https://trace-flow.dev';

function buildLlmsTxt() {
  const docs = getDocs();

  const docLinks = docs
    .map((doc) => {
      const markdownUrl = `${SITE_URL}${getDocMarkdownPath(doc.slug)}`;
      return `- [${doc.title}](${markdownUrl}): ${doc.description}`;
    })
    .join('\n');

  return `# Trace Flow

> Trace Flow is an LLM observability platform for tracing requests, token usage, latency, and costs across providers.

Use this file as your starting point. Fetch only the linked documentation you need for the current task.

## Core Documentation

${docLinks}

## Agent Bootstrap

- [Agent Bootstrap Markdown](${SITE_URL}/agents.md): Canonical instructions for AI assistants

## Optional

- [Documentation Index](${SITE_URL}/docs): Human-friendly docs landing page
`;
}

export async function GET() {
  return new Response(buildLlmsTxt(), {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, max-age=300, s-maxage=300',
    },
  });
}
