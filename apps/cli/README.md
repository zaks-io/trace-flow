# Trace Flow Collector CLI (`trace-flow`)

The command-line collector reads local coding-agent stores, converts them into redacted typed facts,
and syncs those facts to Agent Ingest with a Collector Credential. It runs once per command or as a
long-lived Linux systemd service, per user or for the whole host.

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
trace-flow [--system] [--config <path>] login [--no-browser]
trace-flow [--system] [--config <path>] sources list
trace-flow [--system] [--config <path>] sync [--since 24h|7d|30d|1y] [--replay]
trace-flow [--system] [--config <path>] sync --watch
trace-flow [--system] [--config <path>] service install [--yes]
trace-flow [--system] [--config <path>] service uninstall
trace-flow [--system] [--config <path>] status
trace-flow [--system] [--config <path>] disconnect
```

- `login` opens the browser sign-in and stores the resulting Collector Credential in the credential
  store. `--no-browser` signs in from a browser on another machine (see below).
- `sources list` reports supported stores, or the configured inputs, and their counts without
  printing absolute home paths.
- `sync` parses, redacts, and uploads facts. Its default `24h` incremental window resumes from the
  last complete sync watermark so time spent offline is not silently skipped. `--watch` keeps
  syncing every few minutes until stopped; it is what the service runs.
- `service install` shows the agent homes the service will read, asks, then writes the config (only
  if none exists) and the systemd unit and starts it. `service uninstall` stops and removes the unit.
- `status` prints connection, source, and service state without secrets.
- `disconnect` removes the local credential, cursors, and service state.

`--system` selects the host-wide layout described below. Without it, commands use the per-user
layout.

Production URLs are embedded as defaults:

```sh
trace-flow login
trace-flow sync --since 7d
```

Agent Conversation Analytics is still private-alpha software. A working binary and production
defaults do not establish that the complete normal-user production flow has passed every gate in the
[roadmap](../../docs/guides/agent-conversation-analytics/ROADMAP.md).

## Run as a Linux service

Two layouts, chosen per host:

|                      | Per-user (default)                          | Host-wide (`--system`, as root)              |
| -------------------- | ------------------------------------------- | -------------------------------------------- |
| Reads                | this user's agent homes                     | the homes listed in the config, for any user |
| Config               | `~/.config/trace-flow/collector.toml`       | `/etc/trace-flow/collector.toml`             |
| State and credential | `~/.config/trace-flow/`                     | `/var/lib/trace-flow/`                       |
| Unit                 | `~/.config/systemd/user/trace-flow.service` | `/etc/systemd/system/trace-flow.service`     |
| Logs                 | `journalctl --user -u trace-flow`           | `journalctl -u trace-flow`                   |

Per-user:

```sh
trace-flow login --no-browser   # or plain `login` when a browser runs on this machine
trace-flow service install
```

On a host without a desktop session, enable lingering once so the service keeps running while you
are logged out: `loginctl enable-linger "$USER"` (some hosts require an administrator for this).

Host-wide:

```sh
sudo install -m 0755 ./trace-flow /usr/local/bin/trace-flow
sudo trace-flow --system login --no-browser
sudo trace-flow --system service install
```

The host-wide unit runs the binary as root, so `service install` refuses a binary that a non-root
user could replace, such as one in a home or build directory.

Claude writes transcripts `0600`, so the host-wide unit runs as root but keeps only
`CAP_DAC_READ_SEARCH` under systemd sandboxing: it can read the configured homes, but the filesystem is
read-only outside `/var/lib/trace-flow`, a syscall filter applies, and it cannot regain privileges. It
marks repositories safe for its read-only git calls, since they belong to other users. The units
live in [`systemd/`](./systemd).

### Configuration

`service install` writes a starting config when none exists: the homes your shell resolves today
(per-user) or `/home/*/.claude` and `/home/*/.codex` (host-wide). Edit it and restart the service:

```toml
interval_minutes = 5        # optional, default 5
first_backfill = "7d"       # optional: 24h, 7d, 30d, or 1y for the first pass
# credential_store = "file" # optional, read by login: "file" (Linux default) or "keyring"

[[inputs]]
name = "claude"             # shown in status and logs instead of the path
source = "claude"           # claude or codex
path = "~/.claude"          # the agent home, what CLAUDE_CONFIG_DIR would name

[[inputs]]
name = "agents-codex"
source = "codex"
path = "/srv/agents/*/.codex" # globs are expanded again every cycle
```

Without a config, one-shot per-user commands read `~/.claude`, `~/.codex`, `CLAUDE_CONFIG_DIR`, and
`CODEX_HOME`. `sync --watch` and host-wide mode read only a config's inputs, and commands that read
inputs need a `--config` file to exist. `status` shows a config problem instead of failing, and
`service uninstall` and `disconnect` never read the config. An unknown key, an invalid value, a
missing config, or a missing login exits with status 78 (`EX_CONFIG`), and the units do not restart
on it; fix it and restart.

`*`, `?`, and `[...]` match within one directory level; `**` is not supported. A glob skips paths
that do not exist, but a directory it cannot read, including a home behind a wildcard that is not
readable, fails that cycle before anything uploads, so the sync watermark never moves past homes the
pass could not see.

### Credential storage and headless sign-in

On Linux the Collector Credential is an owner-only (`0600`) file in the state directory, because
headless hosts and services have no Secret Service keyring. The CLI refuses a credential file other
users can read. Set `credential_store = "keyring"` before `login` to use the Secret Service instead;
`login` records the store it used, and later commands read the credential from there. macOS and
Windows default to the OS keychain.

The state directory is `0700`, and the CLI refuses to use it while it holds a file another user
owns. It also refuses a connection or state file that is a symlink or that other users can change,
because the connection decides where the credential is sent.

`login --no-browser` prints a sign-in address to open in a browser on any device. After sign-in that
browser fails to load a `127.0.0.1` page; copy its full address and paste it at the hidden prompt.
The address contains the credential, so run `login` yourself in a terminal, not through an agent.

## Environment overrides

| Variable                      | Default                                  | Purpose                                          |
| ----------------------------- | ---------------------------------------- | ------------------------------------------------ |
| `TRACE_FLOW_CONVEX_SITE_URL`  | `https://laudable-bison-427.convex.site` | Convex site origin for the browser device flow   |
| `TRACE_FLOW_INGEST_URL`       | `https://collector.trace-flow.dev`       | Agent Ingest origin used by `sync`               |
| `TRACE_FLOW_COLLECTOR_SECRET` | Credential store                         | CI credential override                           |
| `TRACE_FLOW_STATE_DIR`        | OS application config directory          | Per-user state location (not used by `--system`) |
| `TRACE_FLOW_CONFIG`           | Layout's `collector.toml`                | Same as `--config`                               |

For dev, override both endpoint variables with the deployed `-dev` Agent Ingest origin and the
Convex dev **site** origin. A bare collector launch targets production. Use `127.0.0.1:8787` only
for the explicitly self-contained local Worker stack; it is not the dev environment.

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
