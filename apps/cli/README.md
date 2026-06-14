# Trace Flow Collector CLI (`trace-flow`)

User-facing collector binary: `login`, `sources list`, `sync`, `status`, `disconnect`.

Install the currently published CLI:

```sh
curl --proto '=https' --tlsv1.2 -sSf https://trace-flow.dev/install.sh | sh
```

Build from the repo root:

```sh
cargo build -p trace-flow-cli
cargo run -p trace-flow-cli -- login
```

## Zero-config production use

`login` and `sync` default to the production Convex site and ingest collector. No environment
variables are required for normal use:

```sh
trace-flow login
trace-flow sync --since 7d
```

The production defaults are wired, but Agent Conversation Analytics is still launch-gated by
`docs/guides/agent-conversation-analytics/ROADMAP.md`. Treat this CLI as the collector path under
verification until the production smoke, dashboard truth states, CI, and observability gates are
green.

## Environment variables

| Variable                      | Required | Default                                  | Purpose                                                    |
| ----------------------------- | -------- | ---------------------------------------- | ---------------------------------------------------------- |
| `TRACE_FLOW_CONVEX_SITE_URL`  | No       | `https://laudable-bison-427.convex.site` | Convex **site** origin for the device login flow           |
| `TRACE_FLOW_INGEST_URL`       | No       | `https://collector.trace-flow.dev`       | Ingest Worker base URL for `sync` POSTs                    |
| `TRACE_FLOW_COLLECTOR_SECRET` | No       | —                                        | Headless/CI override instead of the OS keychain credential |

If set, each variable overrides the production default. Use overrides for **local** or **cloud-dev**
workflows (for example `http://127.0.0.1:8787` for a local ingest Worker, or your cloud-dev Convex
site URL).

Optional state relocation (tests and advanced setups):

| Variable               | Purpose                                                                  |
| ---------------------- | ------------------------------------------------------------------------ |
| `TRACE_FLOW_STATE_DIR` | Directory for connection state and sync cursors (default: OS config dir) |

Copy `.env.example` as a starting point for dev overrides only — do not commit real secrets.

## Release

CLI releases are manual GitHub Actions runs. For a real release, create and push the version tag
first, then dispatch from that tag:

```sh
git tag trace-flow-cli-v0.1.1
git push origin trace-flow-cli-v0.1.1
gh workflow run cli-release.yml --ref trace-flow-cli-v0.1.1 -f tag=trace-flow-cli-v0.1.1
```

Use `tag=dry-run` to build release artifacts without creating a GitHub Release. CLI releases are
optional downloads and never own the repository Latest channel. The workflow publishes only the
versioned release; `/install.sh` redirects to the current versioned CLI installer because repository
immutable releases make mutable `*-latest` release tags unusable.

Required repository secrets for signed macOS CLI artifacts:

| Secret                          | Purpose                           |
| ------------------------------- | --------------------------------- |
| `CODESIGN_CERTIFICATE`          | Base64 Developer ID `.p12`        |
| `CODESIGN_CERTIFICATE_PASSWORD` | Password for the `.p12`           |
| `CODESIGN_IDENTITY`             | Developer ID Application identity |
