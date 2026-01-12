import Link from 'next/link';
import { CodeBlock } from '@/components/docs/CodeBlock';
import { Box, Info, MousePointer2, AlertTriangle, PenLine, Activity } from 'lucide-react';

const CLAUDE_CODE_CONFIG = `{
  "mcpServers": {
    "trace-flow": {
      "type": "http",
      "url": "https://mcp.trace-flow.dev/mcp"
    }
  }
}`;

const LIST_TRACES_RESPONSE = `{
  "traces": [
    {
      "trace_id": "a1b2c3d4e5f6789012345678abcdef01",
      "timestamp": "2025-01-15T14:32:01.000Z",
      "duration_ms": 1847,
      "status": "ok",
      "provider": "openai",
      "model": "gpt-4o",
      "tokens": { "prompt": 1250, "completion": 342, "total": 1592 },
      "cost_usd": 0.0234
    }
  ],
  "pagination": { "has_more": true, "next_cursor": "...", "limit": 10 }
}`;

const GET_TRACE_RESPONSE = `{
  "trace_id": "a1b2c3d4e5f6789012345678abcdef01",
  "root_span": {
    "provider": "openai",
    "model": "gpt-4o",
    "duration_ms": 1847,
    "status": "ok",
    "tokens": { "prompt": 1250, "completion": 342, "total": 1592 },
    "cost_usd": { "input": 0.0125, "output": 0.0109, "total": 0.0234 }
  },
  "spans": [
    {
      "span_id": "abc123...",
      "name": "chat",
      "duration_ms": 1847,
      "attributes": {
        "gen_ai.system": "openai",
        "gen_ai.request.model": "gpt-4o",
        "http.response.status_code": "200",
        "gen_ai.server.time_to_first_token": "423"
      }
    }
  ],
  "span_count": 1
}`;

