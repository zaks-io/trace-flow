# Trace Flow Analyst runs in Convex with external code execution

## Decision update, 2026-10-09

Isaac decided to remove the Analyst sandbox container. This update supersedes the
external code-execution and sandbox-run decisions below. The Analyst Runtime runs in
Convex and exposes the existing `@trace-flow/mcp-core` Analyst tool definitions. It
executes those tools through `runTraceFlowTool` with the current user's active
membership, Pro entitlement, and unexpired scoped keys. MCP tool definitions and
outputs remain unchanged. Chat model usage and cost accounting remain in Convex.

Code, CI, preview, and deploy no longer run the sandbox Worker, container, or Pi agent.
Existing sandbox table schemas remain until their production documents can be cleared;
organization deletion still removes existing sandbox rows. The removal also stops
explicit organization backup erasure and all new backup writes.

Every prior backup has a `snapshots/<orgId>/...` key. Keep the backup bucket lifecycle
configuration and the verified `expire-analyst-snapshots-7d` rule on `snapshots/` until
bucket deletion. Prior backups expire within seven days after writers stop. An
organization deleted within seven days after this deploy can retain its prior Analyst
backups until lifecycle expiry. This residual follows the expiry approach for delivery
orphans in [ADR 0024](0024-bounded-agent-ingestion.md).

Production cleanup requires Isaac's separate approval: delete the deployed
`analyst-sandbox` Worker and container image, delete the backup buckets after seven
days, clear sandbox Convex table documents, and remove the unused `ANALYST_SANDBOX_*`
Convex environment values. This code change performs none of those production actions.

## Original decision

Trace Flow Analyst requires an active Pro subscription and is not available on Hobby because its model calls incur inference costs. The Web app hides Analyst for other subscriptions, and the backend enforces entitlement before new inference and sandbox work. Downgrades block subsequent model requests; an in-flight request may finish, and completion callbacks and cancellation remain authorized by the existing ownership and run-token checks. See [Analyst entitlement](../../packages/convex/analyst.ts), [sandbox authorization](../../packages/convex/analystSandbox.ts), and [the provider proxy](../../apps/analyst-sandbox/src/index.ts).

Trace Flow Analyst will use Convex Agents for the Analyst Runtime instead of a separate Analyst API Worker. Convex already owns users, orgs, Tinybird token minting, rate limiting, and reactive Web integration, so keeping threads, messages, tool orchestration, model usage, and OpenRouter calls there removes a deployment unit without weakening the existing data-access boundary.

The Web app should call Convex directly for Analyst threads, messages, actions, and reactive streaming state. Do not add a Trace Flow Analyst HTTP API in front of Convex for the Web surface; reserve HTTP actions for future non-Web clients that cannot use the Convex client.

Trace Flow should keep its own Analyst Thread record that references the Convex Agent thread and carries product ownership data such as owning org, creator, status, title/listing metadata, and audit metadata. Convex Agents should own message mechanics; Trace Flow should own which conversations exist and who can revisit them. Analyst Threads are private to their creator, and past messages behave like normal saved conversation history. New messages and Analyst Tool calls always use the current user's current Trace Flow permissions.

Untrusted code execution stays outside Convex as an Analyst-only Tool backed by Cloudflare Sandbox. Convex may orchestrate the tool call, but Python, pandas, NumPy, file writes, subprocesses, and sandbox lifecycle management belong in the Sandbox worker boundary.

The Analyst Runtime should reuse Trace Flow Tool implementations through `@trace-flow/mcp-core`, not through MCP transport. Tool exposure is explicit per surface: a Trace Flow Tool can opt into MCP, Analyst, or both, and future tools must not auto-expose across surfaces. Existing read-only trace, usage, and agent-analytics tools should opt into both surfaces, while code execution starts as Analyst-only. OpenRouter requests should use stable per-thread routing and prompt-caching controls wherever the chosen model/provider supports them.
