import { describe, expect, it } from 'vitest';
import {
  AGENT_SKILLS_SCHEMA_URL,
  buildAgentSkillsIndex,
  type SkillArtifact,
} from '../agent-skills';

const SKILLS: SkillArtifact[] = [
  {
    name: 'trace-flow',
    description: 'Route LLM calls through the gateway and read the traces back.',
    digest: `sha256:${'a'.repeat(64)}`,
  },
];

describe('buildAgentSkillsIndex', () => {
  it('declares the discovery schema version', () => {
    expect(buildAgentSkillsIndex('https://trace-flow.dev', SKILLS).$schema).toBe(
      AGENT_SKILLS_SCHEMA_URL,
    );
  });

  it('publishes one skill-md entry per skill with an absolute artifact url', () => {
    const [entry] = buildAgentSkillsIndex('https://trace-flow.dev', SKILLS).skills;

    expect(entry).toEqual({
      name: 'trace-flow',
      type: 'skill-md',
      description: SKILLS[0].description,
      url: 'https://trace-flow.dev/.well-known/agent-skills/trace-flow/SKILL.md',
      digest: SKILLS[0].digest,
    });
  });

  it('points artifacts at the deploy serving them', () => {
    const [entry] = buildAgentSkillsIndex('https://preview.trace-flow.dev/', SKILLS).skills;

    expect(entry.url).toBe(
      'https://preview.trace-flow.dev/.well-known/agent-skills/trace-flow/SKILL.md',
    );
  });
});
