import { describe, expect, it } from 'vitest';
import {
  ANALYST_DEFAULT_MODEL,
  ANALYST_MAX_STEPS,
  buildAnalystSystemPrompt,
  buildAnalystThreadTitle,
  buildHiddenAnalystMessageMetadata,
  buildOpenRouterExtraBody,
  isHiddenAnalystMessageLike,
  isHiddenAnalystProviderMetadata,
} from '../analyst';
import { getTraceFlowToolDefinitions } from '@trace-flow/mcp-core';
import { asSchema } from 'ai';
import { buildAnalystTools } from '../analystTools';

describe('analyst helpers', () => {
  it('uses the configured GLM 5.2 default model', () => {
    expect(ANALYST_DEFAULT_MODEL).toBe('z-ai/glm-5.2');
  });

  it('allows up to 50 agent steps', () => {
    expect(ANALYST_MAX_STEPS).toBe(50);
  });

  it('exposes exactly the unchanged analyst tool definitions', async () => {
    const definitions = getTraceFlowToolDefinitions('analyst');
    const tools = buildAnalystTools();
    expect(Object.keys(tools)).toEqual(definitions.map((definition) => definition.name));
    for (const definition of definitions) {
      const tool = tools[definition.name];
      expect(tool.title).toBe(definition.title);
      expect(tool.description).toBe(definition.description);
      expect(await asSchema(tool.inputSchema).jsonSchema).toEqual(definition.inputSchema);
    }
  });

  it('uses Agent Analytics tools for the Agents page', () => {
    const prompt = buildAnalystSystemPrompt([
      {
        surface: 'agents',
        objectId: 'agents-page',
        label: 'Agent Analytics page',
        route: '/app/agents',
      },
    ]);
    expect(prompt).toContain('query_agent_analytics');
    expect(prompt).toContain('{"view":"summary","hours":168}');
    expect(prompt).toContain('Resolve these references through tools');
  });

  it('builds compact thread titles', () => {
    expect(buildAnalystThreadTitle('  what happened   yesterday?  ')).toBe(
      'what happened yesterday?',
    );
    expect(buildAnalystThreadTitle('')).toBe('New analyst conversation');
    expect(buildAnalystThreadTitle('x'.repeat(120))).toHaveLength(80);
  });

  it('uses the Analyst thread id as the OpenRouter sticky session id', () => {
    expect(buildOpenRouterExtraBody('thread_123')).toMatchObject({
      session_id: 'thread_123',
      usage: { include: true },
      cache_control: { type: 'ephemeral', ttl: '1h' },
    });
  });

  it('marks internal Analyst messages as hidden provider metadata', () => {
    const metadata = buildHiddenAnalystMessageMetadata();

    expect(metadata).toEqual({
      providerMetadata: {
        traceFlowAnalyst: {
          hidden: true,
        },
      },
    });
    expect(isHiddenAnalystProviderMetadata(metadata.providerMetadata)).toBe(true);
    expect(isHiddenAnalystProviderMetadata({ traceFlowAnalyst: { hidden: false } })).toBe(false);
  });

  it('hides historical analysis continuation prompts even without persisted metadata', () => {
    expect(
      isHiddenAnalystMessageLike({
        role: 'user',
        text: 'A background Trace Flow data analysis run completed. Use this final composed response to answer the user.',
      }),
    ).toBe(true);
    expect(
      isHiddenAnalystMessageLike({
        role: 'user',
        text: 'Can you explain the latest Pi data analysis run?',
      }),
    ).toBe(false);
  });

  it('always sends OpenRouter prompt cache control', () => {
    expect(buildOpenRouterExtraBody('thread_123')).toHaveProperty('cache_control', {
      type: 'ephemeral',
      ttl: '1h',
    });
  });
});
