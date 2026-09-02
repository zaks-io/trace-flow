import { AGENT_SKILLS } from '@/generated/agent-skills';
import { buildAgentSkillsIndex } from '@/lib/agent-skills';

/**
 * Discovery clients fetch this cross-origin and may probe with HEAD before
 * downloading artifacts. Next derives HEAD from GET.
 */
export async function GET(request: Request) {
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? new URL(request.url).origin;

  return new Response(JSON.stringify(buildAgentSkillsIndex(siteUrl, AGENT_SKILLS), null, 2), {
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=300, s-maxage=300',
    },
  });
}
