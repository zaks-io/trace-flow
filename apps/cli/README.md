# Trace Flow Collector CLI (`trace-flow`)

The command-line collector reads local coding-agent stores, converts them into redacted typed facts,
and syncs those facts to Agent Ingest with a Collector Credential stored in the OS keychain.

Supported sources:

- Claude Code: `~/.claude/projects`
- Codex CLI: `~/.codex/sessions`
- Cursor on macOS: the global `state.vscdb` store, opened read-only through a snapshot

Raw transcripts do not leave the machine through the fact-ingest path.

## Build from source

The tagged CLI installer referenced by the old `/install.sh` route is not currently published. Build
the CLI from this repository, or use the signed desktop app described in
[`apps/desktop/README.md`](../desktop/README.md).

```sh
cargo build -p trace-flow-cli --locked
cargo run -p trace-flow-cli -- sources list
```

## Commands

```text
trace-flow login
trace-flow sources list
trace-flow sync [--since 24h|7d|30d|1y]
trace-flow status
trace-flow disconnect
```

- `login` opens the browser device flow and stores the resulting Collector Credential in the OS
  keychain.
- `sources list` reports supported stores and counts without printing absolute home paths.
- `sync` parses, redacts, and uploads facts. Its default `24h` incremental window resumes from the
  last complete sync watermark so time spent offline is not silently skipped.
- `status` prints connection and source state without secrets.
- `disconnect` revokes local material and removes the org-scoped cursor state.

Production URLs are embedded as defaults:

```sh
trace-flow login
trace-flow sync --since 7d
```

Agent Conversation Analytics is still private-alpha software. A working binary and production
defaults do not establish that the complete normal-user production flow has passed every gate in the
[roadmap](../../docs/guides/agent-conversation-analytics/ROADMAP.md).

## Environment overrides

| Variable                      | Default                                  | Purpose                                           |
| ----------------------------- | ---------------------------------------- | ------------------------------------------------- |
| `TRACE_FLOW_CONVEX_SITE_URL`  | `https://laudable-bison-427.convex.site` | Convex site origin for the browser device flow    |
| `TRACE_FLOW_INGEST_URL`       | `https://collector.trace-flow.dev`       | Agent Ingest origin used by `sync`                |
| `TRACE_FLOW_COLLECTOR_SECRET` | OS keychain                              | Headless or CI credential override                |
| `TRACE_FLOW_STATE_DIR`        | OS application config directory          | Connection state and per-org sync cursor location |

For Cloud-Dev, override both endpoint variables with the deployed cloud `-dev` Agent Ingest origin
and the Convex Cloud dev **site** origin. A bare collector launch targets production. Use
`127.0.0.1:8787` only for the explicitly self-contained local Worker stack; it is not Cloud-Dev.

Copy `.env.example` only as a development starting point. Never commit a Collector Credential.

## Verification

From the repository root:

```sh
cargo fmt --all -- --check
cargo check --workspace --locked
cargo test --workspace --locked
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo run -p trace-flow-cli -- sources list
```

The same Cargo checks are required by `.github/workflows/ci.yml` and the production deploy gate.

## Release workflow

`.github/workflows/cli-release.yml` builds versioned release artifacts from a matching
`trace-flow-cli-v*` tag. The repository currently has the `trace-flow-cli-v0.1.1` tag but no published
GitHub Release asset, which is why public docs must not advertise `/install.sh` as an available
installer.

When publishing a new release, push the version tag first and dispatch the workflow from that tag:

```sh
git tag trace-flow-cli-v0.1.2
git push origin trace-flow-cli-v0.1.2
gh workflow run cli-release.yml --ref trace-flow-cli-v0.1.2 -f tag=trace-flow-cli-v0.1.2
```

Use `tag=dry-run` to build without creating a GitHub Release. Required macOS signing secrets are
`CODESIGN_CERTIFICATE`, `CODESIGN_CERTIFICATE_PASSWORD`, and `CODESIGN_IDENTITY`.
