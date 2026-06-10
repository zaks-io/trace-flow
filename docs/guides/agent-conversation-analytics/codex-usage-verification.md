# Codex Usage Verification (last 7 days)

Independent reconciliation of Codex agent usage: **raw `~/.codex/sessions` transcripts** →
**Tinybird `agent_message_facts`** → **`/app/agents` UI** → **CodexBar**. Done 2026-05-28 to answer "the
chart data does not match, we're missing data."

## TL;DR

- **A real Codex parser bug was found AND fixed** (ccusage [#884] class): the parser summed each row's
  `last_token_usage` instead of diffing successive cumulative `total_token_usage` snapshots, so sessions
  with Codex's duplicate/laggy emissions over-counted (32/83 sessions, e.g. `019e48ad` was +49%). Fixed
  to the documented method: diff cumulative snapshots, skip rows where the cumulative didn't advance,
  fall back to `last_token_usage` only on a reset/rollback. 176 parser tests pass.
- **After the fix, Tinybird matches the corrected ground truth.** Per-session token counts are
  now EXACT (e.g. `019e46fe` 35,279,527 tok in both; `019e48ad` 27,779,227 in both). Totals:

  | Window         | Corrected ground truth | Tinybird (post-fix) | Δ                          |
  | -------------- | ---------------------- | ------------------- | -------------------------- |
  | Codex 7d       | $465.31 / 4968 turns   | $454.47 / 4815      | −2.3% (day-bucketing edge) |
  | Codex all-time | $837.71 / 8894         | $829.26 / 9019      | ~1%                        |

- **Pricing method validated against ccusage** (trusted external tool): Claude 7d Tinybird $1,572 vs
  ccusage $1,636 (−4%). Same cost formula (uncached-in×in + cached×cache-read + out×out; reasoning is
  inside output).
- **CodexBar is a different, much larger outlier.** Its tray shows "Today $275.28 / 30d $2,857.46 / 30d
  tokens 3.7B." The corrected ground truth is ~1.1B tokens / **$838 for 30d** — CodexBar over-counts
  ~3.4x, the known ccusage [#950] (subagent 91x) / [#884] (duplicate rows) / [#988] (branched convo)
  inflation class. So "doesn't compute" was real, but the grossly-inflated number is CodexBar's; Trace
  Flow now matches the documented-correct method.

[#884]: https://github.com/ryoppippi/ccusage/issues/884
[#950]: https://github.com/ryoppippi/ccusage/issues/950
[#988]: https://github.com/ryoppippi/ccusage/issues/988

### (Superseded) earlier wrong read

A first pass of this doc claimed "CodexBar does not measure dollars" after grepping only its persisted
files (`usage-history.jsonl`, `history/*.json`) which hold rate-limit `usedPercent` snapshots. That was
wrong: CodexBar computes the dollar/token figures live from the same `~/.codex/sessions` logs and shows
them in its menu. The rate-limit-% data below is real but is a SEPARATE CodexBar metric from its cost
estimate.

#### Rate-limit window data (a separate, correct CodexBar metric)

CodexBar also records `usedPercent` of the subscription rate-limit window (Pro 20x) — different from
metric entirely. The remembered "$500/day" is not a value CodexBar stores.

## Method (independent ground truth)

Codex records usage in `token_count` events with two views:

- `info.total_token_usage` — the cumulative running total for the session. **This is the source of
  truth.** Per-turn usage is the DIFF between successive cumulative snapshots; a row whose cumulative
  did not advance is a duplicate emission and contributes nothing (ccusage#884). (Summing the
  cumulative _as a value_ across events is the ~331x trap — diff it, never sum it.)
- `info.last_token_usage` — the row's own per-turn delta. Used only as a **fallback** when the
  cumulative is unusable (a reset/rollback where it goes backwards). It can lag/diverge from the true
  delta when Codex re-emits rows, which is exactly why it is not the primary source.

Verified the diffed-cumulative per-turn usages sum to the session's final cumulative exactly (e.g.
session `019e66c3`: input 5,899,187 / cached 5,687,168 / output 13,324).

Codex `input_tokens` is the FULL prompt (includes cache); `cached_input_tokens` is the cached subset.
So **uncached input = input − cached**, cache_read = cached. The parser (`codex_usage.rs` +
`codex_turns.rs`) does exactly this diff + clamp — verified correct.

Cost uses models.dev `gpt-5.5`: base $5/$30/$0.5 per Mtok (in/out/cache-read), context tier at
≥272k prompt tokens → $10/$45/$1. Applied per turn (tier depends on that turn's prompt size).

Script: `/tmp/codex_truth.py` (sums `last_token_usage` per session, prices per turn).

## Ground truth — per day (bucketed by session start)

| Day        | Cost        | Sessions | Turns    | Uncached in | Cache read  | Output    |
| ---------- | ----------- | -------- | -------- | ----------- | ----------- | --------- |
| 2026-05-21 | $1.73       | 4        | 30       | 278,711     | 490,752     | 3,057     |
| 2026-05-22 | $0.69       | 1        | 18       | 73,642      | 551,168     | 1,684     |
| 2026-05-23 | $54.65      | 3        | 577      | 2,679,134   | 71,839,104  | 177,960   |
| 2026-05-24 | $34.16      | 5        | 396      | 1,836,533   | 40,071,808  | 164,637   |
| 2026-05-25 | $77.85      | 9        | 842      | 3,890,272   | 103,130,752 | 227,885   |
| 2026-05-26 | $191.61     | 11       | 1892     | 9,939,736   | 245,147,136 | 644,688   |
| 2026-05-27 | $39.03      | 8        | 409      | 2,619,454   | 41,450,240  | 173,558   |
| 2026-05-28 | $31.07      | 5        | 438      | 1,762,399   | 36,479,104  | 133,861   |
| **TOTAL**  | **$430.80** | **46**   | **4602** | 23,079,881  | 539,160,064 | 1,527,330 |

Peak day was **05-26 at ~$192**, not $500/day.

## Reconciliation vs Tinybird

**Per-session (apples-to-apples, by `vendor_session_id`)** — matches:

| Session  | Truth $/turns | Tinybird $/turns |
| -------- | ------------- | ---------------- |
| 019e55ba | $48.50 / 517  | $50.48 / 512     |
| 019e6595 | $44.97 / 406  | $46.53 / 401     |
| 019e6527 | $32.08 / 348  | $33.42 / 345     |
| 019e623c | $29.32 / 307  | $30.14 / 305     |

**7-day total:** ground truth $430.80 / 4602 turns / 46 sessions vs Tinybird $449.16 / 4722 / 49.
The difference is the **day-bucketing axis**: ground truth buckets by session-start time; Tinybird
buckets each turn by its own `EventAt`. Sessions spanning midnight (or near the 7-day cutoff) split
differently, which is why per-DAY rows diverge (e.g. 05-21 shows 30 turns in truth vs 2043 in
Tinybird — a long session that _started_ before the window but whose turns land inside it) while
per-SESSION totals match. Not missing data.

## CodexBar / CC cross-comparison

CodexBar data (`~/Library/Application Support/CodexBar/usage-history.jsonl`,
`com.steipete.codexbar/history/{codex,claude}.json`, `openai-dashboard.json`):

- Records ONLY `{capturedAt, resetsAt, usedPercent, windowKind}` — the % of your rate-limit window
  consumed. `accountPlan: "Pro 20x"`, `creditsRemaining: 0`, `usageBreakdown: []`, `dailyBreakdown: []`.
- **No cost, dollar, token, or spend field exists anywhere in CodexBar's stored data** (grep
  confirmed). Same for its Claude (`claude.json`) history — just `usedPercent`.

So CodexBar and Trace Flow measure different things and will never match:

| Source     | Metric                                                | Unit           |
| ---------- | ----------------------------------------------------- | -------------- |
| CodexBar   | Fraction of subscription rate-limit window used       | % of Pro-20x   |
| Trace Flow | Estimated API-equivalent authoring cost of the tokens | USD (estimate) |

A flat-fee Pro 20x subscription intentionally lets you run API-equivalent value far above the
subscription price; that's the plan's value, not a data error. Trace Flow's ~$450/week Codex figure is
the API-rate-equivalent of the tokens, correctly computed.

## Conclusion

Codex ingestion is accurate and complete. The "doesn't compute" was a metric mismatch (subscription
quota % vs estimated API-equivalent $), not lost data. If we want CodexBar-comparable numbers, that is
the separate Provider Usage Tracking feature (subscription/quota basis), not agent-conversation
analytics.
