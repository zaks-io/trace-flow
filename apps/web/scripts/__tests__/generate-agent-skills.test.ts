import { describe, expect, it } from 'vitest';
import { parseSkillFrontmatter } from '../generate-agent-skills';

const SOURCE = 'skills/trace-flow/SKILL.md';

function skill(frontmatter: string): string {
  return `---\n${frontmatter}\n---\n\n# Trace Flow\n`;
}

describe('parseSkillFrontmatter', () => {
  it('reads a single-line name and description', () => {
    const parsed = parseSkillFrontmatter(
      skill('name: trace-flow\ndescription: Read the traces back.'),
      'trace-flow',
      SOURCE,
    );

    expect(parsed).toEqual({ name: 'trace-flow', description: 'Read the traces back.' });
  });

  it('folds a description wrapped across continuation lines', () => {
    const parsed = parseSkillFrontmatter(
      skill(
        'name: trace-flow\ndescription: Route LLM calls through the gateway\n  and read the traces back.',
      ),
      'trace-flow',
      SOURCE,
    );

    expect(parsed.description).toBe(
      'Route LLM calls through the gateway and read the traces back.',
    );
  });

  it('strips surrounding quotes', () => {
    const parsed = parseSkillFrontmatter(
      skill(`name: trace-flow\ndescription: 'Read the traces back.'`),
      'trace-flow',
      SOURCE,
    );

    expect(parsed.description).toBe('Read the traces back.');
  });

  it('stops folding at the next frontmatter key', () => {
    const parsed = parseSkillFrontmatter(
      skill('name: trace-flow\ndescription: Read the traces back.\nmetadata:\n  internal: true'),
      'trace-flow',
      SOURCE,
    );

    expect(parsed.description).toBe('Read the traces back.');
  });

  it('rejects a block scalar rather than publishing the indicator', () => {
    expect(() =>
      parseSkillFrontmatter(
        skill('name: trace-flow\ndescription: >-\n  Read the traces back.'),
        'trace-flow',
        SOURCE,
      ),
    ).toThrow(/block scalar/);
  });

  it('rejects a name that does not match its directory', () => {
    expect(() =>
      parseSkillFrontmatter(
        skill('name: trace-flow\ndescription: Read the traces back.'),
        'traceflow',
        SOURCE,
      ),
    ).toThrow(/does not match directory/);
  });

  it('rejects a name outside the discovery name pattern', () => {
    expect(() =>
      parseSkillFrontmatter(
        skill('name: Trace_Flow\ndescription: Read the traces back.'),
        'Trace_Flow',
        SOURCE,
      ),
    ).toThrow(/not a valid discovery skill name/);
  });

  it('rejects a description over the 1024 character limit', () => {
    expect(() =>
      parseSkillFrontmatter(
        skill(`name: trace-flow\ndescription: ${'x'.repeat(1025)}`),
        'trace-flow',
        SOURCE,
      ),
    ).toThrow(/over the 1024/);
  });

  it('rejects missing frontmatter and missing fields', () => {
    expect(() => parseSkillFrontmatter('# Trace Flow\n', 'trace-flow', SOURCE)).toThrow(
      /missing YAML frontmatter/,
    );
    expect(() => parseSkillFrontmatter(skill('name: trace-flow'), 'trace-flow', SOURCE)).toThrow(
      /missing a "description" field/,
    );
  });
});