export default function MCPPage() {
  return (
    <>
      {/* Hero */}
      <div className="mb-16 animate-fade-in">
        <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-[oklch(0.7_0.18_280)]/20 bg-[oklch(0.7_0.18_280)]/5 px-3 py-1">
          <Box className="h-3.5 w-3.5 text-[oklch(0.7_0.18_280)]" />
          <span className="font-mono text-xs text-[oklch(0.7_0.18_280)]">MCP Server</span>
        </div>
        <h1 className="mb-4 text-4xl font-bold tracking-tight text-foreground sm:text-5xl">
          Query Traces from Your AI Agent
        </h1>
        <p className="max-w-2xl text-lg text-muted-foreground">
          Give Claude Code, Cursor, or any MCP-compatible agent direct access to your LLM trace
          data. Debug production issues, analyze costs, and understand token usage without leaving
          your editor.
        </p>
      </div>

      {/* Why MCP */}
      <div className="mb-12 animate-fade-in" style={{ animationDelay: '100ms' }}>
        <div className="rounded-xl border border-[oklch(0.7_0.18_280)]/20 bg-[oklch(0.7_0.18_280)]/5 p-6">
          <h3 className="mb-4 flex items-center gap-2 text-sm font-medium uppercase tracking-wider text-[oklch(0.7_0.18_280)]">
            <Info className="h-4 w-4" />
            Why MCP?
          </h3>
          <p className="text-foreground">
            The <strong>Model Context Protocol</strong> lets AI agents call tools directly. Instead
            of copying trace IDs from your dashboard, your agent can query traces, find errors, and
            analyze costs in real-time—all while helping you debug or optimize your LLM workflows.
          </p>
        </div>
      </div>

      {/* Agent Setup */}
      <div className="mb-12 animate-fade-in" style={{ animationDelay: '150ms' }}>
        <h2 className="mb-6 text-sm font-medium uppercase tracking-wider text-muted-foreground">
          Setup Your Agent
        </h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {/* Claude Code */}
          <div className="rounded-xl border border-border/50 bg-card/50 p-5">
            <div className="mb-3 flex items-center gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-[oklch(0.75_0.12_50)]/10 text-[oklch(0.75_0.12_50)]">
                <svg className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M13.827 3.52h3.603L24 20h-3.603l-6.57-16.48zm-7.258 0h3.767L16.906 20h-3.674l-1.343-3.461H5.017l-1.344 3.46H0L6.57 3.522zm3.174 3.662L6.53 13.641h6.441l-3.228-6.46z" />
                </svg>
              </div>
              <h3 className="font-semibold text-foreground">Claude Code</h3>
            </div>
            <p className="mb-3 text-sm text-muted-foreground">
              Add to{' '}
              <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">.mcp.json</code> in
              your project root:
            </p>
            <div className="rounded-lg bg-muted/50 p-2">
              <code className="break-all font-mono text-xs text-muted-foreground">
                https://mcp.trace-flow.dev/mcp
              </code>
            </div>
          </div>

          {/* Cursor */}
          <div className="rounded-xl border border-border/50 bg-card/50 p-5">
            <div className="mb-3 flex items-center gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-[oklch(0.7_0.15_262)]/10 text-[oklch(0.7_0.15_262)]">
                <MousePointer2 className="h-4 w-4" />
              </div>
              <h3 className="font-semibold text-foreground">Cursor</h3>
            </div>
            <p className="mb-3 text-sm text-muted-foreground">
              Add to your MCP settings in{' '}
              <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">
                ~/.cursor/mcp.json
              </code>
              :
            </p>
            <div className="rounded-lg bg-muted/50 p-2">
              <code className="break-all font-mono text-xs text-muted-foreground">
                https://mcp.trace-flow.dev/mcp
              </code>
            </div>
          </div>

          {/* Other */}
          <div className="rounded-xl border border-border/50 bg-card/50 p-5">
            <div className="mb-3 flex items-center gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <Box className="h-4 w-4" />
              </div>
              <h3 className="font-semibold text-foreground">Other MCP Clients</h3>
            </div>
            <p className="text-sm text-muted-foreground">
              Any MCP-compatible client can connect via HTTP. Use the endpoint URL in your
              client&apos;s MCP configuration.
            </p>
          </div>
        </div>
      </div>

      {/* Configuration */}
      <div className="mb-12 animate-fade-in" style={{ animationDelay: '200ms' }}>
        <h2 className="mb-4 text-sm font-medium uppercase tracking-wider text-muted-foreground">
          Configuration
        </h2>
        <p className="mb-4 text-muted-foreground">Add this to your MCP configuration file:</p>
        <CodeBlock code={CLAUDE_CODE_CONFIG} lang="json" />
        <div className="mt-4 rounded-lg border border-border/50 bg-card/30 p-4">
          <p className="text-sm text-muted-foreground">
            <strong className="text-foreground">First-time setup:</strong> When your agent first
            uses the MCP server, you&apos;ll be prompted to authenticate via OAuth. This links the
            MCP server to your Trace Flow account.
          </p>
        </div>
      </div>

      {/* Available Tools */}
      <div className="space-y-12">
        <section className="animate-fade-in" style={{ animationDelay: '250ms' }}>
          <div className="mb-6 flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-[oklch(0.7_0.18_280)]/10 text-lg font-bold text-[oklch(0.7_0.18_280)]">
              1
            </div>
            <h2 className="text-xl font-semibold tracking-tight text-foreground">list_traces</h2>
          </div>
          <p className="mb-4 text-muted-foreground">
            Query recent LLM traces with optional filtering by provider, model, or status. Returns
            paginated results.
          </p>

          {/* Parameters Table */}
          <div className="mb-6 rounded-xl border border-border/50 bg-card/50 p-6">
            <h3 className="mb-4 text-sm font-medium uppercase tracking-wider text-muted-foreground">
              Parameters
            </h3>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border/50 text-left">
                    <th className="pb-3 font-medium text-muted-foreground">Parameter</th>
                    <th className="pb-3 font-medium text-muted-foreground">Type</th>
                    <th className="pb-3 font-medium text-muted-foreground">Description</th>
                  </tr>
                </thead>
                <tbody className="font-mono text-xs">
                  <tr className="border-b border-border/30">
                    <td className="py-3 text-[oklch(0.7_0.18_280)]">provider</td>
                    <td className="py-3 text-muted-foreground">string</td>
                    <td className="py-3 font-sans text-foreground">
                      Filter by AI provider (openai, anthropic, google)
                    </td>
                  </tr>
                  <tr className="border-b border-border/30">
                    <td className="py-3 text-[oklch(0.7_0.18_280)]">model</td>
                    <td className="py-3 text-muted-foreground">string</td>
                    <td className="py-3 font-sans text-foreground">
                      Filter by model name (gpt-4o, claude-sonnet-4-20250514)
                    </td>
                  </tr>
                  <tr className="border-b border-border/30">
                    <td className="py-3 text-[oklch(0.7_0.18_280)]">status</td>
                    <td className="py-3 text-muted-foreground">enum</td>
                    <td className="py-3 font-sans text-foreground">
                      STATUS_CODE_OK or STATUS_CODE_ERROR
                    </td>
                  </tr>
                  <tr className="border-b border-border/30">
                    <td className="py-3 text-[oklch(0.7_0.18_280)]">hours</td>
                    <td className="py-3 text-muted-foreground">number</td>
                    <td className="py-3 font-sans text-foreground">
                      Look back period in hours (default 24, max 168)
                    </td>
                  </tr>
                  <tr className="border-b border-border/30">
                    <td className="py-3 text-[oklch(0.7_0.18_280)]">limit</td>
                    <td className="py-3 text-muted-foreground">number</td>
                    <td className="py-3 font-sans text-foreground">
                      Max results to return (default 10, max 25)
                    </td>
                  </tr>
                  <tr>
                    <td className="py-3 text-[oklch(0.7_0.18_280)]">cursor</td>
                    <td className="py-3 text-muted-foreground">string</td>
                    <td className="py-3 font-sans text-foreground">
                      Pagination cursor from previous response
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          <h4 className="mb-3 text-sm font-medium text-muted-foreground">Example Response</h4>
          <CodeBlock code={LIST_TRACES_RESPONSE} lang="json" />
        </section>

        <section className="animate-fade-in" style={{ animationDelay: '300ms' }}>
          <div className="mb-6 flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-[oklch(0.7_0.18_280)]/10 text-lg font-bold text-[oklch(0.7_0.18_280)]">
              2
            </div>
            <h2 className="text-xl font-semibold tracking-tight text-foreground">get_trace</h2>
          </div>
          <p className="mb-4 text-muted-foreground">
            Get detailed information about a specific trace including all spans, tokens, costs, and
            timing.
          </p>

          {/* Parameters Table */}
          <div className="mb-6 rounded-xl border border-border/50 bg-card/50 p-6">
            <h3 className="mb-4 text-sm font-medium uppercase tracking-wider text-muted-foreground">
              Parameters
            </h3>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border/50 text-left">
                    <th className="pb-3 font-medium text-muted-foreground">Parameter</th>
                    <th className="pb-3 font-medium text-muted-foreground">Type</th>
                    <th className="pb-3 font-medium text-muted-foreground">Description</th>
                  </tr>
                </thead>
                <tbody className="font-mono text-xs">
                  <tr>
                    <td className="py-3 text-[oklch(0.7_0.18_280)]">trace_id</td>
                    <td className="py-3 text-muted-foreground">string</td>
                    <td className="py-3 font-sans text-foreground">
                      <strong className="text-primary">Required.</strong> 32-character hex trace ID
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          <h4 className="mb-3 text-sm font-medium text-muted-foreground">Example Response</h4>
          <CodeBlock code={GET_TRACE_RESPONSE} lang="json" />
        </section>
      </div>

      {/* Usage Examples */}
      <div className="mt-16 animate-fade-in" style={{ animationDelay: '350ms' }}>
        <h2 className="mb-6 text-sm font-medium uppercase tracking-wider text-muted-foreground">
          Usage Examples
        </h2>

        <div className="space-y-6">
          {/* Example 1 */}
          <div className="rounded-xl border border-border/50 bg-card/30 p-6">
            <div className="mb-4 flex items-center gap-3">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[oklch(0.7_0.2_25)]/10 text-[oklch(0.7_0.2_25)]">
                <AlertTriangle className="h-4 w-4" />
              </div>
              <h3 className="font-semibold text-foreground">Find Recent Errors</h3>
            </div>
            <p className="mb-4 text-sm text-muted-foreground">
              Ask your agent to find failed LLM calls in the last hour:
            </p>
            <div className="rounded-lg bg-muted/50 p-4">
              <p className="font-mono text-sm text-foreground">
                &quot;Use list_traces with status STATUS_CODE_ERROR and hours=1 to find any failed
                LLM requests&quot;
              </p>
            </div>
          </div>

          {/* Example 2 */}
          <div className="rounded-xl border border-border/50 bg-card/30 p-6">
            <div className="mb-4 flex items-center gap-3">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[oklch(0.7_0.18_145)]/10 text-[oklch(0.7_0.18_145)]">
                <PenLine className="h-4 w-4" />
              </div>
              <h3 className="font-semibold text-foreground">Analyze a Specific Trace</h3>
            </div>
            <p className="mb-4 text-sm text-muted-foreground">
              Get detailed cost and token breakdown for a trace:
            </p>
            <div className="rounded-lg bg-muted/50 p-4">
              <p className="font-mono text-sm text-foreground">
                &quot;Get the trace details for a1b2c3d4... and tell me how many tokens it used and
                what it cost&quot;
              </p>
            </div>
          </div>

          {/* Example 3: Workflow */}
          <div className="rounded-xl border border-[oklch(0.7_0.18_280)]/30 bg-[oklch(0.7_0.18_280)]/5 p-6">
            <div className="mb-4 flex items-center gap-3">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[oklch(0.7_0.18_280)]/20 text-[oklch(0.7_0.18_280)]">
                <Activity className="h-4 w-4" />
              </div>
              <h3 className="font-semibold text-foreground">Debug Workflow</h3>
            </div>
            <p className="mb-4 text-sm text-muted-foreground">
              A typical debugging session using both tools:
            </p>
            <ol className="space-y-3 text-sm">
              <li className="flex items-start gap-3">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[oklch(0.7_0.18_280)]/20 text-xs font-bold text-[oklch(0.7_0.18_280)]">
                  1
                </span>
                <span className="text-foreground">
                  <strong>list_traces</strong> — Find recent traces, optionally filtering by
                  provider or status
                </span>
              </li>
              <li className="flex items-start gap-3">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[oklch(0.7_0.18_280)]/20 text-xs font-bold text-[oklch(0.7_0.18_280)]">
                  2
                </span>
                <span className="text-foreground">
                  <strong>get_trace</strong> — Get detailed spans, timing, tokens, and costs for a
                  specific trace
                </span>
              </li>
              <li className="flex items-start gap-3">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[oklch(0.7_0.18_280)]/20 text-xs font-bold text-[oklch(0.7_0.18_280)]">
                  3
                </span>
                <span className="text-foreground">
                  <strong>Analyze</strong> — Your agent can now explain what happened, identify
                  issues, and suggest fixes
                </span>
              </li>
            </ol>
          </div>
        </div>
      </div>

      {/* Tips */}
      <div className="mt-12 animate-fade-in" style={{ animationDelay: '400ms' }}>
        <div className="rounded-xl border border-primary/20 bg-primary/5 p-6">
          <h3 className="mb-4 text-sm font-medium uppercase tracking-wider text-primary">Tips</h3>
          <ul className="space-y-3 text-sm text-foreground">
            <li className="flex items-start gap-3">
              <div className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
              <span>
                <strong>OAuth authentication:</strong> First-time use triggers an OAuth flow. Sign
                in with your Trace Flow account to authorize the MCP server.
              </span>
            </li>
            <li className="flex items-start gap-3">
              <div className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
              <span>
                <strong>Auto-refresh:</strong> Access tokens refresh automatically. You only need to
                authenticate once per device.
              </span>
            </li>
            <li className="flex items-start gap-3">
              <div className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
              <span>
                <strong>Filter early:</strong> Use provider, model, or status filters in list_traces
                to reduce noise and find relevant traces faster.
              </span>
            </li>
            <li className="flex items-start gap-3">
              <div className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
              <span>
                <strong>Pagination:</strong> Results are paginated. Use the cursor from the response
                to fetch more traces if needed.
              </span>
            </li>
          </ul>
        </div>
      </div>

      {/* Next Steps */}
      <div className="mt-12 animate-fade-in" style={{ animationDelay: '450ms' }}>
        <h2 className="mb-6 text-sm font-medium uppercase tracking-wider text-muted-foreground">
          Next Steps
        </h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Link href="/docs/agents" className="group">
            <div className="relative flex h-full flex-col rounded-xl border border-border/50 bg-card/50 p-5 transition-all duration-200 hover:border-primary/30 hover:bg-card">
              <h3 className="mb-1 font-semibold text-foreground">AI Agents</h3>
              <p className="text-sm text-muted-foreground">Gateway integration guide</p>
            </div>
          </Link>
          <Link href="/docs/quick-start" className="group">
            <div className="relative flex h-full flex-col rounded-xl border border-border/50 bg-card/50 p-5 transition-all duration-200 hover:border-primary/30 hover:bg-card">
              <h3 className="mb-1 font-semibold text-foreground">Quick Start</h3>
              <p className="text-sm text-muted-foreground">Send traces to Trace Flow</p>
            </div>
          </Link>
          <Link href="/docs/sdk-reference" className="group">
            <div className="relative flex h-full flex-col rounded-xl border border-border/50 bg-card/50 p-5 transition-all duration-200 hover:border-primary/30 hover:bg-card">
              <h3 className="mb-1 font-semibold text-foreground">SDK Reference</h3>
              <p className="text-sm text-muted-foreground">Provider examples</p>
            </div>
          </Link>
          <Link href="/docs/opentelemetry" className="group">
            <div className="relative flex h-full flex-col rounded-xl border border-border/50 bg-card/50 p-5 transition-all duration-200 hover:border-primary/30 hover:bg-card">
              <h3 className="mb-1 font-semibold text-foreground">OpenTelemetry</h3>
              <p className="text-sm text-muted-foreground">Custom spans and traces</p>
            </div>
          </Link>
        </div>
      </div>
    </>
  );
}
