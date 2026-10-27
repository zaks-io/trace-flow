# Coding-Agent Collector

These examples use the hosted Trace Flow service. An account with access is required.
For your own deployment, see [self-hosted setup](/docs/quick-start#self-hosted-deployments).

Coding-agent analytics is available in private alpha. Features and availability may change.

Trace Flow's private-alpha collector turns local coding-agent activity into cost, token, context,
tool, repository, and review analytics in `/app/agents`.

To ask questions about those analytics in the app, use Trace Flow Analyst with an active Pro
subscription. Analyst is not available on Hobby.

## Download Trace Flow Desktop

- [macOS arm64 DMG](https://downloads.zaks.sh/trace-flow/desktop/latest/trace-flow-desktop.dmg)
- [Windows x64 installer](https://downloads.zaks.sh/trace-flow/desktop/latest/trace-flow-desktop-setup.exe)

The desktop app signs in through your browser and stores its Collector Credential in the OS keychain.
A fresh install starts paused. Source detection is local and read-only; no facts are uploaded until you
select **Start syncing**.

## Supported sources

| Source      | Store                                                         | Support                                        |
| ----------- | ------------------------------------------------------------- | ---------------------------------------------- |
| Claude Code | `~/.claude/projects`                                          | macOS and Windows desktop, macOS and Linux CLI |
| Codex CLI   | `~/.codex/sessions`                                           | macOS and Windows desktop, macOS and Linux CLI |
| Cursor      | macOS global `state.vscdb`, read through a temporary snapshot | macOS                                          |

The collector parses transcripts locally and uploads redacted typed facts. The normal analytics path
does not upload raw transcripts.

## Use the CLI from source

The CLI does not currently have a published release asset. Install it from a checkout with Rust. On
Linux the build also needs `pkg-config` and the D-Bus headers (`sudo apt install pkg-config
libdbus-1-dev` on Debian and Ubuntu):

```sh
cargo install --path apps/cli --locked
```

This puts `trace-flow` in `~/.cargo/bin`. Its commands:

```text
trace-flow [--system] [--config <path>] login [--no-browser]
trace-flow [--system] [--config <path>] sources list
trace-flow [--system] [--config <path>] sync [--since 24h|7d|30d|1y]
trace-flow [--system] [--config <path>] sync --watch
trace-flow [--system] [--config <path>] service install|uninstall
trace-flow [--system] [--config <path>] status
trace-flow [--system] [--config <path>] disconnect
```

Sign in to the web app and create or join an organization before `login`. Every sign-in starts on a
Trace Flow page that asks you to approve connecting a Collector; continue only if you just started
one. On a machine without a browser, `login --no-browser` prints an address to open on any device,
and the page you reach after sign-in shows a one-time code to paste back into the terminal.

`sync` defaults to a 24-hour incremental scan and resumes from the last complete sync watermark after
downtime. Failed sessions keep their prior cursor and retry on the next cycle.

## Run the collector as a Linux service

On Linux the CLI can run as a systemd service that syncs every five minutes. The service runs the
binary that installed it, so install the binary first, as above, rather than running it with
`cargo run`.

For your own agent homes:

```sh
trace-flow login --no-browser   # or plain `login` when a browser runs on this machine
trace-flow service install
```

`service install` lists the agent homes it will read and asks before it starts syncing. On a host
without a desktop session, run `loginctl enable-linger "$USER"` once so the service keeps running
after you log out. Logs are in `journalctl --user -u trace-flow`.

For several users' homes on one host, run it host-wide as root from a root-owned binary:

```sh
sudo install -m 0755 ~/.cargo/bin/trace-flow /usr/local/bin/trace-flow
sudo trace-flow --system login --no-browser
sudo trace-flow --system service install
```

The host-wide service runs as root but keeps only the permission to read files, and it can write only
to `/var/lib/trace-flow` and a private `/tmp`. Logs are in `journalctl -u trace-flow`.

The service reads its inputs from `~/.config/trace-flow/collector.toml`, or
`/etc/trace-flow/collector.toml` host-wide. `service install` writes a starting config when none
exists. Edit it to add homes or globs, then restart the service:

```toml
[[inputs]]
name = "agents-codex"         # shown in status and logs instead of the path
source = "codex"              # claude or codex
path = "/srv/agents/*/.codex" # globs are expanded again every cycle
```

A config error or a missing login stops the service until you fix it and restart it. Logging in again
while it runs takes effect on its next cycle. `trace-flow status` shows the connection, sources, and
service state.

## Privacy and credentials

- Collector Credentials are separate from Trace Flow gateway API keys.
- Credentials never appear in command arguments, config files, or the service unit. The desktop app and
  the CLI on macOS and Windows keep them in the OS keychain. On Linux the CLI keeps them in an
  owner-only file in its private state directory, or in the Secret Service keyring if you set
  `credential_store = "keyring"` before `login`. Headless development and CI may supply the
  documented environment override.
- Logging in to another organization deletes the previous organization's credential from this
  machine, or warns if it cannot. That credential is not revoked on the server.
- Transcript parsing, excerpt redaction, and source discovery happen locally.
- Agent Ingest re-redacts free-text excerpts before enqueueing facts.
- The desktop app remembers the user's sync or pause choice across relaunches.
