import { describe, expect, it } from 'vitest';
import { CLI_PROXY } from '@trace-flow/otel-conventions';
import { validateImportedClientIdentity } from '../imported/clientIdentity';

const base = {
  [CLI_PROXY.CLIENT_SOURCE]: 'codex',
  [CLI_PROXY.CLIENT_SESSION_ID]: 'thread-1',
};

describe('imported client identity', () => {
  it('accepts explicit Codex lineage and inbound context', () => {
    expect(
      validateImportedClientIdentity({
        ...base,
        [CLI_PROXY.CLIENT_PARENT_SESSION_ID]: 'thread-root',
        [CLI_PROXY.CLIENT_ORIGIN_SESSION_ID]: 'session-1',
        [CLI_PROXY.INBOUND_TRACE_ID]: '1'.repeat(32),
        [CLI_PROXY.INBOUND_SPAN_ID]: '2'.repeat(16),
      }),
    ).toBeUndefined();
  });

  it.each([
    [{ [CLI_PROXY.CLIENT_SOURCE]: 'claude' }, 'attribute_client_session'],
    [{ [CLI_PROXY.CLIENT_SESSION_ID]: 's' }, 'attribute_client_session'],
    [{ ...base, [CLI_PROXY.CLIENT_AGENT_ID]: 'agent-1' }, 'attribute_client_agent'],
    [
      {
        [CLI_PROXY.CLIENT_SOURCE]: 'claude',
        [CLI_PROXY.CLIENT_SESSION_ID]: 's',
        [CLI_PROXY.CLIENT_AGENT_ID]: 'main',
      },
      'attribute_client_agent',
    ],
    [{ ...base, [CLI_PROXY.CLIENT_PARENT_SESSION_ID]: 'thread-1' }, 'attribute_client_parent'],
    [{ ...base, [CLI_PROXY.CLIENT_ORIGIN_SESSION_ID]: 'thread-1' }, 'attribute_client_origin'],
    [
      {
        [CLI_PROXY.CLIENT_SOURCE]: 'claude',
        [CLI_PROXY.CLIENT_SESSION_ID]: 's',
        [CLI_PROXY.CLIENT_PARENT_SESSION_ID]: 'p',
      },
      'attribute_client_parent',
    ],
    [{ [CLI_PROXY.INBOUND_TRACE_ID]: '1'.repeat(32) }, 'attribute_inbound_trace'],
  ])('rejects invalid related attributes with a split-safe reason', (attributes, reason) => {
    expect(validateImportedClientIdentity(attributes)).toBe(reason);
    expect(reason).toMatch(/^attribute_/);
  });
});
