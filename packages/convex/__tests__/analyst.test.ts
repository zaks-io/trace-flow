import { describe, expect, it } from 'vitest';
import {
  ANALYST_DEFAULT_MODEL,
  ANALYST_MAX_STEPS,
  SANDBOX_START_FETCH_TIMEOUT_MS,
  buildAnalystSystemPrompt,
  buildAnalystThreadTitle,
  buildHiddenAnalystMessageMetadata,
  buildOpenRouterExtraBody,
  buildPiCompletionPrompt,
  describeSandboxProcessCause,
  getDirectAnalystTraceFlowToolDefinitions,
  isHiddenAnalystMessageLike,
  isHiddenAnalystProviderMetadata,
  isSandboxRunTimeoutExpired,
  sandboxRunLivenessVerdict,
  sandboxRunTimeoutRemainingMs,
  shouldExposeSandboxControlTool,
  supportsOpenRouterCacheControl,
} from '../analyst';

describe('analyst helpers', () => {
  it('uses the configured GLM 5.2 default model', () => {
    expect(ANALYST_DEFAULT_MODEL).toBe('z-ai/glm-5.2');
  });

  it('allows up to 50 agent steps', () => {
    expect(ANALYST_MAX_STEPS).toBe(50);
  });

  it('allows slow Cloudflare Sandbox cold starts before failing Pi launch', () => {
    expect(SANDBOX_START_FETCH_TIMEOUT_MS).toBe(180_000);
  });

  it('keeps all direct Trace Flow data tools out of the main Analyst', () => {
    expect(getDirectAnalystTraceFlowToolDefinitions()).toEqual([]);
  });

  it('routes /app/agents context toward Agent Analytics sandbox data operations', () => {
    const prompt = buildAnalystSystemPrompt([
      {
        surface: 'agents',
        objectId: 'agents-page',
        label: 'Agent Analytics page',
        route: '/app/agents',
      },
    ]);

    expect(prompt).toContain('The /app/agents page is Agent Analytics');
    expect(prompt).toContain('query_agent_analytics');
    expect(prompt).toContain('from a script');
    expect(prompt).toContain('{"view":"summary","hours":168}');
    expect(prompt).toContain('do not ask it to inspect OpenAPI');
    expect(prompt).toContain('validate numbers with aggregates');
    expect(prompt).toContain('keep raw rows on disk');
    expect(prompt).toContain('Do not default to generic trace tools');
  });

  it('does not expose Pi control polling for ordinary start-run prompts', () => {
    expect(
      shouldExposeSandboxControlTool(
        'Use start_pi_agent_analysis for a minimal smoke test and tell me if the runner is healthy.',
      ),
    ).toBe(false);
    expect(shouldExposeSandboxControlTool('Check status for Pi run ns123.')).toBe(true);
    expect(shouldExposeSandboxControlTool('Cancel the sandbox run.')).toBe(true);
  });

  it('builds compact thread titles', () => {
    expect(buildAnalystThreadTitle('  what happened   yesterday?  ')).toBe(
      'what happened yesterday?',
    );
    expect(buildAnalystThreadTitle('')).toBe('New analyst conversation');
    expect(buildAnalystThreadTitle('x'.repeat(120))).toHaveLength(80);
  });

  it('uses the Analyst thread id as the OpenRouter sticky session id', () => {
    expect(buildOpenRouterExtraBody('thread_123', 'z-ai/glm-5.2')).toMatchObject({
      session_id: 'thread_123',
      usage: { include: true },
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

  it('hides internal Pi continuation prompts even without persisted metadata', () => {
    expect(
      isHiddenAnalystMessageLike({
        role: 'user',
        text: 'A background Pi coding-agent analysis completed. Use this final composed response to answer the user.',
      }),
    ).toBe(true);
    expect(
      isHiddenAnalystMessageLike({
        role: 'user',
        text: 'Can you explain the latest Pi data analysis run?',
      }),
    ).toBe(false);
  });

  it('only adds explicit cache_control for supported provider paths by default', () => {
    expect(buildOpenRouterExtraBody('thread_123', 'z-ai/glm-5.2')).not.toHaveProperty(
      'cache_control',
    );
    expect(buildOpenRouterExtraBody('thread_123', 'anthropic/claude-sonnet-4')).toHaveProperty(
      'cache_control',
    );
    expect(supportsOpenRouterCacheControl('~anthropic/claude-sonnet-4')).toBe(true);
  });

  it('passes only the Pi final composed response into completion continuation context', () => {
    const prompt = buildPiCompletionPrompt({
      _id: 'run_123',
      prompt: 'Analyze 90 days of usage',
      resultText: 'Final summary with numbers and caveats.',
    });

    expect(prompt).toContain('Pi final composed response:');
    expect(prompt).toContain('Final summary with numbers and caveats.');
    expect(prompt).toContain('raw data stayed in sandbox artifacts');
    expect(prompt).not.toContain('Pi result:');
  });

  it('detects active sandbox runs that exceeded their runtime and grace period', () => {
    expect(
      isSandboxRunTimeoutExpired(
        {
          _creationTime: 1_000,
          status: 'running',
          startedAt: 2_000,
          maxRuntimeMs: 10_000,
        },
        12_000,
        0,
      ),
    ).toBe(true);

    expect(
      isSandboxRunTimeoutExpired(
        {
          _creationTime: 1_000,
          status: 'completed',
          startedAt: 2_000,
          maxRuntimeMs: 10_000,
        },
        100_000,
        0,
      ),
    ).toBe(false);
  });

  it('reports remaining timeout delay when the watchdog fires early', () => {
    const run = {
      _creationTime: 1_000,
      status: 'running',
      startedAt: 2_000,
      maxRuntimeMs: 10_000,
    };

    expect(sandboxRunTimeoutRemainingMs(run, 11_500, 0)).toBe(500);
    expect(sandboxRunTimeoutRemainingMs(run, 12_000, 0)).toBe(0);
    expect(sandboxRunTimeoutRemainingMs({ ...run, status: 'completed' }, 100_000, 0)).toBeNull();
  });

  describe('sandboxRunLivenessVerdict', () => {
    const base = { _creationTime: 1_000, startedAt: 2_000, status: 'running' };

    it('reschedules while an active run keeps signalling', () => {
      const run = { ...base, lastEventAt: 100_000 };
      expect(sandboxRunLivenessVerdict(run, 100_000 + 10_000, 30_000)).toBe('reschedule');
    });

    it('declares an active run dead once its heartbeats go silent', () => {
      const run = { ...base, lastEventAt: 100_000 };
      expect(sandboxRunLivenessVerdict(run, 100_000 + 30_000, 30_000)).toBe('dead');
    });

    it('falls back to startedAt then creationTime when no event has arrived', () => {
      expect(sandboxRunLivenessVerdict({ ...base }, 2_000 + 10_000, 30_000)).toBe('reschedule');
      expect(sandboxRunLivenessVerdict({ ...base }, 2_000 + 40_000, 30_000)).toBe('dead');
      expect(
        sandboxRunLivenessVerdict(
          { _creationTime: 1_000, status: 'starting' },
          1_000 + 40_000,
          30_000,
        ),
      ).toBe('dead');
    });

    it('stops watching once the run is terminal', () => {
      for (const status of ['completed', 'failed', 'timed_out', 'cancelled']) {
        expect(sandboxRunLivenessVerdict({ ...base, status, lastEventAt: 0 }, 1_000_000)).toBe(
          'stop',
        );
      }
    });
  });

  describe('describeSandboxProcessCause', () => {
    it('reports a killed process with its exit code (OOM/SIGKILL signature)', () => {
      expect(describeSandboxProcessCause({ id: 'pi-abc', status: 'killed', exitCode: 137 })).toBe(
        'process pi-abc is killed with exit code 137',
      );
    });

    it('omits the exit code when the process is still running', () => {
      expect(describeSandboxProcessCause({ id: 'pi-abc', status: 'running' })).toBe(
        'process pi-abc is running',
      );
    });

    it('falls back to the known processId when the snapshot has none', () => {
      expect(describeSandboxProcessCause({ status: 'completed' }, 'pi-fallback')).toBe(
        'process pi-fallback is completed',
      );
    });

    it('reports the fetch error when the snapshot could not be read', () => {
      expect(describeSandboxProcessCause(null, 'pi-abc', 'sandbox timeout')).toBe(
        'process diagnostics unavailable (sandbox timeout)',
      );
    });

    it('returns undefined when there is genuinely nothing to say', () => {
      expect(describeSandboxProcessCause(null, 'pi-abc')).toBeUndefined();
    });
  });
});
