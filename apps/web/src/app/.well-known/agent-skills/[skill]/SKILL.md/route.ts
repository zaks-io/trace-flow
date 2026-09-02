import { AGENT_SKILLS } from '@/generated/agent-skills';
import { SKILL_MD_CONTENT_TYPE } from '@/lib/agent-skills';

/**
 * The bytes served here are the ones hashed into the discovery index digest,
 * so this must stay a byte-for-byte copy of the repo's SKILL.md.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ skill: string }> }) {
  const { skill: name } = await params;
  const skill = AGENT_SKILLS.find((candidate) => candidate.name === name);

  if (!skill) {
    return new Response('Not found', {
      status: 404,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }

  return new Response(skill.content, {
    headers: {
      'Content-Type': SKILL_MD_CONTENT_TYPE,
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=300, s-maxage=300',
    },
  });
}
