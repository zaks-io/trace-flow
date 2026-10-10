# Agent snapshot retirement benchmark

Status: measured proposal. Isaac has not accepted a snapshot retirement decision.

The corrected 1M benchmark covers all 18 endpoints at 7/7, production-default
7/30, and 30/30 window/plan-retention sets. **14 endpoints pass exact parity and
all proposed thresholds in every set.** The four lifetime-session endpoints fail
parity in every set. Every simple direct variant passes the latency and bytes
budget. The additional retention-clipped two-stage queries remain fast, but their
bytes exceed the budget for two endpoints at 7/30 and all four at 30/30.

The largest safely completed scale remains **one million messages**. **2M, cloud
latency and concurrency are unvalidated.** The round 1 two-million load failed;
this round did not retry 2M or increase the 8 GiB container limit. Keep the
snapshot layer until the missing validation and session-history decision are made.

This report implements [TRA-409](https://linear.app/zaks-io/issue/TRA-409) and
responds to [PR #614's independent review](https://github.com/zaks-io/trace-flow/pull/614#issuecomment-6092669878).
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
| `agent_file_event_fact_versions`          |            43 |                 15 |            0 |
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
ten samples, and all 54 comparisons plus 12 two-stage comparisons completed without
endpoint errors. Hash parity is exact and ordered. The unordered priced-usage
generic relation compares its exact row multiset, preserving duplicates.

The [runner-emitted artifact](../../scripts/bench/measurements/2026-10-10.json)
retains samples, hashes, synthetic examples, Copy timings, boundary/parts evidence,
source and generated-query hashes, CLI/Python/ClickHouse/image versions and limits.
The source commit is the pre-fix head with `source_dirty: true`; per-file hashes
identify the measured working tree and match the committed scripts. Provenance
was emitted by the runner and the artifact was copied without editing its content.

The selected end was `2026-10-10T02:34:00+00:00`, snapped to the minute as the dashboard sends.
Measurement started at `2026-10-10T02:35:19.754871+00:00`. The run used tb, version 4.6.22 (rev 5269fe22),
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
`greatest(start, now() - retention_days)`. Current endpoint retention predicates
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
| `agent_context_health` signal                 |   45.1 / 84.6 |   54.8 / 57.1 |    16,777 / 4.95 |   24,004 / 8.57 |       1.73x | PASS   | PASS   | PASS    |
| `agent_cost_by_depth` raw                     |   29.7 / 57.3 |   30.4 / 32.4 |   72,012 / 18.37 |  72,012 / 18.37 |       1.00x | PASS   | PASS   | PASS    |
| `agent_failure_leaderboard` signal            |   16.0 / 30.8 |   15.9 / 18.4 |  421,964 / 80.66 |   26,490 / 8.73 |       0.11x | PASS   | PASS   | PASS    |
| `agent_file_attention_top_directories` signal |   29.3 / 45.8 |   33.2 / 34.8 | 373,465 / 196.09 |  39,636 / 22.85 |       0.12x | PASS   | PASS   | PASS    |
| `agent_file_attention_top_files` signal       |   32.3 / 47.4 |   35.7 / 37.9 | 373,465 / 211.78 |  39,636 / 22.85 |       0.11x | PASS   | PASS   | PASS    |
| `agent_notable_changes` signal                |   17.3 / 31.6 |   20.6 / 22.1 |  145,896 / 27.89 |   24,004 / 8.36 |       0.30x | PASS   | PASS   | PASS    |
| `agent_priced_coverage`                       |    9.9 / 23.4 |   14.5 / 17.3 |  147,618 / 12.25 |   24,004 / 8.07 |       0.66x | PASS   | PASS   | PASS    |
| `agent_priced_usage` raw                      | 118.6 / 122.2 | 117.3 / 123.1 |   74,498 / 41.51 |  74,498 / 41.51 |       1.00x | PASS   | PASS   | PASS    |
| `agent_repo_directory`                        |   11.6 / 14.3 |   16.5 / 19.0 |   35,122 / 25.61 |  24,004 / 13.28 |       0.52x | PASS   | PASS   | PASS    |
| `agent_review_unit_costs`                     |   64.2 / 78.9 |   31.8 / 37.5 |  150,840 / 35.55 |  64,520 / 15.57 |       0.44x | FAIL   | PASS   | FAIL    |
| `agent_session_cost_distribution`             |   49.0 / 49.9 |   65.2 / 68.0 |  129,440 / 36.09 |  63,934 / 15.78 |       0.44x | FAIL   | PASS   | FAIL    |
| `agent_session_identity` raw                  |   14.2 / 25.8 |   13.6 / 14.8 |    24,004 / 9.16 |   24,004 / 9.16 |       1.00x | PASS   | PASS   | PASS    |
| `agent_session_signals_top_runaway` signal    |   47.2 / 53.3 |   92.5 / 98.2 | 258,880 / 204.49 | 127,868 / 44.85 |       0.22x | FAIL   | PASS   | FAIL    |
| `agent_sessions_browser`                      |   33.6 / 36.6 |   51.3 / 76.4 | 258,880 / 143.62 | 127,868 / 39.64 |       0.28x | FAIL   | PASS   | FAIL    |
| `agent_tool_period_delta` signal              |   20.5 / 34.7 |   21.5 / 22.5 |  421,964 / 67.15 |   26,490 / 8.73 |       0.13x | PASS   | PASS   | PASS    |
| `agent_usage_breakdown`                       |   14.3 / 29.4 |   17.3 / 18.3 |  147,618 / 48.29 |   24,004 / 8.55 |       0.18x | PASS   | PASS   | PASS    |
| `agent_usage_summary`                         |   21.9 / 40.9 |   26.4 / 27.7 |  147,618 / 37.05 |   24,004 / 8.55 |       0.23x | PASS   | PASS   | PASS    |
| `agent_usage_timeseries`                      |   40.3 / 55.4 |   42.4 / 57.7 | 569,582 / 130.89 |  50,494 / 17.28 |       0.13x | PASS   | PASS   | PASS    |

### 7-day window, 30-day plan retention

| Endpoint                                      |          C ms |          D ms |      C rows / MB |      D rows / MB | Bytes ratio | Parity | Budget | Overall |
| --------------------------------------------- | ------------: | ------------: | ---------------: | ---------------: | ----------: | ------ | ------ | ------- |
| `agent_context_health` signal                 |   51.6 / 63.6 |   74.0 / 83.6 |    31,469 / 9.28 |   53,181 / 19.00 |       2.05x | PASS   | PASS   | PASS    |
| `agent_cost_by_depth` raw                     |   29.8 / 31.2 |   29.9 / 31.0 |   72,012 / 18.37 |   72,012 / 18.37 |       1.00x | PASS   | PASS   | PASS    |
| `agent_failure_leaderboard` signal            |   16.0 / 16.6 |   15.7 / 17.6 |  421,964 / 80.66 |    26,490 / 8.73 |       0.11x | PASS   | PASS   | PASS    |
| `agent_file_attention_top_directories` signal |   29.8 / 39.7 |   33.3 / 43.3 | 373,465 / 196.09 |   39,636 / 22.85 |       0.12x | PASS   | PASS   | PASS    |
| `agent_file_attention_top_files` signal       |   32.1 / 32.5 |   35.1 / 37.1 | 373,465 / 211.78 |   39,636 / 22.85 |       0.11x | PASS   | PASS   | PASS    |
| `agent_notable_changes` signal                |   17.6 / 18.6 |   39.8 / 41.2 |  145,896 / 27.89 |   85,310 / 29.70 |       1.06x | PASS   | PASS   | PASS    |
| `agent_priced_coverage`                       |    9.9 / 10.2 |   14.4 / 14.7 |  147,618 / 12.25 |    24,004 / 8.07 |       0.66x | PASS   | PASS   | PASS    |
| `agent_priced_usage` raw                      | 484.4 / 497.8 | 480.5 / 502.4 | 262,446 / 145.96 | 262,446 / 145.96 |       1.00x | PASS   | PASS   | PASS    |
| `agent_repo_directory`                        |   11.6 / 12.1 |   16.5 / 20.7 |   35,122 / 25.61 |   24,004 / 13.28 |       0.52x | PASS   | PASS   | PASS    |
| `agent_review_unit_costs`                     |   62.0 / 69.8 |   32.0 / 36.7 |  150,840 / 35.55 |   64,520 / 15.57 |       0.44x | FAIL   | PASS   | FAIL    |
| `agent_session_cost_distribution`             |   50.0 / 52.4 | 101.7 / 105.9 |  129,440 / 36.09 |  138,061 / 34.15 |       0.95x | FAIL   | PASS   | FAIL    |
| `agent_session_identity` raw                  |   12.8 / 14.4 |   13.5 / 25.3 |    24,004 / 9.16 |    24,004 / 9.16 |       1.00x | PASS   | PASS   | PASS    |
| `agent_session_signals_top_runaway` signal    |   48.0 / 50.8 |  95.8 / 102.3 | 258,880 / 204.49 |  127,868 / 44.85 |       0.22x | FAIL   | PASS   | FAIL    |
| `agent_sessions_browser`                      |   34.1 / 35.7 |   51.3 / 53.1 | 258,880 / 143.62 |  127,868 / 39.64 |       0.28x | FAIL   | PASS   | FAIL    |
| `agent_tool_period_delta` signal              |   21.0 / 22.6 |   27.0 / 29.4 |  421,964 / 67.15 |   51,635 / 17.00 |       0.25x | PASS   | PASS   | PASS    |
| `agent_usage_breakdown`                       |   14.6 / 20.5 |   18.3 / 21.3 |  147,618 / 48.29 |    24,004 / 8.55 |       0.18x | PASS   | PASS   | PASS    |
| `agent_usage_summary`                         |   22.1 / 25.5 |   36.1 / 37.1 |  147,618 / 37.05 |   53,181 / 18.95 |       0.51x | PASS   | PASS   | PASS    |
| `agent_usage_timeseries`                      |   39.3 / 45.5 |   41.8 / 47.3 | 569,582 / 130.89 |   50,494 / 17.28 |       0.13x | PASS   | PASS   | PASS    |

### 30-day window, 30-day plan retention

| Endpoint                                      |          C ms |          D ms |      C rows / MB |      D rows / MB | Bytes ratio | Parity | Budget | Overall |
| --------------------------------------------- | ------------: | ------------: | ---------------: | ---------------: | ----------: | ------ | ------ | ------- |
| `agent_context_health` signal                 |   63.7 / 78.3 | 118.5 / 129.1 |   56,045 / 16.53 |   85,310 / 30.46 |       1.84x | PASS   | PASS   | PASS    |
| `agent_cost_by_depth` raw                     |   58.5 / 60.8 |   59.3 / 62.1 |  255,930 / 65.25 |  255,930 / 65.25 |       1.00x | PASS   | PASS   | PASS    |
| `agent_failure_leaderboard` signal            |   17.6 / 19.7 |   24.9 / 28.3 |  421,964 / 80.66 |   91,826 / 30.22 |       0.37x | PASS   | PASS   | PASS    |
| `agent_file_attention_top_directories` signal |   29.6 / 31.7 |   58.2 / 62.5 | 373,465 / 196.09 |  132,089 / 76.61 |       0.39x | PASS   | PASS   | PASS    |
| `agent_file_attention_top_files` signal       |   32.4 / 40.2 |   58.7 / 85.7 | 373,465 / 211.78 |  132,089 / 76.61 |       0.36x | PASS   | PASS   | PASS    |
| `agent_notable_changes` signal                |   17.6 / 20.4 |   39.9 / 51.1 |  145,896 / 27.89 |   85,310 / 29.70 |       1.06x | PASS   | PASS   | PASS    |
| `agent_priced_coverage`                       |   10.5 / 10.9 |   31.7 / 36.1 |  147,618 / 12.25 |   85,310 / 28.67 |       2.34x | PASS   | PASS   | PASS    |
| `agent_priced_usage` raw                      | 489.6 / 509.3 | 477.8 / 514.2 | 262,446 / 145.96 | 262,446 / 145.96 |       1.00x | PASS   | PASS   | PASS    |
| `agent_repo_directory`                        |   12.0 / 21.4 |   42.6 / 50.2 |   35,122 / 25.61 |   85,310 / 47.21 |       1.84x | PASS   | PASS   | PASS    |
| `agent_review_unit_costs`                     |   64.1 / 79.2 |  87.5 / 101.8 |  150,840 / 35.55 |  220,903 / 53.37 |       1.50x | FAIL   | PASS   | FAIL    |
| `agent_session_cost_distribution`             |   51.5 / 53.3 | 112.3 / 115.2 |  129,440 / 36.09 |  218,557 / 54.00 |       1.50x | FAIL   | PASS   | FAIL    |
| `agent_session_identity` raw                  |   25.4 / 29.2 |   24.5 / 27.1 |   85,310 / 32.53 |   85,310 / 32.53 |       1.00x | PASS   | PASS   | PASS    |
| `agent_session_signals_top_runaway` signal    |   48.6 / 52.7 | 149.1 / 156.8 | 258,880 / 204.49 | 437,114 / 152.67 |       0.75x | FAIL   | PASS   | FAIL    |
| `agent_sessions_browser`                      |   34.6 / 35.7 | 144.9 / 161.5 | 258,880 / 143.62 | 437,114 / 134.98 |       0.94x | FAIL   | PASS   | FAIL    |
| `agent_tool_period_delta` signal              |   22.4 / 36.0 |   31.4 / 37.1 |  421,964 / 67.15 |   91,826 / 30.22 |       0.45x | PASS   | PASS   | PASS    |
| `agent_usage_breakdown`                       |   15.8 / 16.5 |   45.9 / 48.9 |  147,618 / 48.29 |   85,310 / 30.38 |       0.63x | PASS   | PASS   | PASS    |
| `agent_usage_summary`                         |   22.1 / 22.5 |   53.2 / 57.3 |  147,618 / 37.05 |   85,310 / 30.38 |       0.82x | PASS   | PASS   | PASS    |
| `agent_usage_timeseries`                      |   40.6 / 46.1 |   87.4 / 94.8 | 569,582 / 130.89 |  177,136 / 60.60 |       0.46x | PASS   | PASS   | PASS    |

## Retention-clipped two-stage decision input

Stage 1 scans the relevant message/tool/file/PR contributors from the retained
window start through `now()`. It chooses sessions whose maximum live activity
falls before `end`, with distribution also admitting its prior period. The
`[end, now)` probe preserves the current no-later-activity exclusion. Runaway
discovery groups by repo and session, as its current read model does.

Stage 2 aggregates only those sessions' facts over `[now() - retention_days, end)`
using `OrgId`, `toDate(EventAt)` and `session_pk` in the sorting-key prefix.
Review-unit attribution decisions use the same plan-clipped range and candidate
session membership. No deployed query changes. These queries repeat candidate
subqueries across contributors; measured scan costs include that work.

| Set window/retention | Endpoint                            |  Two-stage ms | DB median ms |          Rows / MB | Bytes ratio | Parity | Budget | Overall |
| -------------------- | ----------------------------------- | ------------: | -----------: | -----------------: | ----------: | ------ | ------ | ------- |
| 7/7                  | `agent_review_unit_costs`           | 109.6 / 126.5 |        102.9 |   448,124 / 106.06 |       2.98x | FAIL   | PASS   | FAIL    |
| 7/7                  | `agent_session_cost_distribution`   | 179.6 / 199.7 |        173.0 |    319,670 / 76.11 |       2.11x | FAIL   | PASS   | FAIL    |
| 7/7                  | `agent_session_signals_top_runaway` | 240.7 / 256.5 |        233.1 |   639,340 / 211.61 |       1.03x | FAIL   | PASS   | FAIL    |
| 7/7                  | `agent_sessions_browser`            | 182.2 / 191.7 |        175.3 |   639,340 / 160.30 |       1.12x | FAIL   | PASS   | FAIL    |
| 7/30                 | `agent_review_unit_costs`           | 163.9 / 198.3 |        157.3 |   604,523 / 143.87 |       4.05x | FAIL   | FAIL   | FAIL    |
| 7/30                 | `agent_session_cost_distribution`   | 267.1 / 286.6 |        260.4 |   770,817 / 184.45 |       5.11x | FAIL   | FAIL   | FAIL    |
| 7/30                 | `agent_session_signals_top_runaway` | 284.3 / 286.9 |        276.5 |   793,979 / 269.05 |       1.32x | FAIL   | PASS   | FAIL    |
| 7/30                 | `agent_sessions_browser`            | 260.1 / 274.2 |        252.8 |   948,618 / 255.65 |       1.78x | FAIL   | PASS   | FAIL    |
| 30/30                | `agent_review_unit_costs`           | 267.2 / 327.1 |        260.4 | 1,532,245 / 362.51 |      10.20x | FAIL   | FAIL   | FAIL    |
| 30/30                | `agent_session_cost_distribution`   | 295.7 / 300.6 |        289.1 | 1,092,785 / 260.09 |       7.21x | FAIL   | FAIL   | FAIL    |
| 30/30                | `agent_session_signals_top_runaway` | 483.5 / 524.0 |        475.6 | 2,185,570 / 722.46 |       3.53x | FAIL   | FAIL   | FAIL    |
| 30/30                | `agent_sessions_browser`            | 405.3 / 500.4 |        397.6 | 2,185,570 / 547.16 |       3.81x | FAIL   | FAIL   | FAIL    |

All twelve two-stage measurements pass latency, but six fail the bytes budget.
All twelve fail exact current-output parity. Clipping history at plan retention
changes totals, durations, token/coverage distributions and runaway scores for
sessions with older contributions. It also removes old attribution decisions.

In every set, session zero shows **20 messages / 1,216 USD** today, versus
**10 messages / 576 USD** on both bounded paths. Its retained duration also shrinks.
At 7/30, two-stage recovers prior-session contributions inside the plan range that
the simple direct scan omitted. Distribution's prior cost is **416.088764 USD** on
current and two-stage, versus **404.726459 USD** on simple direct. Current-period
cost remains **1,640.162001 USD** on current versus **1,000.162001 USD** on two-stage;
the 640 USD difference is session zero's history beyond plan retention.
At 7/7 and 30/30, additional sessions crossing the plan boundary lose older facts.
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
45-day-old activity, and potentially throughout the retained calendar year.
Review-unit costs also selects the latest valid attribution without a plan/time
predicate today. A wholly inactive old session is excluded by last activity;
older contributions to a currently visible session remain visible.

## Recommendation and limits

Provisional first slices are event-window usage summary/breakdown/timeseries,
priced coverage, repo directory, and the six passing ADR 0019 signals. Their
corrected direct shapes preserve the measured outputs for all three production
parameter sets. The three raw controls have no snapshot dependency to retire.
Isaac must accept a replacement decision before changing ADR 0019's runtime
query guardrail. Full 2M scale, small-org ratios, cloud latency and concurrency
must be validated before relying on these timings.

Keep a session-state fallback for browser, distribution, runaway and review-unit
costs if lifetime semantics are required. A scheduled replace-mode Copy over only
a plan window would still change lifetime results. If Isaac chooses plan-clipped
session totals instead, the two-stage variant provides a starting query shape,
but it fails the bytes budget at 30/30 for all four endpoints. Review costs and
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
fixture/query hashes and completed all endpoint measurements. Its owned container
and network were removed; worktree and branch remain available for review fixes.
