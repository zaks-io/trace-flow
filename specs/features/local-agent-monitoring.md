# Local Agent Monitoring

## Status

Proposed. Tracked by TRA-230. Not implemented. No code exists for any part of this.

## The Problem This Solves

Running many concurrent local coding agents means no ability to micromanage any of them.
There is no near-realtime view of what they are doing, and the only feedback loop is
post-hoc analytics with minutes-to-an-hour lag.

Measured end-to-end latency from "agent does something" to "a human could see it":

| Hop                     | Cost                                             | Source                                           |
| ----------------------- | ------------------------------------------------ | ------------------------------------------------ |
| Transcript to Collector | manual `Sync --since`; watcher designed, unbuilt | `apps/cli/src/main.rs:64`                        |
| Ingest to Consumer      | 5s batch timeout                                 | `apps/agent-consumer/wrangler.jsonc:51`          |
| Consumer to Tinybird    | up to 60s Durable Object flush                   | `apps/agent-consumer/src/fact-batcher.ts:19`     |
| Alert evaluation        | hourly                                           | `packages/convex/integrations/costAlerts.ts:870` |

The target is sub-10s visibility using deterministic detection only, with no model in the
monitoring loop.

## What v1 is

**v1 succeeds if capture is provably complete.** Not if it has features. Everything past
liveness, a findable record, and a desktop notification waits until completeness is
demonstrated.

Scope is deliberately two things:

1. A live board answering "which agent needs me right now".
2. A complete, findable record answering "what was it doing when it went wrong".

## Evidence: the raw transcript already holds nearly everything

This section is load-bearing. An earlier design proposed capturing a **hook event stream** as
a third data lane alongside facts and the Conversation Archive. That was wrong, and the
following observations against real transcript files are why.

### Claude

Top-level record keys present on real Claude Code records:

```
promptId  permissionMode  cwd  gitBranch  sessionId  isSidechain
mode  stopReason  version  hookCount  hookErrors  hookInfos
message  toolUseResult  timestamp  uuid  parentUuid
```

1. **`promptId` gives turn-grain correlation.** The earlier design claimed this was
   obtainable only from hooks.
2. **`permissionMode` is recorded**, as a top-level key and as a dedicated
   `type: "permission-mode"` record. Same claim, same correction.
3. **`worktree-state` records Checkout identity natively.** It carries `worktreeName`,
   `worktreePath`, `worktreeBranch`, `originalBranch`, and `originalHeadCommit`. Checkout is
   not derived from `cwd`; the Source states it.
4. **`system` / `turn_duration` is a clean turn-end marker**, carrying `durationMs`,
   `messageCount`, `cwd`, `gitBranch`, and `slug`. In one sampled session it appeared 203
   times, exactly 1:1 with `stop_hook_summary`.
5. **Full tool inputs are present**: Bash commands, `file_path` values, `WebFetch` URLs, and
   `mcp__<server>__<tool>` names, alongside their results.
6. **The file is appended live, mid-turn.** Measured on an active session: the transcript's
   mtime was 24 seconds old while the session was still executing tools, not flushed at turn
   end. Tailing therefore yields append-speed latency without any additional sensor.
7. **Subagents get their own files** at `<project>/<sessionId>/subagents/agent-<id>.jsonl`,
   nesting exactly one level (`packages/collector-sync/src/claude_session.rs:57-68`). 144 such
   files existed across two days on one developer machine.

Neither `packages/collector-parser/src/` nor `packages/collector-sync/src/` reads `promptId`,
`permissionMode`, `hookInfos`, or `hookCount` (verified by grep across both crates, no
matches). These are **parser gaps, not missing sensors**.

### Codex

Codex is better instrumented for this than Claude. Records wrap as
`{timestamp, type, payload}`; a sampled rollout contained:

| Signal         | Claude                        | Codex                                                      |
| -------------- | ----------------------------- | ---------------------------------------------------------- |
| Turn boundary  | `turn_duration` at end only   | `task_started` / `task_complete` paired by `turn_id`       |
| Duration       | `durationMs`                  | `duration_ms` plus `time_to_first_token_ms`                |
| Checkout       | `worktree-state.worktreeName` | `turn_context.cwd`, `turn_context.workspace_roots`         |
| Permission     | `permission-mode`             | `turn_context.approval_policy`, `sandbox_policy`, `effort` |
| Why it stopped | last assistant record         | `task_complete.last_agent_message`, verbatim               |
| Version        | `version` on every record     | `session_meta.cli_version`                                 |

