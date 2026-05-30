# Trace Flow Collector CLI (`trace-flow`)

User-facing collector binary: `login`, `sources list`, `sync`, `status`, `disconnect`.

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
