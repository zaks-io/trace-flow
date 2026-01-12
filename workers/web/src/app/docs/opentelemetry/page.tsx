import { CodeBlock } from '@/components/docs/CodeBlock';
import { Layers, Link2 } from 'lucide-react';

const INSTALL_CODE = `npm install @opentelemetry/api @opentelemetry/sdk-trace-base \\
  @opentelemetry/exporter-trace-otlp-http \\
  @opentelemetry/resources @opentelemetry/semantic-conventions`;

const SETUP_CODE = `import { trace, context, SpanStatusCode } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { Resource } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";

// Initialize once at module level
const exporter = new OTLPTraceExporter({
  url: "https://gateway.trace-flow.dev/v1/traces",
  headers: { "X-Trace-Flow-Api-Key": process.env.TRACE_FLOW_API_KEY! },
});

const provider = new BasicTracerProvider({
  resource: new Resource({ [ATTR_SERVICE_NAME]: "my-service" }),
});

// SimpleSpanProcessor sends immediately (ideal for serverless)
provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
provider.register();

export const tracer = trace.getTracer("my-service");`;

const SPANS_CODE = `async function handleRequest(request: Request) {
  // Create root span
  const rootSpan = tracer.startSpan("handle-request");

  return context.with(trace.setSpan(context.active(), rootSpan), async () => {
    // Add user events to the span
    rootSpan.addEvent("user.click", { button: "submit" });

    // Child spans are automatically linked via context
    const httpSpan = tracer.startSpan("fetch-data");
    const data = await fetch("/api/data");
    httpSpan.setAttribute("http.status_code", data.status);
    httpSpan.end();

    // Another child span for LLM call
    const llmSpan = tracer.startSpan("llm-call");
    llmSpan.setAttribute("gen_ai.request.model", "gpt-4");
    llmSpan.setAttribute("gen_ai.system", "openai");
    // ... make LLM call
    llmSpan.end();

    rootSpan.setStatus({ code: SpanStatusCode.OK });
    rootSpan.end();

    return new Response("OK");
  });
}`;

const FLUSH_CODE = `export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const response = await handleRequest(request);

    // Force flush before worker terminates
    ctx.waitUntil(provider.forceFlush());

    return response;
  },
};`;

const LINK_PROXY_CODE = `import { trace, context, propagation } from "@opentelemetry/api";
import { generateText } from "ai";
import { createOpenAI } from "@ai-sdk/openai";

const openai = createOpenAI({
  baseURL: "https://gateway.trace-flow.dev/openai/v1",
  apiKey: process.env.OPENAI_API_KEY,
  headers: {
    "X-Trace-Flow-Api-Key": process.env.TRACE_FLOW_API_KEY!,
  },
});

async function handleUserRequest(userMessage: string) {
  const parentSpan = tracer.startSpan("handle-user-request");

  return context.with(trace.setSpan(context.active(), parentSpan), async () => {
    // Track events before LLM call
    parentSpan.addEvent("message.received", {
      "message.length": userMessage.length,
    });

    // Inject W3C trace context headers automatically
    const traceHeaders: Record<string, string> = {};
    propagation.inject(context.active(), traceHeaders);
    // traceHeaders now contains { traceparent: "00-...", tracestate: "..." }

    // LLM call becomes part of this trace
    const result = await generateText({
      model: openai("gpt-5"),
      prompt: userMessage,
      headers: {
        ...traceHeaders,  // W3C traceparent & tracestate
        baggage: "session_id=abc123,user_id=user-456",  // optional context
      },
    });

    parentSpan.end();
    return result.text;
  });
}`;

const ENDPOINT_EXAMPLE = `curl -X POST https://gateway.trace-flow.dev/v1/traces \\
  -H "X-Trace-Flow-Api-Key: your-api-key" \\
  -H "Content-Type: application/json" \\
  -d '{
    "resourceSpans": [{
      "resource": {
        "attributes": [{"key": "service.name", "value": {"stringValue": "my-service"}}]
      },
      "scopeSpans": [{
        "spans": [{
          "traceId": "abc123...",
          "spanId": "def456...",
          "name": "my-operation",
          "startTimeUnixNano": "1234567890000000000",
          "endTimeUnixNano": "1234567891000000000"
        }]
      }]
    }]
  }'`;