Codex gives a **positive** mid-turn signal: an open `task_started` with no matching
`task_complete`. Claude requires inferring mid-turn from "records exist after the last
`turn_duration`".

### What the transcript genuinely does not contain

1. **Hook decisions.** `hookInfos` entries carry only `{command, durationMs}`. Across 2,331
   entries the key sets are exactly `[]` (1,188) and `["durationMs"]` (1,143). No event name,
   no decision, no matched rule. Deferred with blocking.
2. **Anything that bypassed the tool layer.** A script the agent wrote and then ran, an npm
   postinstall, a test suite that phones home. Not closable by better parsing. This is what
   divergence detection exists for.
3. **The difference between "finished" and "asking a question".** Both end a turn and produce
   an identical shape. Session Liveness merges them deliberately (see below).
4. **Reasoning text.** Both harnesses persist the provider's opaque blob and drop the body.
   Claude writes 34,778 `thinking` blocks across the local corpus in which the `thinking`
   string is empty and only a 5-6 KB `signature` survives; 347 of them carry text at all, and
   those top out at 76 characters because they are the bolded header, not the reasoning
   (`**Verifying typecheck coverage in tsconfig**`). Codex writes 35,756 `reasoning` response
   items over 14 days, 100% `encrypted_content` and 0% `content`, plus 4,883 `agent_reasoning`
   events whose text runs a median of 45 characters and a maximum of 79 — headers again. The
   consequence: there is no chain of thought on disk to analyze, and no parser change can
   recover one. What does exist is a **header stream**, and only on Codex.

## Reasoning headers, and why no judge

The header stream is worth capturing and is not worth judging.

Capturing it is cheap and deterministic: roughly 223 KB per 14 days of developer activity on
Codex, one short line per reasoning step, stating what the agent believed it was doing between
tool calls. That is the one signal the transcript otherwise lacks — everything else records
what happened, never what was intended. It redacts through the existing `redact_field` path
like any other excerpt and rides the existing fact tables. Today the collector captures
reasoning **token counts** and never reasoning text, so this is an additive fact, not a
schema fight.

Two things stop it from being a headline feature. It is **Codex-only** — Claude yields
essentially nothing, so any UI built on it would be blank for half the fleet. And headers are
an outline, not an argument: a judge reading "Verifying typecheck coverage" learns strictly
less than a judge reading the tool calls and diffs that follow it, which are already captured
in full and already cross-machine.

So an LLM judge, if one is ever justified, reads the **Conversation Archive** and the agent
fact tables, not the reasoning stream. That is a separate feature with its own gate: per the
standing rule, anything that burns tokens on a schedule ships with an eval harness, cost
tracking, and an agreed kill threshold before it runs once. v1 succeeds if capture is provably
complete, and a judge is not capture.

## Principles (non-negotiable)

1. **One sensor, one parser.** Detection reads the transcript. There is no parallel event
   stream carrying a second observation of the same tool calls. If a monitoring rule needs a
   fact, it is extracted once, in the shared parser, and every consumer reads it from there.

2. **Share the interpretation, not the loop.** The Collector reads whole files
   (`collector-sync/src/assemble_units.rs:46` does `read_to_string` on the entire transcript).
   Measured corpus: 68 files touched in 24h, 88.6 MiB, largest 21.4 MiB. A Supervisor sharing
   that loop at a 5s cadence re-reads tens of MiB per second, forever. The Supervisor tails
   byte offsets instead. Both feed the same record-interpretation functions, which already take
   decoded records rather than paths (`collector-sync/src/claude_session.rs:43`).

3. **Depend on the fewest markers possible.** Upstream harnesses change their record shapes
   without notice. Bound the fragile surface explicitly (see Stability tiers) and make breakage
   instant rather than silent.

4. **Deterministic only.** No model in the monitoring loop. Every signal is a field match, a
   set difference, or a count. The value is that it is cheap, explainable, and always on.

5. **Effectively free or it does not ship.** This runs continuously beside every agent. Cost
   discipline is a correctness property here, not an optimization (see Cost budget).

6. **Cooperative sensors get cross-checked.** The transcript records what passed through the
   tool layer and nothing that bypassed it. Independent ground truth comes from git.

7. **Never silently degrade.** A Source that cannot be tailed is labeled as such in the UI. A
   stale row must never read as a running agent.

## Architecture

### The Supervisor

A separate component from the Collector, shipping inside Trace Flow Desktop. Both read the same
Transcript Files. The Supervisor never uploads facts and never advances the Collector's
cursors, so a Supervisor failure cannot stop fact sync and a sync failure cannot blind the live
view.

