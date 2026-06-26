# Trace Flow Analyst runs in Convex with external code execution

Trace Flow Analyst will use Convex Agents for the Analyst Runtime instead of a separate Analyst API Worker. Convex already owns users, orgs, Tinybird token minting, rate limiting, and reactive Web integration, so keeping threads, messages, tool orchestration, model usage, and OpenRouter calls there removes a deployment unit without weakening the existing data-access boundary.

The Web app should call Convex directly for Analyst threads, messages, actions, and reactive streaming state. Do not add a Trace Flow Analyst HTTP API in front of Convex for the Web surface; reserve HTTP actions for future non-Web clients that cannot use the Convex client.

Trace Flow should keep its own Analyst Thread record that references the Convex Agent thread and carries product ownership data such as owning org, creator, status, title/listing metadata, and audit metadata. Convex Agents should own message mechanics; Trace Flow should own which conversations exist and who can revisit them. Analyst Threads are private to their creator, and past messages behave like normal saved conversation history. New messages and Analyst Tool calls always use the current user's current Trace Flow permissions.

Untrusted code execution stays outside Convex as an Analyst-only Tool backed by Cloudflare Sandbox. Convex may orchestrate the tool call, but Python, pandas, NumPy, file writes, subprocesses, and sandbox lifecycle management belong in the Sandbox worker boundary.

The Analyst Runtime should reuse Trace Flow Tool implementations through `@trace-flow/mcp-core`, not through MCP transport. Tool exposure is explicit per surface: a Trace Flow Tool can opt into MCP, Analyst, or both, and future tools must not auto-expose across surfaces. Existing read-only trace, usage, and agent-analytics tools should opt into both surfaces, while code execution starts as Analyst-only. OpenRouter requests should use stable per-thread routing and prompt-caching controls wherever the chosen model/provider supports them.
