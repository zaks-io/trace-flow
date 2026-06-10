# Agent Analytics Signal Catalog

This catalog records which Agent Conversation Analytics signals are worth acting on, which are
directional only, and which are not yet trustworthy. It exists to keep product claims tied to stored
facts instead of intuition.

ADR 0019 defines the derived read-model layer that should serve these signals to the dashboard and
MCP: [`0019-agent-analytics-derived-signal-read-models.md`](../../adr/0019-agent-analytics-derived-signal-read-models.md).
Reference sample: read-only Tinybird Cloud queries against `github.com/zaks-io/agent-paste` on
2026-06-06, 30-day window unless noted. Treat the numbers as evidence that the signals are observable,
not as product-wide baselines.

## Confidence Levels

| Level      | Meaning                                                                        | Product treatment                          |
| ---------- | ------------------------------------------------------------------------------ | ------------------------------------------ |
| High       | Directly backed by durable fact columns with clear semantics.                  | Safe for dashboards, alerts, and guidance. |
| Medium     | Backed by facts, but attribution or extraction has known ambiguity.            | Show with caveats and coverage indicators. |
| Low        | Present in raw facts, but parser coverage or outcome semantics are incomplete. | Use for investigation, not product claims. |
| Non-signal | Looks tempting but does not measure the thing claimed.                         | Do not surface except as a debug artifact. |

## High-Confidence Signals

### Runaway Agent Sessions

Signal: an Agent Session is far outside the normal distribution for messages, duration, tool count,
failures, or navigation tools.

Why it is strong:

- `agent_message_facts` gives message count, token totals, and event duration by `session_pk`.
- `agent_tool_event_facts` gives tool volume and failures by the same `session_pk`.
- The shape is extreme enough that rough thresholds are useful before any model-specific tuning.

Evidence from the sample:

- Median session: 14 assistant messages, 3 minutes, 1.0M tokens.
- P90 session: 251 assistant messages, 102 minutes, 28.7M tokens.
- P99 session: 1,829 assistant messages, 917 minutes, 175M tokens.
- Sessions above 100M tokens were only 14 sessions, but accounted for about 41% of the sample's
  estimated 30-day authoring cost.
- Those 100M+ sessions averaged 1,472 messages, 1,935 tool calls, 63 failures, and 384 navigation
  tools.

Useful product actions:

- Alert when an active Agent Session crosses a runaway threshold.
- Suggest compaction, handoff, or a fresh session with a summary.
- Show "session shape" beside cost so a user can distinguish normal deep work from a stalled loop.

Do not claim that every long session is bad. Some are legitimate orchestrations. The signal is "high
risk / review this session," not "failure."

### Cache-Read Pressure

Signal: total tokens are dominated by `cache_read_tokens`, especially in long sessions.

Why it is strong:

- Claude and Codex provide cache-read token facts with high coverage.
- Cache-read ratio is directly computed from token columns, not inferred from text length.

Evidence from the sample:

- 96.15% of total tokens were cache reads.
- Fresh input was 1.27%.
- Output was 0.38%.

Useful product actions:

- Label bloated sessions as "cached context replay" rather than "verbose output."
- Prioritize session compaction, handoff quality, and context trimming over output-length advice.
- Track cache-read ratio alongside estimated cost.

Do not claim that cache reads are inherently waste. Cache reads are cheap relative to fresh
input/output, but huge cache-read volume is the visible footprint of long-context replay.

### Tool Failure Categories

Signal: recurring failure categories from `agent_tool_event_facts.status='failure'` and redacted
`error_excerpt`.

Why it is strong:

- Status semantics are explicit: `failure / (success + failure)`, with `unknown` excluded.
- Repeated error strings cluster into actionable categories.
- The categories map directly to agent instructions, tool UX, or schema validation fixes.

Evidence from the sample:

| Category                   | Failures | Sessions | Action                                                              |
| -------------------------- | -------: | -------: | ------------------------------------------------------------------- |
| missing file               |      202 |       73 | Improve repo map and path validation.                               |
| read directory             |      128 |       39 | Teach agents to use `fd` / `rg --files` before reading directories. |
| edit before read           |      105 |       41 | Require read-before-edit in agent guidance and tool UX.             |
| external schema validation |       65 |        7 | Tighten Linear/MCP tool schemas and examples.                       |
| runtime/env mismatch       |       43 |       19 | Surface required package manager, Node, and workspace setup.        |
| stale file before edit     |       26 |       15 | Encourage reread after formatter or user edits.                     |

Useful product actions:

- Add a tool-failure coach with exact remediation.
- Show failure-category trend by repo/source/model.
- Promote stable categories to first-class parser fields instead of relying only on excerpts.

Do not claim that uncategorized `other` failures are understood. They need further parser work before
product interpretation.

### File Hotspots

Signal: repo-relative file paths repeatedly read, edited, or written across many sessions.

Why it is strong:

- `agent_file_event_facts.normalized_repo_path` is repo-relative and privacy-safe.
- `operation` separates read/edit/write.
- Repeated paths across many sessions reveal stable orientation and ownership hotspots.

Evidence from the sample:

- `apps/api/src/index.ts`: 360 touches across 40 sessions.
- `docs/ops/project-status.md`: 341 touches across 74 sessions.
- `CONTEXT.md`: 229 touches across 72 sessions.
- `apps/upload/src/index.ts`: 155 touches across 20 sessions.
- `apps/cli/src/index.ts`: 120 touches across 25 sessions.
- `apps/api/wrangler.jsonc`: 111 touches across 20 sessions.

Useful product actions:

- Generate a compact repo map proposal for `AGENTS.md` / `CLAUDE.md`.
- Recommend "start here" paths for common task surfaces.
- Detect documentation drift when files are hot but docs do not mention them.

