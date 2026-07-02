import { describe, expect, it } from 'vitest';
import {
  MAX_CODE_CHARS,
  MAX_DATASETS,
  MAX_PI_CONTROL_MESSAGE_CHARS,
  DEFAULT_PI_THINKING_LEVEL,
  MAX_PI_PROMPT_CHARS,
  MAX_PI_RUNTIME_MS,
  MAX_STDOUT_CHARS,
  buildPythonScript,
  isAuthorized,
  parseControlPiRunRequest,
  parseDestroyPiRunRequest,
  parseExecuteAnalysisRequest,
  parseStartPiRunRequest,
  parseTraceflowToolRequest,
  truncateOutput,
} from '../request';

const validPayload = {
  sandboxId: 'analyst-user-1',
  code: 'print("ok")',
  datasets: [
    {
      name: 'traces',
      tool: 'list_trace_summaries',
      arguments: { limit: 5 },
      resultText: '{"content":[]}',
    },
  ],
};

const validRunPayload = {
  runId: 'jn7b9x8y2c1d0e3f4g5h6i7j8k9l0m1n',
  runToken: 'a'.repeat(64),
  sandboxId: 'analyst-run-1',
  prompt: 'Analyze recent agent usage.',
  pageContextReferences: [
    {
      surface: 'agents',
      objectId: 'overview',
      label: 'Overview',
      route: '/app/agents',
      filters: {},
    },
  ],
  maxRuntimeMs: 60 * 60 * 1000,
  model: 'z-ai/glm-5.2',
  toolDefinitions: [{ name: 'list_agent_sessions' }],
};

