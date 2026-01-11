import Link from 'next/link';

export default function DocsIndexPage() {
  return (
    <div>
      <h1 className="mb-6 text-3xl font-bold">Documentation</h1>
      <p className="mb-8 text-lg text-muted-foreground">
        Learn how to integrate Trace Flow into your LLM applications.
      </p>

      <div className="grid gap-4 sm:grid-cols-2">
        <Link
          href="/docs/quick-start"
          className="rounded-lg border border-border p-6 transition-colors hover:bg-accent"
        >
          <h3 className="mb-2 font-semibold">Quick Start</h3>
          <p className="text-sm text-muted-foreground">
            Get up and running with Trace Flow in minutes.
          </p>
        </Link>

        <Link
          href="/docs/sdk-reference"
          className="rounded-lg border border-border p-6 transition-colors hover:bg-accent"
        >
          <h3 className="mb-2 font-semibold">SDK Reference</h3>
          <p className="text-sm text-muted-foreground">
            Complete API documentation for the Trace Flow SDK.
          </p>
        </Link>

        <Link
          href="/docs/opentelemetry"
          className="rounded-lg border border-border p-6 transition-colors hover:bg-accent"
        >
          <h3 className="mb-2 font-semibold">OpenTelemetry</h3>
          <p className="text-sm text-muted-foreground">
            Send traces using standard OpenTelemetry protocols.
          </p>
        </Link>

        <Link
          href="/docs/agents"
          className="rounded-lg border border-border p-6 transition-colors hover:bg-accent"
        >
          <h3 className="mb-2 font-semibold">AI Agents</h3>
          <p className="text-sm text-muted-foreground">
            Integrate Trace Flow with AI agent frameworks.
          </p>
        </Link>
      </div>
    </div>
  );
}
