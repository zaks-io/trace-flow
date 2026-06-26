import { describe, expect, it } from 'vitest';
import { buildPiModelsJson, buildPiRunnerScript, buildPiWorkspaceManifest } from '../piRunner';

describe('Pi runner script', () => {
  it('requires traceflow_data arguments so Pi does not omit tool payloads', () => {
    const script = buildPiRunnerScript();

    expect(script).toContain('arguments: Type.Any()');
    expect(script).not.toContain('arguments: Type.Optional(Type.Any())');
  });

  it('lets Convex emit canonical data tool events', () => {
    const script = buildPiRunnerScript();

    expect(script).not.toContain("emit({ type: 'tool_call'");
    expect(script).not.toContain("emit({ type: 'tool_result'");
  });

  it('materializes traceflow_data results to disk instead of returning raw data inline', () => {
    const script = buildPiRunnerScript();

    expect(script).toContain('writeTraceflowDataArtifact');
    expect(script).toContain("const dataDir = path.join(runDir, 'data')");
    expect(script).toContain('artifactPath');
    expect(script).toContain('Raw Trace Flow data is not returned inline');
    expect(script).not.toContain('safeStringify(result, 20000)');
  });

  it('serves a sandbox-local OpenAPI data API generated from approved tools', () => {
    const script = buildPiRunnerScript();

    expect(script).toContain("import http from 'node:http'");
    expect(script).toContain('buildTraceflowOpenApiDocument');
    expect(script).toContain("'/openapi.json'");
    expect(script).toContain("'/tools/{toolName}'");
    expect(script).toContain("'/tools/' + name");
    expect(script).toContain('Trace Flow Data API ready');
    expect(script).toContain('fetchTraceflowToolResult');
    expect(script).not.toContain('safeStringify(request.toolDefinitions, 30000)');
  });

  it('uses OpenAPI for discovery but skips it when exact operations are provided', () => {
    const script = buildPiRunnerScript();

    expect(script).toContain(
      'Read the live OpenAPI document before writing data access code when you need discovery',
    );
    expect(script).toContain('skip OpenAPI/schema discovery');
    expect(script).toContain('{"view":"summary","hours":168}');
    expect(script).toContain('Call POST ');
    expect(script).toContain('/tools/<toolName>');
    expect(script).toContain('Use limit/cursor fields from OpenAPI');
  });

  it('keeps raw API bodies and key metadata out of final Pi reports', () => {
    const script = buildPiRunnerScript();

    expect(script).toContain('Do not include raw API response bodies');
    expect(script).toContain('API key names, API key IDs');
    expect(script).toContain('Save raw outputs under the run directory and summarize them instead');
    expect(script).toContain('Do not use account, credential, or key-inventory endpoints');
  });

  it('runs Pi from an explicitly trusted generated workspace without ambient discovery', () => {
    const script = buildPiRunnerScript();

    expect(script).toContain("defaultProjectTrust: 'always'");
    expect(script).toContain('{ projectTrusted: true }');
    expect(script).toContain('traceflow-context-guard.ts');
    expect(script).toContain('extensions: [contextGuardExtensionPath]');
    expect(script).toContain('noExtensions: false');
    expect(script).toContain('noSkills: true');
    expect(script).toContain('noPromptTemplates: true');
    expect(script).toContain('noThemes: true');
    expect(script).toContain('noContextFiles: true');
    expect(script).toContain('Trace Flow generates this trusted workspace');
  });

  it('loads a generated context guard that prevents raw tool output from entering provider context', () => {
    const script = buildPiRunnerScript();

    expect(script).toContain('buildTraceflowContextGuardExtension');
    expect(script).toContain("pi.on('tool_result'");
    expect(script).toContain("pi.on('context'");
    expect(script).toContain("pi.on('before_provider_request'");
    expect(script).toContain('MAX_TOOL_RESULT_CONTEXT_CHARS = 12000');
    expect(script).toContain('MAX_MESSAGE_CONTEXT_CHARS = 24000');
    expect(script).toContain('MAX_PROVIDER_PAYLOAD_CHARS = 180000');
    expect(script).toContain('Large Pi tool result saved outside LLM context');
    expect(script).toContain('Oversized Pi provider payload compacted before send');
    expect(script).toContain('Trace Flow context guard blocked an oversized provider payload');
  });

  it('prompts Pi to write scripts, page data, and validate aggregates instead of filling context', () => {
    const script = buildPiRunnerScript();

    expect(script).toContain(
      'Your primary deliverable is a verified analysis script plus a compact final answer',
    );
    expect(script).toContain('page, aggregate, and validate the data');
    expect(script).toContain('Prefer aggregate endpoints for top-line totals');
    expect(script).toContain('Never print full paged API responses or large DataFrames to stdout');
    expect(script).toContain('context-artifacts');
  });

  it('emits heartbeat and usage events without hiding idle time', () => {
    const script = buildPiRunnerScript();

    expect(script).toContain("message: 'Pi runner heartbeat'");
    expect(script).toContain("type: 'usage'");
    expect(script).toContain('markActivity: false');
    expect(script).toContain('getSessionStats');
  });

  it('bounds provider requests so a stuck provider does not make the run opaque', () => {
    const script = buildPiRunnerScript();

    expect(script).toContain('PROVIDER_REQUEST_TIMEOUT_MS');
    expect(script).toContain('PROVIDER_IDLE_TIMEOUT_MS');
    expect(script).toContain('2 * 60 * 1000');
    expect(script).toContain('30000');
    expect(script).toContain('provider: {');
    expect(script).toContain('maxRetries: 0');
  });

  it('keeps Pi model reasoning and output budget low by default', () => {
    const script = buildPiRunnerScript();

    expect(script).toContain("thinkingLevel: 'off'");
    expect(script).not.toContain("thinkingLevel: 'medium'");
    expect(script).toContain("assistantEventType?.startsWith('thinking_')");
    expect(script).toContain('Do arithmetic and validation in bash/Python');
  });

  it('finalizes from bounded tool output if the provider stalls before final text', () => {
    const script = buildPiRunnerScript();

    expect(script).toContain('latestToolResultText');
    expect(script).toContain('completedToolResultTextFromEvent');
    expect(script).toContain('Pi provider stream stalled after tool output');
    expect(script).toContain('Last completed tool output, bounded for continuation synthesis');
  });
});

describe('Pi model config', () => {
  it('uses the z-ai/glm-5.2 OpenRouter cost and prompt cache config for Pi stats', () => {
    const config = JSON.parse(buildPiModelsJson('z-ai/glm-5.2', 'https://sandbox.example/api/v1'));
    const model = config.providers['traceflow-openrouter'].models[0];

    expect(model.reasoning).toBe(false);
    expect(model.maxTokens).toBe(4096);
    expect(model.cost).toEqual({ input: 0.95, output: 3, cacheRead: 0.18, cacheWrite: 0 });
    expect(model.compat).toEqual({ cacheControlFormat: 'anthropic' });
  });

  it('documents the sandbox trust boundary in the generated workspace manifest', () => {
    const manifest = buildPiWorkspaceManifest();

    expect(manifest).toContain('Ambient Pi discovery is disabled');
    expect(manifest).toContain('generated Trace Flow context guard');
    expect(manifest).toContain('returns artifact paths, not inline datasets');
    expect(manifest).toContain('serves live OpenAPI');
    expect(manifest).toContain('Convex verifies the run token');
    expect(manifest).not.toContain('OPENROUTER_API_KEY');
  });
});