**Hard constraint: the live reader is a read path separate from the sync job.** The
orchestrator enforces one-job-at-a-time and rejects any new job trigger while a job is running
(`packages/collector-sync/src/orchestrator.rs:19-23`). If monitoring is modeled as another
trigger it will be silently dropped every time a sync is in flight, which is exactly when the
most is happening.

**Polling, not filesystem events.** No `notify` crate exists in `Cargo.lock` (only
`notify-rust`, the desktop notification library). Do not add one. Polling mtime and byte length
across ~70 active files every few seconds costs nothing and avoids FSEvents entirely.

### Session Liveness

Three states, derived only from where the newest records sit relative to the last completed
turn:

| State       | Meaning                                                 | Board treatment                |
| ----------- | ------------------------------------------------------- | ------------------------------ |
| **Working** | Records since the last completed turn. Mid-turn.        | Count                          |
| **Idle**    | Newest activity is the last completed turn. Needs you.  | Count, with why it stopped     |
| **Stalled** | Mid-turn, nothing written for longer than the threshold | Desktop notification           |
| **Unknown** | Row expired; contact with the machine was lost          | Shown as lost, never as absent |

**Idle deliberately merges "finished the work" and "stopped to ask a question."** They are not
deterministically separable, and to someone supervising many agents they mean the same thing:
this one needs a human.

**Subagents get no rows.** They fold into the parent as an active count. Two reasons, the
second forcing it: you cannot act on a subagent, and a parent waiting on subagents appends
_nothing to its own file_ while its subagents append furiously. Without folding, every
orchestrating agent reads as Stalled at exactly the moment it is working hardest. A parent is
Working if it or any of its subagents is appending.

### Stability tiers

The explicit dependency surface, ordered by fragility:

| Tier  | Depends on                                               | Breaks when                |
| ----- | -------------------------------------------------------- | -------------------------- |
| **0** | File existence, mtime, byte-length delta, filename, path | The on-disk layout changes |
| **1** | Exactly one turn-boundary marker per Source              | That marker is renamed     |
| **2** | Model, permission posture, stop reason, token counts     | Any field is renamed       |

Tier 1 is irreducible: "appending" versus "not appending" cannot distinguish Idle from Stalled
without a turn boundary. Tier 2 fields render as unknown and never block a row from appearing.

**Drift guard.** Track when a turn boundary was last observed _machine-wide per Source_. If
sessions are appending but no boundary has appeared anywhere for a long window, the marker
moved. The board then reports the Source as unrecognized, with the observed harness version,
instead of showing every agent as Idle forever. This is derived, not a declared version
allowlist. The repo already uses canary fixtures for this shape of problem
(`packages/collector-parser/tests/redaction_canary.rs`).

### Live state storage

**Convex holds current state bounded by concurrency, never history bounded by time.**

One row per currently open Agent Session, upserted on state change, deleted on close. The bound
is how many agents can physically run at once, not how long the machine has been running. Each
row carries an `expiresAt` the Supervisor pushes forward on a **60s heartbeat with a 3-minute
expiry**, matching the pattern already used at `packages/convex/schema.ts:77,323,335,355,366`.
A Convex cron reaps expired rows, so the table drains itself even if the Supervisor dies
without cleaning up. Expired rows render as **Unknown**, never hidden.

Write rate for a full fleet is under 10k requests/day: batched snapshots on state change plus
the heartbeat, never one write per session per tick.

`agentSessionOwners` is the counter-example and already violates this rule. It inserts one
permanent row per session claimed and has no delete or patch anywhere in
`packages/convex/agentSessionOwners.ts`. Worth a separate ticket.

### Sinks

| Data               | Path                                       | Why                                      |
| ------------------ | ------------------------------------------ | ---------------------------------------- |
| Live session state | Supervisor to Convex, reactive query to UI | Push semantics, bounded rows             |
| Durable facts      | Existing Collector to Ingest to Tinybird   | Unchanged; this feature adds no new lane |
| Monitoring history | None in v1                                 | Re-derivable from the Transcript File    |

### Relationship to the Conversation Archive

No architectural dependency, by construction. The Conversation Archive (ADR 0012, TRA-211)
stores the **same bytes** this feature reads
(`docs/adr/0012-agent-conversation-analytics.md:209`). Live monitoring is therefore _the same
parse, run now instead of later_. That is a reason to share the parser, not a dependency.

The Archive can never be the monitoring read path: it is encrypted per organization with
server-side decryption required, has no query surface, and exports only through an owner-only
interactive grant (`:211`, `:573`). This feature must create no archive binding, no archive
entitlement check, and no archive-gated behavior, and must work with the archive switched off.

