# Coding-Agent Collector

These examples refer to Zaks.io's company deployment and require access. Trace Flow is internal
development tooling shared as source, with no service availability or support commitment. For a
fork, substitute your own endpoints and credentials. Requests and uploaded activity go to the
configured deployment; use synthetic data when testing.

Agent Conversation Analytics is not production-ready. The repository roadmap tracks the remaining
production checks; downloadable builds do not establish readiness.

Trace Flow's private-alpha collector turns local coding-agent activity into cost, token, context,
tool, repository, and review analytics in `/app/agents`.

## Download Trace Flow Desktop

- [macOS arm64 DMG](https://downloads.zaks.sh/trace-flow/desktop/latest/trace-flow-desktop.dmg)
- [Windows x64 installer](https://downloads.zaks.sh/trace-flow/desktop/latest/trace-flow-desktop-setup.exe)

The desktop app signs in through your browser and stores its Collector Credential in the OS keychain.
A fresh install starts paused. Source detection is local and read-only; no facts are uploaded until you
select **Start syncing**.

## Supported sources

| Source      | Store                                                         | Support                     |
| ----------- | ------------------------------------------------------------- | --------------------------- |
| Claude Code | `~/.claude/projects`                                          | macOS and Windows collector |
| Codex CLI   | `~/.codex/sessions`                                           | macOS and Windows collector |
| Cursor      | macOS global `state.vscdb`, read through a temporary snapshot | macOS                       |

The collector parses transcripts locally and uploads redacted typed facts. The normal analytics path
does not upload raw transcripts. Conversation Archive is a separate, explicitly enrolled feature and
is not currently available.

## Use the CLI from source

The CLI does not currently have a published release asset. Developers can run it from a checkout:

```sh
cargo run -p trace-flow-cli -- login
cargo run -p trace-flow-cli -- sources list
cargo run -p trace-flow-cli -- sync --since 7d
```

The installed binary exposes the same commands without `cargo run -p trace-flow-cli --`:

```text
trace-flow login
trace-flow sources list
trace-flow sync [--since 24h|7d|30d|1y]
trace-flow status
trace-flow disconnect
```

`sync` defaults to a 24-hour incremental scan and resumes from the last complete sync watermark after
downtime. Failed sessions keep their prior cursor and retry on the next cycle.

## Privacy and credentials

- Collector Credentials are separate from Trace Flow gateway API keys.
- The normal CLI and desktop paths keep credentials in the OS keychain, not command arguments or
  config files. Headless development and CI may supply the documented environment override.
- Transcript parsing, excerpt redaction, and source discovery happen locally.
- Agent Ingest re-redacts free-text excerpts before enqueueing facts.
- The desktop app remembers the user's sync or pause choice across relaunches.

## Current status

The collector, production-shaped ingest Workers, agent Tinybird schema, dashboard, Rust CI, Cursor
reader, and signed desktop update channel exist. Agent Conversation Analytics remains in private alpha
until the normal-user production sync, authenticated dashboard walkthrough, and live alert gates are
verified.
