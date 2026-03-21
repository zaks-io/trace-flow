import { readDocMarkdown } from '@/lib/docs';

export async function GET() {
  const content = await readDocMarkdown('agents');

  if (!content) {
    return new Response('Not found', { status: 404 });
  }

  return new Response(content, {
    headers: {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Cache-Control': 'public, max-age=300, s-maxage=300',
    },
  });
}