**Requirement to pin into TRA-214:** the archiver must ship _every_ record in the Transcript
File, not only records the fact parser recognizes. Monitoring depends entirely on record types
the parser currently ignores (`worktree-state`, `turn_duration`, `permission-mode`,
`system/stop_hook_summary`, Codex `task_started` / `task_complete` / `turn_context`). If the
archiver filters to recognized records, the archive is not lossless and none of this is
re-derivable.

## Forensics: seeing what went wrong

The requirement is cross-machine and must scale past one developer's laptop. Local grep does
not satisfy it. Most of what is needed already exists.

`datasources/agent_tool_event_facts.datasource` already ships, per organization, per session,
cross-machine: `tool_name`, `command_program`, `command_subcommand`, `status`, `exit_code`,
`duration_ms`, `repo_relative_paths`, `EventAt`, `command_excerpt`, and `error_excerpt`. That is
ClickHouse, queryable from anywhere, with no encryption problem and no per-machine index.

Three gaps close it:

1. **Excerpts are capped too low for debugging.** `emit_claude_tools.rs`,
   `emit_codex_tools.rs`, and `emit_cursor_tools.rs` hardcode `COMMAND_EXCERPT_CAP_BYTES = 1024`,
   `ERROR_EXCERPT_CAP_BYTES = 4096`, `TOOL_EXCERPT_TOTAL_CAP_BYTES = 5 KiB`. The text is cut
   **on the machine, before upload**; `apps/agent-ingest/src/redaction.ts:117` is a second,
   defensive cut on data that already arrived short. Raise to command 8 KiB, error 56 KiB,
   64 KiB total. No org-level configuration: one fixed high ceiling, and truncation stays only
   as abuse protection.
2. **No Checkout column.** `repo_fingerprint` collapses every worktree of a remote
   (`packages/collector-sync/src/git_remote.rs:21`), so concurrent agents in separate worktrees
   are indistinguishable in the fact tables.
3. **`repo_fingerprint` is a hash.** On verified Cloud-Dev data only 90 of 168 fingerprints map
   back to a real repository name, so "which repo did this happen in" is currently unanswerable
   for nearly half the data. This is also the prerequisite for joining anything to git.

**Why the fact tables and not the local files.** On one developer machine the full local corpus
is 4.5 GB across 3,922 files, and `rg` scans all of it in 1.78 seconds — so for a single machine
the record is already complete and already instantly searchable, and no index is warranted. That
does not satisfy the requirement. Forensics has to work across machines, which is why the
durable answer is the existing organization-scoped fact tables rather than anything local.

**Ceiling constraint.** `apps/agent-ingest/src/chunker.ts:7` sets
`MAX_QUEUE_MESSAGE_BYTES = 124_000` under Cloudflare's 128 KiB per-message limit, and
`chunker.ts:42` states the invariant "a single fact never exceeds the cap — excerpts are
length-capped upstream." Raising the caps is what threatens that invariant. A test must assert
that a maximum-sized Tool Event fact serializes under the ceiling.

## Divergence detection

The transcript is a cooperative sensor. Git is independent ground truth: the agent authors its
own transcript, but it cannot author git's object database without doing real work.

**Git analysis runs locally and pushes derived facts.** Not server-side. Workers have no
filesystem and no git binary, so server-side means either real disk (not serverless) or the
GitHub API — rate limits, an OAuth surface, and it still only ever sees pushed work. Locally it
is nearly free and already built: `packages/collector-sync/src/git.rs:109` already shells out to
`git` with a freeze cache and a per-probe timeout so a wedged `git` cannot stall the cycle.

Push derived facts, never diffs: commits authored, files changed, branch, ahead/behind, pushed
or not, dirty or not. Consulted at turn boundaries only, never sampled on a timer.

**What running locally costs:** hosted agents. Anything executing on infrastructure without a
Supervisor — notably Cursor background agents — is invisible. Independence is _not_ lost;
independence comes from the source of truth, not from where the computation runs.

## Detecting bypassed tools

Rejected: regex libraries of fetch idioms across common languages.
`packages/collector-parser/src/command.rs:1-13` records that this argument was already had —
Otto shipped a curated allowlist of program families and Trace Flow deliberately replaced it
with mechanical argv parsing, `family == program`, "so the failure leaderboard groups by program
with no curated family list to drift." An idiom list is that same list, but unbounded and
adversarial. It also misses the motivating case (`python script.py` where the script already
existed), and false positives dominate, since an agent _reading_ a file containing
`requests.get` is not fetching.

