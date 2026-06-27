import { describe, expect, it } from 'vitest';
import {
  buildMessagePageContextReferences,
  pageContextKey,
  type AnalystPageContextReference,
} from '../pageContext';

describe('Analyst page context references', () => {
  it('keys references by surface and object id', () => {
    const reference: AnalystPageContextReference = {
      surface: 'agents',
      objectId: 'cost-over-time',
      label: 'Cost over time',
      route: '/app/agents',
      filters: { days: 7 },
    };

    expect(pageContextKey(reference)).toBe('agents:cost-over-time');
  });

  it('adds ambient Agent Analytics context for /app/agents without replacing selected chips', () => {
    const selectedReference: AnalystPageContextReference = {
      surface: 'agents',
      objectId: 'cost-over-time',
      label: 'Cost over time',
      route: '/app/agents',
      filters: { days: 7 },
    };

    expect(buildMessagePageContextReferences('/app/agents', [selectedReference])).toEqual([
      {
        surface: 'agents',
        objectId: 'agents-page',
        label: 'Agent Analytics page',
        route: '/app/agents',
        filters: {},
      },
      selectedReference,
    ]);
    expect(buildMessagePageContextReferences('/app/traces', [selectedReference])).toEqual([
      selectedReference,
    ]);
  });

  it('attaches ambient context on /app/agents descendants but not sibling routes', () => {
    const ambient = {
      surface: 'agents',
      objectId: 'agents-page',
      label: 'Agent Analytics page',
      route: '/app/agents/abc',
      filters: {},
    };
    expect(buildMessagePageContextReferences('/app/agents/abc', [])).toEqual([ambient]);
    // A sibling route that merely shares the prefix must not match.
    expect(buildMessagePageContextReferences('/app/agentship', [])).toEqual([]);
  });
});
