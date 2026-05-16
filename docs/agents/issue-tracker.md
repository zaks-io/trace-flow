# Issue Tracker

Issues for this repo live in **Linear**, accessed via the `claude.ai_Linear` MCP server.

## Team

Default team key: **`TRA`** (issue IDs look like `TRA-123`).

Unless the user names a different team, create and look up issues under `TRA`.

## Authentication

The Linear MCP server exposes only auth tools until connected:

- `mcp__claude_ai_Linear__authenticate`
- `mcp__claude_ai_Linear__complete_authentication`

If you try to list, create, or update issues and the matching tools aren't available, call `authenticate` first and surface the auth URL to the user. After they complete the OAuth flow, the full set of Linear tools (`linear-create-issue`, `linear-update-issue`, `linear-search-issues`, etc.) becomes callable.

## Creating issues

Use the Linear MCP `create-issue` tool. Always set:

- `team` → `TRA`
- `title` → short, imperative
- `description` → markdown body (acceptance criteria, repro steps, links)
- `labels` → see [triage-labels.md](./triage-labels.md) for the canonical strings

For tracer-bullet vertical slices from `/to-issues`, create one Linear issue per slice and link them as related (or as sub-issues of a parent if the user asks for that shape).

## Reading and updating issues

- Look up by ID (`TRA-123`) via the Linear search/get tools.
- When the `triage` skill transitions an issue, update its **labels** (per [triage-labels.md](./triage-labels.md)) and, if applicable, its **state** (`Backlog`, `Todo`, `In Progress`, `Done`, `Cancelled`). Don't assume a state mapping — ask the user once per session if it's unclear.

## When the MCP server is unreachable

Don't silently fall back to GitHub Issues or local markdown. Surface the failure, ask the user to re-authenticate, and pause the workflow. Issues are the source of truth for triage state; writing them somewhere else creates drift.
