# Agent snapshot retirement benchmark

Status: measured proposal. Isaac has not accepted a snapshot retirement decision.

The corrected 1M benchmark covers all 18 endpoints at 7/7, production-default
7/30, and 30/30 window/plan-retention sets. **12 endpoints pass exact parity and
all proposed thresholds in every set.** The six lifetime endpoints fail
parity in every set. Every simple direct variant passes the latency and bytes
budget. The additional retention-clipped two-stage queries remain fast, but their
bytes exceed the budget for two endpoints at 7/30 and four at 30/30. Both
file-attention two-stage variants pass the cost budget and fail parity.

The largest safely completed scale remains **one million messages**. **2M, cloud
latency and concurrency are unvalidated.** The round 1 two-million load failed;
this round did not retry 2M or increase the 8 GiB container limit. Keep the
snapshot layer until the missing validation and lifetime-history decision are made.

This report implements [TRA-409](https://linear.app/zaks-io/issue/TRA-409) and
responds to [PR #614's independent review](https://github.com/zaks-io/trace-flow/pull/614#issuecomment-6099483282).
The proposal does not change ADR 0019, deployed pipes, snapshots, the consumer or ADRs.

## Reproduce

From an isolated worktree with `SBX_AGENT_ID` set:

```sh
bun install --frozen-lockfile
bash scripts/bench/run-agent-snapshot-benchmark.sh \
  --messages 1000000 --runs 10 --output /tmp/agent-snapshot-benchmark.json
python3 -m unittest discover -s scripts/bench -p 'test_*.py'
```

The [runner README](../../scripts/bench/README.md) describes setup, ownership and
cleanup. The runner requires 8 GiB available, prints `free -h`, `uptime` and
`sbx-ps`, and starts only its labeled Tinybird Local container. It checks loopback
bindings and client destination, fails on a port collision, and removes its own
container/network after success, errors, SIGTERM or Ctrl-C. Bulk fixture facts and
database storage stay outside Git. Only synthetic output examples enter the artifact.

No benchmark `.pipe` or `.datasource` is committed under `scripts/bench`.
Generated resources exist only in the runner's temporary project. The recursive
safety test fails if either extension appears under the benchmark directory at
any depth. Safety follows from excluding deployable files, regardless of Tinybird
scan depth or deployment include settings.

## Fixture and method

The fixture spans a calendar retention year and the current partial day. Four
organizations have a 70/10/10/10 distribution; only the largest is measured.
There are 50,000 sessions, 128 repos, three sources and four models. Corrections
include 1% old-key tombstone/new-key date moves; 1% of each category is deleted.
Separate batched INSERTs leave replacement to `FINAL`, without forced merges.
Binary-fraction costs make exact sums independent of float accumulation order.

A new fact generator was needed because the existing
`generate-agent-snapshot-benchmark.mjs` generates manifest commits, rather than
canonical facts to feed both read paths. All nine real repository snapshot Copies
run serially for each of the four orgs over the same facts. A synchronous manifest
append publishes each completed generation. Ingestion-only materializations,
ingest transport and scheduling delays are excluded.

Special measured-org sessions cross the 7-day and 30-day starts. Session zero
contains August 25 messages and October 10 activity, plus an attribution decision
46 days before the end. Other cases include activity after the window end and a
session with messages before end but a PR at end + 1s. Generic timestamps sit at
least four hours away from the moving retention edge. Date moves from the end day
go backward, and the runner rejects future fixture facts before measurement.

| Canonical category                        | Base rows | Inserted versions | Live after FINAL |
| ----------------------------------------- | --------: | ----------------: | ---------------: |
| `agent_message_fact_versions`             | 1,000,000 |         1,070,000 |          990,000 |
| `agent_tool_event_fact_versions`          | 1,000,000 |         1,070,000 |          990,000 |
| `agent_file_event_fact_versions`          |   500,000 |           535,000 |          495,000 |
| `agent_pull_request_fact_versions`        |    10,000 |            10,700 |            9,900 |
| `agent_capability_snapshot_fact_versions` |    10,000 |            10,700 |            9,900 |
| `agent_review_unit_attribution_versions`  |    10,000 |            10,700 |            9,900 |

Actual live counts matched all six expected totals. The artifact retains org counts,
first/last timestamps and special-session spans. Boundary counts at measurement start:

| Category                                  | End-day facts | Facts at/after end | Future facts |
| ----------------------------------------- | ------------: | -----------------: | -----------: |
| `agent_message_fact_versions`             |            88 |                 30 |            0 |
| `agent_tool_event_fact_versions`          |            88 |                 30 |            0 |
| `agent_file_event_fact_versions`          |            40 |                 15 |            0 |
| `agent_pull_request_fact_versions`        |             3 |                  2 |            0 |
| `agent_capability_snapshot_fact_versions` |             3 |                  1 |            0 |
| `agent_review_unit_attribution_versions`  |             2 |                  1 |            0 |

The runner records `system.parts` active/inactive counts, rows and bytes per
physical table before measurement, covering 34 tables in this run. This makes
merge state visible; no forced merge or part-count normalization occurred.

Each parameter set has one warmup per path and ten measured samples. Request
order alternates current/direct, or current/direct/two-stage and its reverse.
Wall time includes client JSON parsing. Database time, rows and bytes come from
query statistics; the scan value is the maximum observed. p95 uses nearest rank,
so ten samples select the slowest request. All paths had stable hashes across all
ten samples, and all 54 comparisons plus 18 two-stage comparisons completed without
endpoint errors. Hash parity is exact and ordered. The unordered priced-usage
generic relation compares its exact row multiset, preserving duplicates.

The [runner-emitted artifact](../../scripts/bench/measurements/2026-10-10.json)
retains samples, hashes, synthetic examples, Copy timings, boundary/parts evidence,
source and generated-query hashes, CLI/Python/ClickHouse/image versions and limits.
The source commit is the pushed script checkpoint `2236adf` with
`source_dirty: true` for pending documentation and generated check artifacts.
Per-file hashes identify the measured scripts and match the committed versions. Provenance
was emitted by the runner. Prettier only compacts the JSON whitespace; parsed
artifact values are identical to the runner output.

The selected end was `2026-10-10T16:17:00+00:00`, snapped to the minute as the dashboard sends.
Measurement started at `2026-10-10T16:18:09.620412+00:00`. The run used tb, version 4.6.22 (rev 5269fe22),
Python 3.11.17, ClickHouse 25.8.34.2, eight visible CPUs and
8,589,934,592 bytes of container memory. Image:
`sha256:99d28663eed712779fe60338d7730b9fee9bff92f84c5e44903784b61002602a`.

## Query bounds and current contracts

Each snapshot substitute uses the Copy's aggregate-state expressions, with
`OrgId`, `toDate(EventAt) >= toDate(retained_start)` and
`toDate(EventAt) <= toDate(end - 1ms)` before aggregation. Mutable fields remain
filtered after `FINAL`. Downstream serving predicates are unchanged, including
hour/day bucket behavior within the partial end day. This preserves the current
bucket contract rather than imposing exact fact timestamps on those endpoints.

Usage summary, context health, tool period delta and session cost distribution
start at `greatest(prior_start, now() - retention_days)`. Notable changes starts at
`greatest(least(prior_start, start - 28 days), now() - retention_days)` to preserve
its trailing baseline too. Other snapshot substitutes start at
`greatest(start, now() - retention_days)`. Generated nodes reuse the endpoint
normalized `WITH` start/end expressions, preserving defaults and reversed bounds
where the endpoint supports them. Current endpoint retention predicates
remain in place. The date bounds prune replacement-key columns; date moves retain
both the old-key tombstone and the new-key live version in the fixture.

Cost by depth, session identity and priced usage already read canonical `FINAL`.
Their variants preserve the current SQL. Priced usage ignores the selected
window and reads plan-visible facts, so its 7/30 control has 30-day scan volume.
Review-unit costs' simple direct variant clips attribution decisions to the
selected window and plan range, intentionally testing that semantic restriction.

ADR 0019 signals are marked `signal` below. Context health and notable changes
are org-wide comparisons; passing `repo_fingerprint` does not scope those two.
The other scoped signals receive synthetic repo zero. Default pagination, sorting
and optional dimensions retain their current defaults. Full optional-filter and
sort coverage remains unvalidated.

## Current versus simple direct results

The proposed budget is median <= 1,000 ms, p95 <= 2,000 ms, direct bytes <= 3x
current bytes, and exact parity. The same thresholds are shown for each set.
`C` means current and `D` means direct. Timing is median / p95 in milliseconds.
Scan is maximum rows / decimal MB. The artifact contains exact byte counts and
database timing. `Budget` excludes parity; `Overall` requires both.

### 7-day window, 7-day plan retention

| Endpoint                                      |          C ms |          D ms |      C rows / MB |     D rows / MB | Bytes ratio | Parity | Budget | Overall |
| --------------------------------------------- | ------------: | ------------: | ---------------: | --------------: | ----------: | ------ | ------ | ------- |
| `agent_context_health` signal                 |   46.3 / 87.4 |   56.9 / 59.7 |    16,777 / 4.95 |   24,004 / 8.57 |       1.73x | PASS   | PASS   | PASS    |
| `agent_cost_by_depth` raw                     |   31.2 / 59.2 |   31.2 / 32.6 |   72,012 / 18.37 |  72,012 / 18.37 |       1.00x | PASS   | PASS   | PASS    |
| `agent_failure_leaderboard` signal            |   16.8 / 31.8 |   16.3 / 18.2 |  421,937 / 80.65 |   26,490 / 8.73 |       0.11x | PASS   | PASS   | PASS    |
| `agent_file_attention_top_directories` signal |   29.9 / 30.8 |   35.6 / 39.5 | 373,446 / 196.08 |  39,637 / 22.84 |       0.12x | FAIL   | PASS   | FAIL    |
| `agent_file_attention_top_files` signal       |   32.6 / 35.0 |   36.7 / 41.3 | 373,446 / 211.77 |  39,637 / 22.84 |       0.11x | FAIL   | PASS   | FAIL    |
| `agent_notable_changes` signal                |   17.6 / 32.4 |   22.5 / 23.3 |  145,896 / 27.89 |   24,004 / 8.36 |       0.30x | PASS   | PASS   | PASS    |
| `agent_priced_coverage`                       |   10.3 / 23.8 |   14.9 / 16.0 |  147,600 / 12.25 |   24,004 / 8.07 |       0.66x | PASS   | PASS   | PASS    |
| `agent_priced_usage` raw                      | 114.0 / 118.5 | 112.7 / 125.4 |   74,498 / 41.51 |  74,498 / 41.51 |       1.00x | PASS   | PASS   | PASS    |
| `agent_repo_directory`                        |   12.1 / 13.3 |   17.7 / 31.4 |   35,122 / 25.61 |  24,004 / 13.28 |       0.52x | PASS   | PASS   | PASS    |
| `agent_review_unit_costs`                     |   65.8 / 68.9 |   34.1 / 35.8 |  150,843 / 35.55 |  64,521 / 15.57 |       0.44x | FAIL   | PASS   | FAIL    |
| `agent_session_cost_distribution`             |   51.3 / 54.5 |   69.4 / 88.8 |  129,443 / 36.09 |  63,935 / 15.78 |       0.44x | FAIL   | PASS   | FAIL    |
| `agent_session_identity` raw                  |   14.5 / 27.7 |   13.6 / 14.7 |    24,004 / 9.16 |   24,004 / 9.16 |       1.00x | PASS   | PASS   | PASS    |
| `agent_session_signals_top_runaway` signal    |   50.8 / 54.2 |  95.4 / 113.0 | 258,886 / 204.50 | 127,870 / 44.85 |       0.22x | FAIL   | PASS   | FAIL    |
| `agent_sessions_browser`                      |   36.7 / 40.0 |   55.6 / 80.9 | 258,886 / 143.62 | 127,870 / 39.64 |       0.28x | FAIL   | PASS   | FAIL    |
| `agent_tool_period_delta` signal              |   21.4 / 35.5 |   22.4 / 23.1 |  421,937 / 67.15 |   26,490 / 8.73 |       0.13x | PASS   | PASS   | PASS    |
| `agent_usage_breakdown`                       |   15.6 / 32.3 |   18.8 / 22.6 |  147,600 / 48.29 |   24,004 / 8.55 |       0.18x | PASS   | PASS   | PASS    |
| `agent_usage_summary`                         |   23.1 / 41.9 |   27.9 / 29.2 |  147,600 / 37.05 |   24,004 / 8.55 |       0.23x | PASS   | PASS   | PASS    |
| `agent_usage_timeseries`                      |   43.1 / 57.7 |   44.6 / 47.2 | 569,537 / 130.88 |  50,494 / 17.28 |       0.13x | PASS   | PASS   | PASS    |

### 7-day window, 30-day plan retention

| Endpoint                                      |          C ms |          D ms |      C rows / MB |      D rows / MB | Bytes ratio | Parity | Budget | Overall |
| --------------------------------------------- | ------------: | ------------: | ---------------: | ---------------: | ----------: | ------ | ------ | ------- |
| `agent_context_health` signal                 |   53.1 / 54.8 |   76.4 / 79.7 |    31,469 / 9.28 |   53,181 / 19.00 |       2.05x | PASS   | PASS   | PASS    |
| `agent_cost_by_depth` raw                     |   31.7 / 32.7 |   32.0 / 33.5 |   72,012 / 18.37 |   72,012 / 18.37 |       1.00x | PASS   | PASS   | PASS    |
| `agent_failure_leaderboard` signal            |   17.2 / 17.8 |   16.9 / 18.7 |  421,937 / 80.65 |    26,490 / 8.73 |       0.11x | PASS   | PASS   | PASS    |
| `agent_file_attention_top_directories` signal |   32.0 / 39.9 |   34.4 / 38.2 | 373,446 / 196.08 |   39,637 / 22.84 |       0.12x | FAIL   | PASS   | FAIL    |
| `agent_file_attention_top_files` signal       |   32.9 / 38.1 |   36.4 / 40.8 | 373,446 / 211.77 |   39,637 / 22.84 |       0.11x | FAIL   | PASS   | FAIL    |
| `agent_notable_changes` signal                |   17.6 / 18.1 |   42.7 / 43.5 |  145,896 / 27.89 |   85,310 / 29.70 |       1.06x | PASS   | PASS   | PASS    |
| `agent_priced_coverage`                       |    9.9 / 10.3 |   15.5 / 16.5 |  147,600 / 12.25 |    24,004 / 8.07 |       0.66x | PASS   | PASS   | PASS    |
| `agent_priced_usage` raw                      | 477.0 / 501.0 | 474.1 / 499.3 | 262,446 / 145.96 | 262,446 / 145.96 |       1.00x | PASS   | PASS   | PASS    |
| `agent_repo_directory`                        |   11.7 / 12.2 |   16.7 / 17.9 |   35,122 / 25.61 |   24,004 / 13.28 |       0.52x | PASS   | PASS   | PASS    |
| `agent_review_unit_costs`                     |   65.0 / 74.0 |   33.7 / 40.6 |  150,843 / 35.55 |   64,521 / 15.57 |       0.44x | FAIL   | PASS   | FAIL    |
| `agent_session_cost_distribution`             |   50.2 / 51.9 | 103.1 / 107.3 |  129,443 / 36.09 |  138,062 / 34.16 |       0.95x | FAIL   | PASS   | FAIL    |
| `agent_session_identity` raw                  |   14.0 / 15.3 |   13.7 / 15.9 |    24,004 / 9.16 |    24,004 / 9.16 |       1.00x | PASS   | PASS   | PASS    |
| `agent_session_signals_top_runaway` signal    |   47.9 / 50.1 |  86.3 / 101.5 | 258,886 / 204.50 |  127,870 / 44.85 |       0.22x | FAIL   | PASS   | FAIL    |
| `agent_sessions_browser`                      |  38.3 / 106.2 |   55.3 / 69.0 | 258,886 / 143.62 |  127,870 / 39.64 |       0.28x | FAIL   | PASS   | FAIL    |
| `agent_tool_period_delta` signal              |   22.7 / 26.4 |   28.9 / 34.6 |  421,937 / 67.15 |   51,635 / 17.00 |       0.25x | PASS   | PASS   | PASS    |
| `agent_usage_breakdown`                       |   15.9 / 17.2 |   20.7 / 24.2 |  147,600 / 48.29 |    24,004 / 8.55 |       0.18x | PASS   | PASS   | PASS    |
| `agent_usage_summary`                         |   23.4 / 24.1 |   39.0 / 40.8 |  147,600 / 37.05 |   53,181 / 18.95 |       0.51x | PASS   | PASS   | PASS    |
| `agent_usage_timeseries`                      |   46.8 / 50.7 |   47.2 / 54.2 | 569,537 / 130.88 |   50,494 / 17.28 |       0.13x | PASS   | PASS   | PASS    |

### 30-day window, 30-day plan retention

| Endpoint                                      |          C ms |          D ms |      C rows / MB |      D rows / MB | Bytes ratio | Parity | Budget | Overall |
| --------------------------------------------- | ------------: | ------------: | ---------------: | ---------------: | ----------: | ------ | ------ | ------- |
| `agent_context_health` signal                 |   64.9 / 67.6 | 121.4 / 129.1 |   56,045 / 16.53 |   85,310 / 30.46 |       1.84x | PASS   | PASS   | PASS    |
| `agent_cost_by_depth` raw                     |   60.6 / 68.7 |   60.3 / 70.1 |  255,930 / 65.25 |  255,930 / 65.25 |       1.00x | PASS   | PASS   | PASS    |
| `agent_failure_leaderboard` signal            |   16.7 / 17.2 |   23.3 / 28.2 |  421,937 / 80.65 |   91,826 / 30.22 |       0.37x | PASS   | PASS   | PASS    |
| `agent_file_attention_top_directories` signal |   29.9 / 34.7 |   60.2 / 67.7 | 373,446 / 196.08 |  132,090 / 76.60 |       0.39x | FAIL   | PASS   | FAIL    |
| `agent_file_attention_top_files` signal       |   33.9 / 39.8 |   63.2 / 72.9 | 373,446 / 211.77 |  132,090 / 76.60 |       0.36x | FAIL   | PASS   | FAIL    |
| `agent_notable_changes` signal                |   18.4 / 19.3 |   39.7 / 41.1 |  145,896 / 27.89 |   85,310 / 29.70 |       1.06x | PASS   | PASS   | PASS    |
| `agent_priced_coverage`                       |   10.6 / 11.4 |   33.5 / 42.7 |  147,600 / 12.25 |   85,310 / 28.67 |       2.34x | PASS   | PASS   | PASS    |
| `agent_priced_usage` raw                      | 495.7 / 716.0 | 498.3 / 542.8 | 262,446 / 145.96 | 262,446 / 145.96 |       1.00x | PASS   | PASS   | PASS    |
| `agent_repo_directory`                        |   12.1 / 13.7 |   42.1 / 47.4 |   35,122 / 25.61 |   85,310 / 47.21 |       1.84x | PASS   | PASS   | PASS    |
| `agent_review_unit_costs`                     |   67.6 / 88.5 |  90.8 / 111.6 |  150,811 / 35.54 |  220,872 / 53.35 |       1.50x | FAIL   | PASS   | FAIL    |
| `agent_session_cost_distribution`             |   52.8 / 54.1 | 123.9 / 135.5 |  129,443 / 36.09 |  218,558 / 54.00 |       1.50x | FAIL   | PASS   | FAIL    |
| `agent_session_identity` raw                  |   28.5 / 30.8 |   26.1 / 28.2 |   85,310 / 32.53 |   85,310 / 32.53 |       1.00x | PASS   | PASS   | PASS    |
| `agent_session_signals_top_runaway` signal    |   50.9 / 52.8 | 163.3 / 185.4 | 258,886 / 204.50 | 437,116 / 152.67 |       0.75x | FAIL   | PASS   | FAIL    |
| `agent_sessions_browser`                      |   38.4 / 57.8 | 161.4 / 227.8 | 258,886 / 143.62 | 437,116 / 134.97 |       0.94x | FAIL   | PASS   | FAIL    |
| `agent_tool_period_delta` signal              |   24.0 / 24.8 |   34.3 / 40.2 |  421,937 / 67.15 |   91,826 / 30.22 |       0.45x | PASS   | PASS   | PASS    |
| `agent_usage_breakdown`                       |   16.8 / 18.0 |   48.2 / 53.9 |  147,600 / 48.29 |   85,310 / 30.38 |       0.63x | PASS   | PASS   | PASS    |
| `agent_usage_summary`                         |   23.0 / 24.0 |   52.3 / 59.2 |  147,600 / 37.05 |   85,310 / 30.38 |       0.82x | PASS   | PASS   | PASS    |
| `agent_usage_timeseries`                      |   43.2 / 44.9 |   90.7 / 96.3 | 569,537 / 130.88 |  177,136 / 60.60 |       0.46x | PASS   | PASS   | PASS    |

## Retention-clipped two-stage decision input

Stage 1 scans the relevant message/tool/file/PR contributors from the retained
window start through the current published day. It chooses sessions whose maximum live activity
falls before `end`, with distribution also admitting its prior period. The
probe includes timestamps at and after `end` on that day and has no
`EventAt < now()` predicate, matching current published views. Runaway
discovery groups by repo and session, as its current read model does.
File attention instead discovers repo/session/path keys with the Copy's structured
file and error-hint contributors. It preserves those candidate paths after stage 2,
so later activity on another path does not affect selection.

Stage 2 aggregates only those sessions' facts over `[now() - retention_days, end)`
using `OrgId`, `toDate(EventAt)` and `session_pk` in the sorting-key prefix.
Review-unit attribution decisions use the same plan-clipped range and candidate
session membership. No deployed query changes. These queries repeat candidate
subqueries across contributors; measured scan costs include that work.

| Set window/retention | Endpoint                               |  Two-stage ms | DB median ms |          Rows / MB | Bytes ratio | Parity | Budget | Overall |
| -------------------- | -------------------------------------- | ------------: | -----------: | -----------------: | ----------: | ------ | ------ | ------- |
| 7/7                  | `agent_file_attention_top_directories` | 248.7 / 272.1 |        242.1 |   237,822 / 136.98 |       0.70x | FAIL   | PASS   | FAIL    |
| 7/7                  | `agent_file_attention_top_files`       | 251.6 / 275.3 |        244.8 |   237,822 / 136.98 |       0.65x | FAIL   | PASS   | FAIL    |
| 7/7                  | `agent_review_unit_costs`              | 119.4 / 137.8 |        112.7 |   448,131 / 106.06 |       2.98x | FAIL   | PASS   | FAIL    |
| 7/7                  | `agent_session_cost_distribution`      | 195.7 / 255.5 |        189.0 |    319,675 / 76.11 |       2.11x | FAIL   | PASS   | FAIL    |
| 7/7                  | `agent_session_signals_top_runaway`    | 257.6 / 277.3 |        249.6 |   639,350 / 211.61 |       1.03x | FAIL   | PASS   | FAIL    |
| 7/7                  | `agent_sessions_browser`               | 177.3 / 205.6 |        170.4 |   639,350 / 160.30 |       1.12x | FAIL   | PASS   | FAIL    |
| 7/30                 | `agent_file_attention_top_directories` | 279.9 / 313.4 |        272.6 |   330,275 / 190.73 |       0.97x | FAIL   | PASS   | FAIL    |
| 7/30                 | `agent_file_attention_top_files`       | 276.6 / 293.3 |        267.2 |   330,275 / 190.73 |       0.90x | FAIL   | PASS   | FAIL    |
| 7/30                 | `agent_review_unit_costs`              | 170.4 / 193.8 |        163.6 |   604,530 / 143.87 |       4.05x | FAIL   | FAIL   | FAIL    |
| 7/30                 | `agent_session_cost_distribution`      | 283.4 / 298.9 |        276.6 |   770,822 / 184.45 |       5.11x | FAIL   | FAIL   | FAIL    |
| 7/30                 | `agent_session_signals_top_runaway`    | 294.7 / 302.1 |        286.7 |   793,989 / 269.05 |       1.32x | FAIL   | PASS   | FAIL    |
| 7/30                 | `agent_sessions_browser`               | 292.7 / 343.6 |        284.4 |   948,628 / 255.65 |       1.78x | FAIL   | PASS   | FAIL    |
| 30/30                | `agent_file_attention_top_directories` | 409.5 / 469.6 |        402.7 |   792,540 / 459.40 |       2.34x | FAIL   | PASS   | FAIL    |
| 30/30                | `agent_file_attention_top_files`       | 431.9 / 532.0 |        425.1 |   792,540 / 459.40 |       2.17x | FAIL   | PASS   | FAIL    |
| 30/30                | `agent_review_unit_costs`              | 319.9 / 380.8 |        312.9 | 1,532,220 / 362.49 |      10.20x | FAIL   | FAIL   | FAIL    |
| 30/30                | `agent_session_cost_distribution`      | 342.6 / 367.5 |        335.3 | 1,092,790 / 260.09 |       7.21x | FAIL   | FAIL   | FAIL    |
| 30/30                | `agent_session_signals_top_runaway`    | 537.7 / 573.3 |        529.7 | 2,185,580 / 722.46 |       3.53x | FAIL   | FAIL   | FAIL    |
| 30/30                | `agent_sessions_browser`               | 468.9 / 539.9 |        460.9 | 2,185,580 / 547.16 |       3.81x | FAIL   | FAIL   | FAIL    |

All eighteen two-stage measurements pass latency, but six fail the bytes budget.
All eighteen fail exact current-output parity. Both file-attention two-stage
variants pass the bytes budget in every set; they still lose older path history.
Clipping history at plan retention
changes totals, durations, token/coverage distributions and runaway scores for
sessions with older contributions. It also removes old attribution decisions.

In every set, session zero shows **20 messages / 1,216 USD** today, versus
**10 messages / 576 USD** on both bounded paths. Its retained duration also shrinks.
At 7/30, two-stage recovers prior-session contributions inside the plan range that
the simple direct scan omitted. Distribution's prior cost is **414.813370 USD** on
current and two-stage, versus **408.655168 USD** on simple direct. Current-period
cost remains **1,611.918845 USD** on current versus **971.918845 USD** on two-stage;
the 640 USD difference is session zero's history beyond plan retention.
At 7/7 and 30/30, additional sessions crossing the plan boundary lose older facts.
File fixtures repeat `src/benchmark-retention-crossing.ts` within repo-zero
sessions 0, 1280 and 1920. Session zero touches it at 46, 31, 8, 6 and 0 days old;
the other sessions cross the 30-day and 7-day starts. Counts and first-touch time
therefore expose history loss even when the last touch is in the selected window.
At 7/30, the repeated file path has 19 touches on current and 15 on two-stage;
its first touch moves from August 25 to October 2. Canonical-path boundary
counts exclude deleted facts and corrections that move to `.corrected` paths.
The artifact preserves examples on all paths, including exact aggregate outputs.

Only older-than-plan fact/attribution history is intended to differ for the
retention-clipped option under these fixture conditions. The window-start loss
inside a longer plan is recovered, and late activity is probed rather than hidden
by clipping. This is fixture and source evidence, not exhaustive semantic proof
for every future-dated input, optional filter or sort.

### What current session views show beyond plan retention

Today's session browser, session cost distribution and review-unit costs merge
all published session-summary days before applying the plan clamp to
`LastEventAt`. `agent_session_summaries_published` selects manifest days back to
the calendar-year bound; it applies no plan-level history filter. Session snapshot
TTL is one year plus a day. Runaway scores likewise merge the selected session's
published history before their final last-event filter. Consequently a recently
active session on a 7-day plan can show messages, costs, tokens and duration from
46-day-old activity, and potentially throughout the retained calendar year.
Review-unit costs also selects the latest valid attribution without a plan/time
predicate today. A wholly inactive old session is excluded by last activity;
older contributions to a currently visible session remain visible.

File attention top files and top directories likewise merge all published days per
repo/session/path before applying the plan and selected-window clamp to
`LastTouchedAt`. Their touch/read/edit/write/missing-file counts and first-touch
timestamps include older history. Directory grouping happens after that path-level
filter, so both need the same lifetime fallback.

## Production context

Read-only production measurements supplied by the orchestrator on 2026-10-10
found one organization with agent data and 260,282 message facts in the last
30 days. Of 3,872 sessions active in 30 days, three have history older than
30 days. Within that active-session population, 3,102 of 272,600 messages
are older than 30 days, or 1.1%. Of 660 sessions active in 7 days, 12 have
history older than 7 days. Within that population, 4,897 of 33,631 messages
are older than 7 days, or 14.6%. These contextual totals use their respective
active-session populations;
they do not change the 1M synthetic benchmark, budgets or validation limits.
No production reads were performed by this implementation worker.

## Recommendation and limits

Provisional first slices are event-window usage summary/breakdown/timeseries,
priced coverage, repo directory, context health, failure leaderboard, tool period
delta and notable changes. The latter four are the passing ADR 0019 signals. Their
corrected direct shapes preserve the measured outputs for all three production
parameter sets. The three raw controls have no snapshot dependency to retire.
Isaac must accept a replacement decision before changing ADR 0019's runtime
query guardrail. Full 2M scale, small-org ratios, cloud latency and concurrency
must be validated before relying on these timings.

Keep a lifetime-state fallback for browser, distribution, runaway, review-unit
costs, file attention top files and file attention top directories if lifetime semantics are required. A scheduled replace-mode Copy over only
a plan window would still change lifetime results. If Isaac chooses plan-clipped
session totals instead, the two-stage variant provides a starting query shape,
but it fails the bytes budget at 30/30 for four of the six endpoints. Review costs and
distribution also fail at 7/30. Retiring the entire snapshot layer is unsupported.

Tinybird Local differs from cloud hardware, caches, scheduling and API latency.
Warm serial reads do not establish cloud p95 or multi-tenant concurrency. Only
one complete published generation per org is measured, after all Copies finish.
Repairs, publication races, noisy neighbors, ingest throughput, cold reads and
optional sorting/filter combinations are unvalidated.

Round 1's two-million load exceeded the per-query memory limit before batching,
then returned `ATTEMPT_TO_READ_AFTER_EOF` in 6/8 GiB containers. There is no
conclusive OOM evidence. This round stayed at 1M and 8 GiB. Diagnostic attempts
with invalid DateTime64 subtraction or future date moves were discarded; local
QA also corrected the omitted PR contributor. The final run uses the corrected
fixture/query hashes and completed all endpoint measurements. An initial round 3
run overlapped full CI, which exited with SIGKILL/137 under
the 12 GiB project memory limit. That timing run was discarded; full CI then
passed after Local cleanup. The final run starts after checks and hooks finish,
with no concurrent heavy work from this worker. Its owned container
and network were removed; worktree and branch remain available for review fixes.