The viable approach, deferred past v1: **flag unfamiliar programs, not known-bad idioms.**
`classify_command` already yields `program` mechanically off every Bash call. Keep a
per-Checkout baseline of programs seen and surface new ones. No list to curate, nothing to
drift. Costs a baseline period of noise, and still cannot see inside `python script.py`.

Honest limit: nothing at the transcript layer can observe a socket. If unsanctioned network
egress is the threat, the only truthful instrument is the network itself, which is the deferred
proxy path.

## Cost budget

- **No polling samplers.** `lsof -i` (100ms+ per call) and process-tree polling are out of
  scope.
- **No `gitleaks` per file write.** The redaction pattern set already exists in
  `packages/collector-parser/src/redaction.rs` and `apps/agent-ingest/src/redaction.ts`, kept in
  sync by `fixtures/redaction-canary.json`. Link the Rust crate and run it in-process.
  `gitleaks` stays in pre-commit, where the cost amortizes over a whole commit.
- **Byte-offset tails only.** Never whole-file reads on the monitoring path.
- **Self-reporting.** The desktop app displays the Supervisor's own CPU and event rate.
  Overhead must stay under 1% of a core at 20 concurrent agents, and must be visible without
  going looking for it.

## Scope

In scope: local Claude Code and local Codex.

Out of scope:

- **Blocking.** Deferred entirely. Monitoring must work in a solid fashion first. This removes
  hooks from v1 completely: no `PreToolUse` shim, no shared rulebook, no decision log, no
  per-tool-call latency cost. Measurement already taken, so it need not be retaken when blocking
  returns: across 1,300 real hook invocations over three days the observed cost was p50 101ms,
  p95 423ms, max 18,477ms. A compiled shim at 5-15ms disappears into that noise, so latency is
  not the reason blocking is deferred.
- **Cursor.** Structurally excluded from this mechanism, not deprioritized: `source_root()`
  returns `None` for Cursor (`packages/collector-embedder/src/sources.rs:56`) because there is
  no append-only file to tail, and ADR 0012:133 requires a read-only snapshot of a multi-GB
  SQLite store rather than a live read. Cursor also runs largely as remote agents, so it wants a
  provider API integration instead. The board must say Cursor is unmonitored rather than
  silently omitting it — "no Cursor rows" and "Cursor agent running unmonitored" otherwise look
  identical.
- **Proxy routing** (`trace-flow proxy enable`). Deferred. It is unresolved whether
  `ANTHROPIC_BASE_URL` preserves subscription billing or forces metered API billing, and the
  answer changes the cost story entirely.
- **Server-side git.** See Divergence detection.
- **Monitoring history as a stored time series.** Re-derivable; not stored in v1.
- **Syscall-level sensors** (`fs_usage`, Endpoint Security). Cost is not justified yet.
- **Any judgment of correctness.** No model in the loop. Deterministic signals answer "what
  happened", never "was it right".

## Open questions

- Thresholds are not set up front. Emit for a week and derive them from observed data. The
  stall threshold must clear legitimate long turns: an observed real Claude turn ran 545,887ms
  (9.1 minutes) and a sampled Codex turn 297,078ms.
- Cross-machine forensics for machines without a Supervisor has no answer. The Archive is
  encrypted with no query surface, so this is a real product gap, named and not solved here.

## Done

- A live board shows all concurrent local Claude and Codex sessions with Session Liveness,
  Checkout, permission posture, and why an Idle session stopped, updating within 10s of the
  transcript append.
- Subagents fold into their parent; no orchestrating agent reads as Stalled while its subagents
  are working.
- A Stalled session raises a desktop notification.
- Losing contact with a machine renders as Unknown, never as absent and never as Idle.
- A renamed turn-boundary marker surfaces as an unrecognized Source within one drift window,
  rather than showing every agent as Idle.
- `promptId`, `permissionMode`, `worktree-state`, and `turn_duration` are extracted and
  available on parsed Claude records; `task_started`, `task_complete`, and `turn_context` on
  Codex records.
- Tool Event excerpt caps are raised to command 8 KiB / error 56 KiB / 64 KiB total, with a test
  asserting a maximum-sized fact serializes under `MAX_QUEUE_MESSAGE_BYTES`.
- `agent_tool_event_facts` carries a Checkout column, and concurrent agents in separate
  worktrees are distinguishable.
- Divergence between the transcript record and local git at turn boundaries is detected and
  surfaced.
- The desktop app displays the Supervisor's own CPU and event rate, measured under 1% of a core
  at 20 concurrent agents.
- No new server-side data lane exists. The durable path is the one that already ships facts.