Do not claim that a hot file is always the best entry point. It may also be a pain point, a god file,
or a file agents keep editing because ownership is unclear.

### Pull Request Link Coverage

Signal: passive PR-link observations can connect Agent Sessions to Pull Requests.

Why it is strong:

- `agent_pull_request_facts` stores canonical GitHub PR evidence with `url`, `number`,
  `confidence`, and `evidence`.
- It provides a bridge from session cost/failures/files to review and merge units.

Evidence from the sample:

- 1,186 PR-link observations.
- 136 sessions with PR evidence.
- 287 unique PR numbers.
- Evidence types included tool output, assistant text, and transcript record.

Useful product actions:

- Show estimated authoring cost per PR when one session maps cleanly to one PR.
- Report PRs with high failure count, high navigation churn, or repeated review loops.
- Keep unresolved or multi-PR sessions at repo/day grain instead of forcing attribution.

Do not claim that PR cost is complete for orchestrated workflows. The ADR trust boundary still
applies: multi-PR or multi-session work remains repo-level unless attribution is clean.

## Medium-Confidence Signals

### Model or Source Comparisons

Signal: failure rate, tool volume, and token profile grouped by `source` and `model`.

Why it is medium:

- Source/model columns are reliable when present.
- Tool surfaces differ across Claude, Codex, Cursor, MCPs, and local runtimes.
- A higher failure rate may mean a harder task, different tools, or stricter safety policy, not a
  weaker model.

Evidence from the sample:

- Codex/gpt-5.5 had higher observed tool failure rate than Claude Opus rows.
- Codex rows also had different tool coverage: no Claude-style `Read` / `Edit` / `Write` tool events
  in the same shape.

Useful product actions:

- Show source/model breakdowns with "tool surface differs" caveats.
- Compare a source to itself over time before comparing sources to each other.

Do not claim "Model A is better than model B" from this data alone.

### Directory Hotspots

Signal: top-level directories with repeated file touches or high associated session cost.

Why it is medium:

- Directory grouping is deterministic.
- Associated token/cost is session-level, not file-level; a file touched in an expensive session gets
  associated with the whole session.

Useful product actions:

- Identify broad surfaces that deserve stronger docs.
- Route repo-map hints by area: `apps`, `packages`, `docs`, `scripts`.

Do not claim that a directory caused the token cost. It is associated with costly sessions, not
causally priced.

### Capability Snapshot Size

Signal: capability snapshots report visible instruction/tool surface size.

Why it is medium:

- `agent_capability_snapshot_facts` records privacy-safe counts and token estimates.
- It does not store raw instruction or tool schemas, so it is a size signal, not a content signal.
- Source coverage is still limited.

Useful product actions:

- Track base-instruction and dynamic-tool surface growth.
- Correlate large capability surfaces with session cost, but do not infer causality yet.

## Low-Confidence Signals

### Search Intent From Command Arguments

Signal: infer what agents searched for from `rg`, `grep`, `find`, `fd`, `ls`, `sed`, `cat`.

Why it is low:

- Tool volume is observable, but path extraction from search/navigation commands is weak today.
- In the sample, thousands of search/navigation calls produced almost no extracted
  `repo_relative_paths`.
- Quoted shell fragments, pipes, globs, and chained commands make command parsing lossy.

Useful product actions:

- Use aggregate search/navigation volume as an orientation-friction signal.
- Do not use extracted command paths as the primary repo-map source yet.
- Improve parser extraction for command argv, working directory, globs, and path arguments.

### Unknown Tool Status

Signal: `status='unknown'` on tool events.

Why it is low:

- `unknown` is intentionally not counted as success or failure.
- Some important tools emit many unknown outcomes, including long-running shell sessions,
  `write_stdin`, git/pnpm commands, Linear tools, and automation tools.

Useful product actions:

- Show unknown-rate as coverage debt.
- Improve outcome parsing for high-volume unknown tools.

Do not claim that unknown means success, failure, or no-op.

## Non-Signals

Do not build product claims on these without additional evidence:

- Output length as the main cost driver when cache-read ratio dominates.
- Raw search-command count as "the agent is confused" without session shape and outcome context.
- Top file equals best documentation entry point.
- Per-file cost from session-level totals.
- Cross-model quality rankings from mixed tool surfaces.
- Absolute dollars without priced-token coverage and "estimated authoring cost" labeling.
- Path-fallback repos as stable repo identities unless they are claimed or healed by remote
  attribution.

## Recommended Product Surfaces

1. Runaway Agent Session alert: thresholds on message count, duration, total tokens, failures, and
   navigation tools.
2. Context replay report: cache-read ratio, fresh-input ratio, output ratio, and session length.
3. Tool failure coach: ranked error categories with concrete remediation.
4. Repo map proposal: compact file/directory hints generated from `agent_file_event_facts`.
5. PR authoring report: only when PR-link evidence is clean; otherwise keep cost at repo/day grain.
6. Coverage panel: priced-token coverage, unknown-status rate, parser version mix, remote-vs-path repo
   attribution.

## Parser Improvements

Promote these before making stronger claims:

- Store structured `error_category` at ingest for common tool failures.
- Improve command argv/path extraction for `rg`, `grep`, `find`, `fd`, `ls`, `sed`, `cat`, and shell
  chains.
- Reduce `status='unknown'` for high-volume tools by source-specific outcome parsers.
- Store search pattern separately from searched path when a command exposes both.
- Add session-shape rollups so runaway detection does not require ad-hoc joins.

## Done

This catalog is useful when a reader can answer:

- Which signals are safe for dashboards and alerts?
- Which signals need coverage or caveat labels?
- Which apparent signals should not be used for product claims?
- What parser work would move a weak signal into a stronger confidence tier?