describe('analyst sandbox request boundary', () => {
  it('authorizes bearer tokens without accepting mismatches', () => {
    expect(isAuthorized('Bearer secret', 'secret')).toBe(true);
    expect(isAuthorized('Bearer nope', 'secret')).toBe(false);
    expect(isAuthorized(null, 'secret')).toBe(false);
  });

  it('accepts bounded execution payloads', () => {
    const parsed = parseExecuteAnalysisRequest(validPayload);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.request.datasets[0]?.name).toBe('traces');
    }
  });

  it('rejects bad sandbox IDs, oversized code, and too many datasets', () => {
    expect(parseExecuteAnalysisRequest({ ...validPayload, sandboxId: '../bad' }).ok).toBe(false);
    expect(
      parseExecuteAnalysisRequest({ ...validPayload, code: 'x'.repeat(MAX_CODE_CHARS + 1) }).ok,
    ).toBe(false);
    expect(
      parseExecuteAnalysisRequest({
        ...validPayload,
        datasets: Array.from({ length: MAX_DATASETS + 1 }, (_, index) => ({
          name: `dataset_${index}`,
          tool: 'list_traces',
          arguments: {},
          resultText: '{}',
        })),
      }).ok,
    ).toBe(false);
  });

  it('truncates large stdout', () => {
    const output = truncateOutput('a'.repeat(MAX_STDOUT_CHARS + 1), MAX_STDOUT_CHARS);
    expect(output.truncated).toBe(true);
    expect(output.value).toContain('[truncated]');
  });

  it('builds a Python wrapper without leaking raw worker secrets', () => {
    const parsed = parseExecuteAnalysisRequest(validPayload);
    if (!parsed.ok) throw new Error(parsed.error);
    const script = buildPythonScript(parsed.request);
    expect(script).toContain('TRACEFLOW_DATASETS');
    expect(script).not.toContain('ANALYST_SANDBOX_SHARED_SECRET');
    expect(script).not.toContain(['TINYBIRD', 'ADMIN', 'TOKEN'].join('_'));
  });

  it('accepts bounded Pi run starts', () => {
    const parsed = parseStartPiRunRequest(validRunPayload);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.request.runToken).toHaveLength(64);
      expect(parsed.request.maxRuntimeMs).toBe(60 * 60 * 1000);
    }
  });

  it('rejects invalid Pi run tokens, oversized prompts, and runtimes over the hard cap', () => {
    expect(parseStartPiRunRequest({ ...validRunPayload, runToken: 'secret' }).ok).toBe(false);
    expect(
      parseStartPiRunRequest({ ...validRunPayload, prompt: 'x'.repeat(MAX_PI_PROMPT_CHARS + 1) })
        .ok,
    ).toBe(false);
    expect(
      parseStartPiRunRequest({ ...validRunPayload, maxRuntimeMs: MAX_PI_RUNTIME_MS + 1 }).ok,
    ).toBe(false);
  });

  it('defaults thinkingLevel to a reasoning level, honors valid overrides, rejects bad ones', () => {
    const fallback = parseStartPiRunRequest(validRunPayload);
    expect(fallback.ok).toBe(true);
    if (fallback.ok) {
      expect(fallback.request.thinkingLevel).toBe(DEFAULT_PI_THINKING_LEVEL);
      expect(fallback.request.thinkingLevel).not.toBe('off');
    }

    const override = parseStartPiRunRequest({ ...validRunPayload, thinkingLevel: 'high' });
    expect(override.ok).toBe(true);
    if (override.ok) expect(override.request.thinkingLevel).toBe('high');

    expect(parseStartPiRunRequest({ ...validRunPayload, thinkingLevel: 'ultra' }).ok).toBe(false);
  });

  it('accepts only bounded Pi control requests', () => {
    expect(
      parseControlPiRunRequest({
        runId: validRunPayload.runId,
        sandboxId: 'analyst-run-1',
        action: 'status',
      }).ok,
    ).toBe(true);
    expect(
      parseControlPiRunRequest({
        runId: validRunPayload.runId,
        sandboxId: 'analyst-run-1',
        action: 'tail',
        tailLimit: 50,
      }).ok,
    ).toBe(true);
    expect(
      parseControlPiRunRequest({
        runId: validRunPayload.runId,
        sandboxId: 'analyst-run-1',
        action: 'cancel',
      }).ok,
    ).toBe(true);
    expect(
      parseControlPiRunRequest({
        runId: validRunPayload.runId,
        sandboxId: 'analyst-run-1',
        action: 'steer',
        message: 'x'.repeat(MAX_PI_CONTROL_MESSAGE_CHARS + 1),
      }).ok,
    ).toBe(false);
    expect(
      parseControlPiRunRequest({
        runId: validRunPayload.runId,
        sandboxId: 'analyst-run-1',
        action: 'delete',
      }).ok,
    ).toBe(false);
    expect(
      parseControlPiRunRequest({
        runId: validRunPayload.runId,
        sandboxId: 'analyst-run-1',
        action: 'tail',
        tailLimit: 501,
      }).ok,
    ).toBe(false);
  });

  it('accepts bounded Pi destroy requests', () => {
    expect(
      parseDestroyPiRunRequest({
        sandboxId: 'analyst-run-1',
        processId: `pi-${validRunPayload.runId}`,
      }).ok,
    ).toBe(true);
    expect(parseDestroyPiRunRequest({ sandboxId: '../bad' }).ok).toBe(false);
    expect(parseDestroyPiRunRequest({ sandboxId: 'analyst-run-1', processId: 123 }).ok).toBe(false);
  });

  it('accepts Trace Flow data tool calls without requiring worker credentials in the payload', () => {
    const parsed = parseTraceflowToolRequest({
      runId: validRunPayload.runId,
      toolName: 'list_agent_sessions',
      arguments: { limit: 10 },
    });

    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.request.arguments).toEqual({ limit: 10 });
      expect(parsed.request).not.toHaveProperty('tinybirdAdminToken');
      expect(parsed.request).not.toHaveProperty('convexAdminKey');
    }
  });

  it('accepts Pi stringified JSON tool arguments', () => {
    const parsed = parseTraceflowToolRequest({
      runId: validRunPayload.runId,
      toolName: 'query_agent_analytics',
      arguments: '{"view":"summary","hours":168}',
    });

    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.request.arguments).toEqual({ view: 'summary', hours: 168 });
    }
  });

  it('rejects non-object JSON tool arguments', () => {
    expect(
      parseTraceflowToolRequest({
        runId: validRunPayload.runId,
        toolName: 'query_agent_analytics',
        arguments: '["summary"]',
      }).ok,
    ).toBe(false);
  });
});
