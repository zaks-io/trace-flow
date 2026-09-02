/**
 * Agent Skills discovery document (Agent Skills Discovery RFC v0.2.0) served
 * from /.well-known/agent-skills/index.json.
 *
 * Skill artifacts are served by this app, so `siteUrl` anchors them the same
 * way the API catalog anchors its documentation links: a preview deploy
 * publishes and hashes its own copy of each SKILL.md.
 */

export const AGENT_SKILLS_SCHEMA_URL = 'https://schemas.agentskills.io/discovery/0.2.0/schema.json';
export const SKILL_MD_CONTENT_TYPE = 'text/markdown; charset=utf-8';

export type SkillArtifact = {
  name: string;
  description: string;
  digest: string;
};

export type AgentSkillEntry = {
  name: string;
  type: 'skill-md';
  description: string;
  url: string;
  digest: string;
};

export type AgentSkillsIndex = {
  $schema: string;
  skills: AgentSkillEntry[];
};

function skillArtifactPath(name: string): string {
  return `/.well-known/agent-skills/${name}/SKILL.md`;
}

export function buildAgentSkillsIndex(
  siteUrl: string,
  skills: readonly SkillArtifact[],
): AgentSkillsIndex {
  const origin = siteUrl.replace(/\/$/, '');

  return {
    $schema: AGENT_SKILLS_SCHEMA_URL,
    skills: skills.map((skill) => ({
      name: skill.name,
      type: 'skill-md',
      description: skill.description,
      url: `${origin}${skillArtifactPath(skill.name)}`,
      digest: skill.digest,
    })),
  };
}