export default function OpenTelemetryPage() {
  return (
    <>
      {/* Hero */}
      <div className="mb-16 animate-fade-in">
        <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-primary/20 bg-primary/5 px-3 py-1">
          <Layers className="h-3.5 w-3.5 text-primary" />
          <span className="font-mono text-xs text-primary">OpenTelemetry</span>
        </div>
        <h1 className="mb-4 text-4xl font-bold tracking-tight text-foreground sm:text-5xl">
          Custom Traces & Events
        </h1>
        <p className="max-w-2xl text-lg text-muted-foreground">
          Set up your own OpenTelemetry tracer to add custom spans, events, and attributes. Create
          rich traces that show your entire application flow alongside LLM calls.
        </p>
      </div>

      {/* Span hierarchy visualization */}
      <div className="mb-16 animate-fade-in" style={{ animationDelay: '100ms' }}>
        <div className="rounded-xl border border-border/50 bg-card/50 p-6">
          <h3 className="mb-4 text-sm font-medium uppercase tracking-wider text-muted-foreground">
            Span Hierarchy
          </h3>
          <div className="font-mono text-sm">
            <div className="text-foreground">
              <span className="text-primary">Trace</span>
              <span className="text-muted-foreground"> (traceId)</span>
            </div>
            <div className="ml-4 border-l border-border/50 pl-4">
              <div className="relative">
                <div className="absolute -left-[17px] top-3 h-px w-3 bg-border/50" />
                <div className="text-foreground">
                  Root Span
                  <span className="text-xs text-muted-foreground"> (no parent)</span>
                </div>
              </div>
              <div className="ml-4 border-l border-border/50 pl-4">
                <div className="relative">
                  <div className="absolute -left-[17px] top-3 h-px w-3 bg-border/50" />
                  <div className="text-[oklch(0.7_0.18_145)]">
                    HTTP Call
                    <span className="text-xs text-muted-foreground"> (child of root)</span>
                  </div>
                </div>
                <div className="relative">
                  <div className="absolute -left-[17px] top-3 h-px w-3 bg-border/50" />
                  <div className="text-[oklch(0.7_0.15_262)]">
                    LLM Call
                    <span className="text-xs text-muted-foreground"> (child of root)</span>
                  </div>
                </div>
                <div className="ml-4 border-l border-border/50 pl-4">
                  <div className="relative">
                    <div className="absolute -left-[17px] top-3 h-px w-3 bg-border/50" />
                    <div className="text-[oklch(0.75_0.12_50)]">
                      Tool Call
                      <span className="text-xs text-muted-foreground"> (child of LLM Call)</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Sections */}
      <div className="space-y-16">
        {/* Install */}
        <section className="animate-fade-in" style={{ animationDelay: '150ms' }}>
          <div className="mb-6 flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-lg font-bold text-primary">
              1
            </div>
            <h2 className="text-xl font-semibold tracking-tight text-foreground">
              Install Dependencies
            </h2>
          </div>
          <CodeBlock code={INSTALL_CODE} lang="bash" />
        </section>

        {/* Setup */}
        <section className="animate-fade-in" style={{ animationDelay: '200ms' }}>
          <div className="mb-6 flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-lg font-bold text-primary">
              2
            </div>
            <h2 className="text-xl font-semibold tracking-tight text-foreground">
              Initialize the Tracer
            </h2>
          </div>
          <p className="mb-4 text-muted-foreground">
            Initialize the OpenTelemetry provider once at module level. Use{' '}
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-sm text-foreground">
              SimpleSpanProcessor
            </code>{' '}
            for serverless environments—it sends spans immediately without batching.
          </p>
          <CodeBlock code={SETUP_CODE} lang="typescript" />
        </section>

        {/* Spans */}
        <section className="animate-fade-in" style={{ animationDelay: '250ms' }}>
          <div className="mb-6 flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-lg font-bold text-primary">
              3
            </div>
            <h2 className="text-xl font-semibold tracking-tight text-foreground">
              Create Hierarchical Spans
            </h2>
          </div>
          <p className="mb-4 text-muted-foreground">
            Use{' '}
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-sm text-foreground">
              context.with()
            </code>{' '}
            to establish parent-child relationships. Child spans created within the context
            automatically inherit the parent span ID.
          </p>
          <CodeBlock code={SPANS_CODE} lang="typescript" />
        </section>

        {/* Link Proxy Requests */}
        <section className="animate-fade-in" style={{ animationDelay: '300ms' }}>
          <div className="mb-6 flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-lg font-bold text-primary">
              4
            </div>
            <h2 className="text-xl font-semibold tracking-tight text-foreground">
              Link LLM Proxy Requests
            </h2>
          </div>
          <p className="mb-4 text-muted-foreground">
            Connect LLM proxy requests to your traces using W3C Trace Context headers. The OTEL SDK
            injects these automatically via{' '}
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-sm text-foreground">
              propagation.inject()
            </code>
            .
          </p>
          <div className="mb-6 overflow-hidden rounded-lg border border-border/50">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border/50 bg-card/30 text-left">
                  <th className="px-4 py-2 font-medium text-muted-foreground">Header</th>
                  <th className="px-4 py-2 font-medium text-muted-foreground">Format</th>
                  <th className="px-4 py-2 font-medium text-muted-foreground">Purpose</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/50">
                <tr>
                  <td className="px-4 py-2 font-mono text-foreground">traceparent</td>
                  <td className="px-4 py-2 font-mono text-muted-foreground">
                    00-&#123;traceId&#125;-&#123;spanId&#125;-&#123;flags&#125;
                  </td>
                  <td className="px-4 py-2 text-muted-foreground">
                    W3C trace context with parent span ID
                  </td>
                </tr>
                <tr className="bg-card/30">
                  <td className="px-4 py-2 font-mono text-foreground">tracestate</td>
                  <td className="px-4 py-2 font-mono text-muted-foreground">vendor=value,...</td>
                  <td className="px-4 py-2 text-muted-foreground">
                    Vendor-specific trace context (optional)
                  </td>
                </tr>
                <tr>
                  <td className="px-4 py-2 font-mono text-foreground">baggage</td>
                  <td className="px-4 py-2 font-mono text-muted-foreground">key=value,...</td>
                  <td className="px-4 py-2 text-muted-foreground">
                    Custom context propagated as span attributes
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <CodeBlock code={LINK_PROXY_CODE} lang="typescript" />
        </section>

        {/* Flush */}
        <section className="animate-fade-in" style={{ animationDelay: '350ms' }}>
          <div className="mb-6 flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-lg font-bold text-primary">
              5
            </div>
            <h2 className="text-xl font-semibold tracking-tight text-foreground">
              Serverless Flush Pattern
            </h2>
          </div>
          <p className="mb-4 text-muted-foreground">
            In serverless environments like Cloudflare Workers, always flush traces before the
            function terminates. Use{' '}
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-sm text-foreground">
              waitUntil()
            </code>{' '}
            to avoid blocking the response.
          </p>
          <CodeBlock code={FLUSH_CODE} lang="typescript" />
        </section>

        {/* Endpoint Reference */}
        <section className="animate-fade-in" style={{ animationDelay: '400ms' }}>
          <div className="mb-6 flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Link2 className="h-5 w-5" />
            </div>
            <h2 className="text-xl font-semibold tracking-tight text-foreground">
              Endpoint Reference
            </h2>
          </div>
          <p className="mb-4 text-muted-foreground">
            Send traces directly to the OTLP/HTTP JSON endpoint.
          </p>
          <div className="mb-6 overflow-hidden rounded-lg border border-border/50">
            <table className="w-full text-sm">
              <tbody className="divide-y divide-border/50">
                <tr className="bg-card/30">
                  <td className="px-4 py-2 font-medium text-muted-foreground">Method</td>
                  <td className="px-4 py-2 font-mono text-foreground">POST</td>
                </tr>
                <tr>
                  <td className="px-4 py-2 font-medium text-muted-foreground">URL</td>
                  <td className="px-4 py-2 font-mono text-foreground">
                    https://gateway.trace-flow.dev/v1/traces
                  </td>
                </tr>
                <tr className="bg-card/30">
                  <td className="px-4 py-2 font-medium text-muted-foreground">Auth Header</td>
                  <td className="px-4 py-2 font-mono text-foreground">
                    X-Trace-Flow-Api-Key: &lt;your-key&gt;
                  </td>
                </tr>
                <tr>
                  <td className="px-4 py-2 font-medium text-muted-foreground">Content-Type</td>
                  <td className="px-4 py-2 font-mono text-foreground">application/json</td>
                </tr>
                <tr className="bg-card/30">
                  <td className="px-4 py-2 font-medium text-muted-foreground">Max Size</td>
                  <td className="px-4 py-2 font-mono text-foreground">10MB</td>
                </tr>
              </tbody>
            </table>
          </div>
          <CodeBlock code={ENDPOINT_EXAMPLE} lang="bash" />
        </section>
      </div>

      {/* Key points */}
      <div className="mt-16 animate-fade-in">
        <div className="rounded-xl border border-primary/20 bg-primary/5 p-6">
          <h3 className="mb-4 text-sm font-medium uppercase tracking-wider text-primary">
            Key Points
          </h3>
          <ul className="space-y-3 text-sm text-foreground">
            <li className="flex items-start gap-3">
              <div className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
              <span>
                <strong>W3C Trace Context compliant</strong> — uses standard{' '}
                <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">traceparent</code>{' '}
                and <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">baggage</code>{' '}
                headers
              </span>
            </li>
            <li className="flex items-start gap-3">
              <div className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
              <span>
                <strong>Parent spans work automatically</strong> — OTEL SDK&apos;s{' '}
                <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">
                  propagation.inject()
                </code>{' '}
                adds trace context headers
              </span>
            </li>
            <li className="flex items-start gap-3">
              <div className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
              <span>
                <strong>Baggage propagates context</strong> — custom key-value pairs appear as{' '}
                <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">baggage.*</code>{' '}
                span attributes
              </span>
            </li>
            <li className="flex items-start gap-3">
              <div className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
              <span>
                <strong>Use SimpleSpanProcessor</strong> for serverless (sends immediately)
              </span>
            </li>
            <li className="flex items-start gap-3">
              <div className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
              <span>
                <strong>Call forceFlush()</strong> in{' '}
                <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">waitUntil()</code>{' '}
                before function exits
              </span>
            </li>
          </ul>
        </div>
      </div>
    </>
  );
}
