# Trace Flow

Model API and coding-agent observability on Cloudflare Workers.

## Commands

Run from the repo root. Use the package's name from its `package.json` for scoped checks.

| Task                              | Command                                |
| --------------------------------- | -------------------------------------- |
| Install dependencies              | `bun install --frozen-lockfile`        |
| Start Web for Cloud-Dev           | `bun run dev:web`                      |
| Lint / types                      | `bun run lint` / `bun run type-check`  |
| Test all / watch                  | `bun run test` / `bun run test:watch`  |
| Test one package                  | `bun run --filter <package-name> test` |
| Check formatting for edited files | `bun run prettier --check <files>`     |
| Full local CI gate                | `bun run ci:check`                     |
| Deploy development Workers        | `bun run deploy:dev`                   |

Other scripts, bindings, and environment values belong in `package.json` and each app's
`wrangler.toml` or `wrangler.jsonc`. Read those instead of maintaining copies here.

## Environment and delivery

- Use Cloud-Dev for everyday development. Only Web runs locally; Workers, Convex, and
  data are in the cloud. The setup scripts default to Self-Contained Local, which is
  for explicit local/CI/Cursor work. Do not start that stack for Cloud-Dev.
- Collectors embed production defaults. Set `TRACE_FLOW_INGEST_URL` and
  `TRACE_FLOW_CONVEX_SITE_URL` to cloud-dev endpoints before CLI or desktop testing.
  See [SETUP.md](SETUP.md) and [endpoint reference](CONTEXT.md#concrete-endpoints-canonical--stop-rediscovering-these).
- Never deploy production manually. Production changes require explicit approval;
  GitHub Actions deploys on merge to `main`. PR previews are automatic.
- Agent Conversation Analytics is not production-ready until its
  [roadmap gates](docs/guides/agent-conversation-analytics/ROADMAP.md) are complete.
  `apps/archive-api` is disabled development work with no production environment.

## Rules that prevent regressions

- Consume both branches of every stream `tee()` or the Worker can hang.
- Captured responses must persist the encrypted `trace-deliveries/` envelope before
  terminal EOF. Use `waitUntil()` for queue publication and recovery, not to defer
  that durability gate. Consumers copy bodies to `bodies/${requestId}`, durably
  stage spans, and finish envelope handoff before `message.ack()`.
- Keep Collector Credentials separate from Proxy API keys. `apps/pipes-api` must
  never bind body credentials or `TINYBIRD_ADMIN_TOKEN`; `apps/api` must not forward
  Tinybird Pipes. Never expose admin tokens to the frontend.
- Queue tracing travels in `sentry_trace_context`. Match `enableRpcTracePropagation`
  on Worker and Durable Object RPC endpoints. Set `tracePropagationTargets` so
  trace headers never reach providers, Tinybird, or Convex.
- Test behavior, not HTML strings or component source. Verify UI changes in the
  running app. Use pure-function tests for parsers, reducers, and formatters.
- Comments explain why. Keep code self-documenting.

For desktop changes, preserve these macOS and persistence constraints:

- Only prevent `ExitRequested` when its code is `None`, or tray Quit stops working.
- LaunchAgent plists need `AssociatedBundleIdentifiers`. Verify Login Items with
  `sfltool dumpbtm`, not `osascript`. Logging uses `TRACE_FLOW_LOG`.
- Persist sync authorization in `settings.json`; resume incremental scans from
  `last_complete_sync_at_ms`. CI builds release bundles.

## Read when relevant

- Finding code: [repo navigation](docs/agents/repo-navigation.md).
- Domain language and design decisions: [CONTEXT.md](CONTEXT.md) and [ADRs](docs/adr/).
- Implementation, tracker, PR, or orchestration work: read
  [workflow config](docs/agents/workflow/config.md) before using `ziw-*` skills.
- Before any commit or PR: run local `ziw-code-review` and read
  [review invariants](docs/agents/review-invariants.md). The durability rule above
  supersedes that file's older instruction to defer all R2 storage with `waitUntil()`.
  CodeRabbit is on-demand only for high-risk changes under the review rubric.
- Collector or desktop work: [analytics guide](docs/guides/agent-conversation-analytics/README.md)
  and [desktop guide](apps/desktop/README.md).

## Maintaining agent instructions

Keep shared instructions in `AGENTS.md`, `docs/agents/`, and `.agents/skills/`.
`CLAUDE.md` imports this file; do not add Claude-specific skill symlinks.
Restart the relevant agent session after changing its config or hooks.

Keep this file short. Add only recurring commands and non-obvious constraints that
prevent mistakes. Put durable details in the relevant existing guide; do not append
session logs, code inventories, or configuration copies here.
