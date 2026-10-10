# Agent snapshot retirement benchmark

Status: measured proposal, not an accepted decision.

This is the [TRA-409](https://linear.app/zaks-io/issue/TRA-409) experiment for
TRA-404. Isaac's proposed 30-day budget requires a direct path median of at most
1,000 ms, p95 of at most 2,000 ms, bytes read at most three times the current path,
and exact output parity. A passing measurement is evidence for a retirement
candidate; it does not change ADR 0019 or authorize a deployment.

The largest completed fixture in this sandbox used **one million base message
rows**, half the requested scale, with matching fact ratios. The two-million
fixture failed during loading. The tables below therefore describe the measured
one-million fixture and cannot establish the two-million budget. Keep the
snapshot layer until the proposed slices receive the missing scale and cloud
validation.

## Reproduce the experiment

Run from an isolated worktree with `SBX_AGENT_ID` set:

```sh
bun install --frozen-lockfile
bash scripts/bench/run-agent-snapshot-benchmark.sh \
  --messages 1000000 --runs 10 --output /tmp/agent-snapshot-benchmark.json
python3 -m unittest discover -s scripts/bench -p 'test_*.py'
```

Omit `--messages` to attempt the requested two-million fixture. Read
[the runner guide](../../scripts/bench/README.md) first. The runner checks
`free -h`, requires 8 GiB available, prints `uptime` and `sbx-ps`, and creates an
owned Tinybird Local container with an 8 GiB limit. It binds ports 17181 and
17182 to loopback, verifies the bindings and client destination, and fails on a
port collision. It removes only its own Compose resources, including after
SIGTERM or Ctrl-C. Generated facts and database storage stay in a temporary
directory. This experiment starts no Workers and reads no cloud or customer data.

The runner builds the repository's datasources, pipes and Copy pipes in a private
local workspace. It excludes ingestion-only materializations that do not feed
the published read path. It seeds the six versioned fact categories directly
with batched `INSERT SELECT numbers()` statements. It then runs all nine existing
snapshot Copy pipes, serially for each of four organizations, over every fixture
day. It awaits all Copy jobs before synchronously appending that organization's
manifest. Both measured paths therefore read the same facts. The current path
has one complete published generation per organization.

## Fixture and measurement method

The fixture covers the calendar retention year ending at the measurement day's
UTC midnight. It has four organizations with a 70/10/10/10 distribution, 50,000
sessions, 128 repositories, three sources and four models. The measured org is
the 70% organization. Five percent of each category receives corrections,
including one percent date moves with old-key tombstones. One percent receives
deletions. Separate inserts let `FINAL` resolve versions without a forced merge.
All actual canonical live counts must match the generator's expected counts.

One session has ten messages 45 days older than its recent messages. Its recent
events occur at the end of the last fixture day and its priced messages cost
64 USD each, so pagination cannot hide it in the browser or review-cost result.
Its latest attribution decision predates both windows. These are deliberate
tests of current lifetime-session and attribution semantics. Other costs use
binary fractions, so exact sums do not need a float tolerance.

| Fact category                             | Base rows | Inserted versions | Live after FINAL |
| ----------------------------------------- | --------: | ----------------: | ---------------: |
| `agent_message_fact_versions`             | 1,000,000 |         1,070,000 |          990,000 |
| `agent_tool_event_fact_versions`          | 1,000,000 |         1,070,000 |          990,000 |
| `agent_file_event_fact_versions`          |   500,000 |           535,000 |          495,000 |
| `agent_pull_request_fact_versions`        |    10,000 |            10,700 |            9,900 |
| `agent_capability_snapshot_fact_versions` |    10,000 |            10,700 |            9,900 |
| `agent_review_unit_attribution_versions`  |    10,000 |            10,700 |            9,900 |

For every endpoint, the runner alternates current/direct request order, discards
one warmup per path, then records ten samples per path at both 7 and 30 days.
The latency columns measure client wall time, including HTTP and JSON parsing.
Query statistics provide database elapsed time, rows read and bytes read.
Scan columns show the largest observed value across measured samples. p95 uses
nearest rank, so ten samples use the slowest request.

Parity compares exact JSON values and row order across all twenty measured
responses. Only `agent_priced_usage`, a generic relation with no ordering
contract, compares an exact row multiset; duplicates still count. The benchmark
exposes that relation as a local endpoint solely to collect comparable statistics.
Endpoint errors fail the run. A parity or budget failure is a valid experiment
result and appears as FAIL in the table.

The parameter sets use `org_id=benchmark-org`, explicit UTC-midnight start/end
times, and `retention_days` equal to 7 or 30. The runner supplies repository zero as
`repo_fingerprint` to the ADR 0019 signals. File attention, failure leaderboard,
runaway signals and tool period delta apply that filter. Context health and
notable changes accept `repos` instead, so they ignore this parameter and their
measured results are org-wide. Identity uses session zero. Other optional filters, sort modes,
offsets and limits use endpoint defaults. Retention also applies the endpoint's
rolling `now()` cutoff, so the effective lower bound is slightly later than UTC
midnight. The runner rejects a run that crosses UTC midnight.

## Endpoint results

The inventory is the union of the web allowlist, MCP allowlist and MCP analytics
contract, plus priced usage, priced coverage and the ADR 0019 signals. There are
18 endpoints. `S` marks an ADR 0019 signal. `R` marks a current path that already
reads canonical `FINAL` facts: cost by depth, session identity and priced usage.
`H` marks review-unit costs, which combines published session states with raw
attribution versions. All other current paths read published snapshot relations.

Each row includes both paths. Latencies are milliseconds, bytes are MiB, and
the ratio is direct/current bytes. The 7-day verdict applies the same thresholds
for comparison; the issue's proposed decision budget applies at 30 days.
The [measurement artifact](../../scripts/bench/measurements/2026-10-10.json)
retains exact counts, unrounded statistics, all samples and output hashes, with
fixture rows and mismatch examples omitted.

### 7-day window

| Endpoint                                 | Current median / p95 | Current rows | Current MiB | Direct median / p95 | Direct rows | Direct MiB | Bytes ratio | Parity | Budget |
| ---------------------------------------- | -------------------: | -----------: | ----------: | ------------------: | ----------: | ---------: | ----------: | ------ | ------ |
| `agent_context_health` S                 |          49.5 / 91.4 |       16,702 |       4.697 |         59.3 / 73.4 |      23,918 |      8.148 |       1.73x | PASS   | PASS   |
| `agent_cost_by_depth` R                  |          31.8 / 58.5 |       71,754 |      17.454 |         31.6 / 33.6 |      71,754 |     17.454 |       1.00x | PASS   | PASS   |
| `agent_failure_leaderboard` S            |          17.0 / 36.6 |      421,972 |      76.923 |         17.2 / 20.1 |      26,402 |      8.294 |       0.11x | PASS   | PASS   |
| `agent_file_attention_top_directories` S |          30.1 / 46.1 |      373,465 |     187.008 |         33.5 / 35.2 |      39,502 |     21.717 |       0.12x | PASS   | PASS   |
| `agent_file_attention_top_files` S       |          34.5 / 47.1 |      373,465 |     201.967 |         36.2 / 44.9 |      39,502 |     21.717 |       0.11x | PASS   | PASS   |
| `agent_notable_changes` S                |          27.3 / 42.0 |      145,903 |      26.598 |         27.4 / 49.2 |      23,918 |      7.942 |       0.30x | PASS   | PASS   |
| `agent_priced_coverage`                  |          10.7 / 24.3 |      147,623 |      11.686 |         14.8 / 16.0 |      23,918 |      7.669 |       0.66x | PASS   | PASS   |
| `agent_priced_usage` R                   |        116.3 / 128.8 |       74,238 |      39.448 |       116.2 / 123.6 |      74,238 |     39.448 |       1.00x | PASS   | PASS   |
| `agent_repo_directory`                   |          12.0 / 13.0 |       35,124 |      24.424 |         16.3 / 17.0 |      23,918 |     12.624 |       0.52x | PASS   | PASS   |
| `agent_review_unit_costs` H              |          64.3 / 77.6 |      150,834 |      33.905 |         31.1 / 33.7 |      64,294 |     14.795 |       0.44x | FAIL   | FAIL   |
| `agent_session_cost_distribution`        |          49.3 / 72.6 |      129,434 |      34.412 |         65.6 / 66.0 |      63,712 |     14.996 |       0.44x | FAIL   | FAIL   |
| `agent_session_identity` R               |          13.8 / 26.2 |       23,918 |       8.701 |         13.7 / 15.1 |      23,918 |      8.701 |       1.00x | PASS   | PASS   |
| `agent_session_signals_top_runaway` S    |          46.9 / 53.7 |      258,868 |     195.012 |        93.1 / 106.1 |     127,424 |     42.630 |       0.22x | FAIL   | FAIL   |
| `agent_sessions_browser`                 |          34.4 / 37.5 |      258,868 |     136.962 |         50.7 / 56.5 |     127,424 |     37.678 |       0.28x | FAIL   | FAIL   |
| `agent_tool_period_delta` S              |          21.3 / 34.9 |      421,972 |      64.045 |         21.3 / 22.3 |      26,402 |      8.294 |       0.13x | PASS   | PASS   |
| `agent_usage_breakdown`                  |          14.8 / 30.4 |      147,623 |      46.058 |         18.1 / 18.7 |      23,918 |      8.125 |       0.18x | PASS   | PASS   |
| `agent_usage_summary`                    |          22.2 / 40.5 |      147,623 |      35.337 |         26.7 / 27.5 |      23,918 |      8.125 |       0.23x | PASS   | PASS   |
| `agent_usage_timeseries`                 |          40.1 / 55.9 |      569,595 |     124.829 |         41.5 / 42.7 |      50,320 |     16.419 |       0.13x | PASS   | PASS   |

### 30-day window

| Endpoint                                 | Current median / p95 | Current rows | Current MiB | Direct median / p95 | Direct rows | Direct MiB | Bytes ratio | Parity | Budget |
| ---------------------------------------- | -------------------: | -----------: | ----------: | ------------------: | ----------: | ---------: | ----------: | ------ | ------ |
| `agent_context_health` S                 |          63.1 / 64.7 |       55,950 |      15.736 |       118.7 / 128.4 |      85,223 |     29.024 |       1.84x | PASS   | PASS   |
| `agent_cost_by_depth` R                  |          57.7 / 64.8 |      255,669 |      62.163 |         60.7 / 66.7 |     255,669 |     62.163 |       1.00x | PASS   | PASS   |
| `agent_failure_leaderboard` S            |          16.8 / 18.3 |      421,972 |      76.923 |         22.3 / 28.9 |      91,738 |     28.797 |       0.37x | PASS   | PASS   |
| `agent_file_attention_top_directories` S |          29.5 / 31.2 |      373,465 |     187.008 |         56.2 / 60.0 |     131,955 |     72.989 |       0.39x | PASS   | PASS   |
| `agent_file_attention_top_files` S       |          32.9 / 34.0 |      373,465 |     201.967 |         62.1 / 65.7 |     131,955 |     72.989 |       0.36x | PASS   | PASS   |
| `agent_notable_changes` S                |          18.1 / 19.8 |      145,903 |      26.598 |         37.7 / 42.3 |      85,223 |     28.292 |       1.06x | PASS   | PASS   |
| `agent_priced_coverage`                  |          12.7 / 16.8 |      147,623 |      11.686 |         37.6 / 44.5 |      85,223 |     27.317 |       2.34x | PASS   | PASS   |
| `agent_priced_usage` R                   |        477.6 / 500.4 |      262,184 |     139.058 |       485.5 / 508.9 |     262,184 |    139.058 |       1.00x | PASS   | PASS   |
| `agent_repo_directory`                   |          12.5 / 13.5 |       35,124 |      24.424 |         40.0 / 50.8 |      85,223 |     44.975 |       1.84x | PASS   | PASS   |
| `agent_review_unit_costs` H              |          62.5 / 74.8 |      150,834 |      33.905 |         83.8 / 94.1 |     220,689 |     50.847 |       1.50x | FAIL   | FAIL   |
| `agent_session_cost_distribution`        |          50.8 / 53.0 |      129,434 |      34.412 |       111.7 / 115.4 |     218,349 |     51.448 |       1.50x | FAIL   | FAIL   |
| `agent_session_identity` R               |          28.2 / 35.4 |       85,223 |      30.993 |         26.8 / 30.2 |      85,223 |     30.993 |       1.00x | PASS   | PASS   |
| `agent_session_signals_top_runaway` S    |          48.8 / 59.4 |      258,868 |     195.012 |       170.6 / 188.3 |     436,698 |    145.461 |       0.75x | FAIL   | FAIL   |
| `agent_sessions_browser`                 |          35.1 / 37.6 |      258,868 |     136.962 |       151.2 / 162.2 |     436,698 |    128.604 |       0.94x | FAIL   | FAIL   |
| `agent_tool_period_delta` S              |          23.3 / 25.0 |      421,972 |      64.045 |         32.2 / 34.9 |      91,738 |     28.797 |       0.45x | PASS   | PASS   |
| `agent_usage_breakdown`                  |          15.5 / 20.7 |      147,623 |      46.058 |         44.7 / 49.8 |      85,223 |     28.942 |       0.63x | PASS   | PASS   |
| `agent_usage_summary`                    |          22.4 / 25.5 |      147,623 |      35.337 |         52.8 / 60.7 |      85,223 |     28.942 |       0.82x | PASS   | PASS   |
| `agent_usage_timeseries`                 |          41.4 / 43.1 |      569,595 |     124.829 |         87.5 / 90.8 |     176,961 |     57.739 |       0.46x | PASS   | PASS   |

## Passing query shapes and proposed retirement slices

The direct variants reuse the existing Copy aggregation SQL and the current
endpoint SQL. They replace each published relation with an in-query aggregate
over canonical `FINAL` facts, constrained by `OrgId` and the requested dates.
Existing raw reads receive explicit bounds too. The variants live in
`scripts/bench/pipes/`, outside the deployment includes. No deployed pipe,
snapshot implementation, consumer or ADR changes in this PR.

Org/date filters use replacement-key columns. Mutable content predicates such
as role, status and `IsDeleted=0` stay after `FINAL`. Date moves preserve an
old-key tombstone and a new-key live version. The experiment preserves the
subagent fallback anti-join and the same aggregate-state combinators as the
Copy path. It does not test skipping `FINAL`, adding mutable `PREWHERE` filters,
or changing sorting keys.

At 30 days, 14 endpoints pass all proposed thresholds. Every endpoint passes
the latency and bytes thresholds at this measured scale. The slowest direct
endpoint is the already-raw priced-usage diagnostic, with a 485.5 ms median and
508.9 ms p95 including a 59,645-row JSON response. The largest bytes ratio is
priced coverage at 2.34x. Four endpoints fail exact parity. The same four fail
at seven days.

1. **Event-window summaries can move first, provisionally.** Usage summary,
   breakdown, timeseries, priced coverage and repo directory preserve the tested
   results. Their direct shapes merge the same daily/hourly aggregate states over
   the bounded facts. Validate full scale and small-org scan ratios before a
   retirement implementation; granule overhead can change the ratio at low scale.
2. **Six ADR 0019 signals are provisional candidates.** Context health, failure
   leaderboard, file-attention files/directories, tool period delta and notable
   changes pass for the documented retention shape. File attention, failure
   leaderboard and tool period delta use the repository filter; context health
   and notable changes are org-wide comparisons. Their bounded derived aggregation
   can run inside the query at this scale. The current
   ADR still prohibits query-time `FINAL` for public signals. Isaac must accept a
   replacement decision before an implementation changes that guardrail.
3. **Keep a fallback for lifetime session views.** Session browser, session cost
   distribution and runaway signals lose older contributions when a session
   crosses the window boundary. The browser's first session has 20 messages and
   1,216 USD on the current path, versus 10 messages and 576 USD on the direct
   path, at both windows. A bounded fact query cannot preserve lifetime totals
   simply by copying today's aggregation. Keep published session states or a
   separately designed per-session state. A scheduled replace-mode Copy over only
   the requested event window would preserve window totals, not today's lifetime
   contract, so it needs an explicit semantic decision too.
4. **Keep review-unit costs on its current path.** Its latest valid attribution
   can predate the session activity window. The fixture's first review unit costs
   1,216 USD on the current path and disappears from the bounded-attribution
   result. A retirement slice needs org-scoped latest attribution state independent
   of activity dates, plus session totals that preserve the chosen history
   contract. Do not infer permission to read unbounded history from this report.
5. **The three raw endpoints have no snapshot dependency to retire here.** Cost
   by depth, session identity and priced usage already use canonical `FINAL`.
   Their 1.00x scan ratios and exact parity are controls for the tested parameter
   sets. They do not demonstrate a snapshot speedup or prove every possible
   anti-join/history shape.

The recommendation is partial retirement after the missing validation, retaining
the session-state fallback. Retiring the entire snapshot layer while preserving
all current outputs is unsupported by this experiment.

## Limits and risks

Tinybird Local and cloud differ in hardware, caches, query scheduling, API
latency, compression and background merge behavior. These warm, serial local
queries establish neither cloud p95 nor a concurrency budget. Four orgs exercise
org-key pruning; only the largest org is measured. The experiment does not issue
concurrent reads or test a noisy neighbor. Run a synthetic cloud comparison and
an agreed concurrency test before an implementation slice relies on these timings.

Only one published generation exists per org, and measurement starts after all
Copies finish. The experiment excludes active repairs, overlapping generations,
publication races, ingestion transport and scheduler delay. It does not measure
the full ingest pipeline or snapshot recovery correctness.

Only the documented parameter sets are measured. In particular, period delta
and notable changes use a retention limit equal to the requested window, so the
previous comparison period is outside retention. A 7-day request on a 30-day
plan can include that prior period and needs a separate shape test. Default
pagination and ranking do not prove every optional filter or sort mode.

The two-million setup first exceeded ClickHouse's roughly 1.86 GiB per-query
limit in a single insert. After batching at 100,000 rows, attempts with 6 GiB
and 8 GiB owned containers returned `ATTEMPT_TO_READ_AFTER_EOF` while loading
facts. The 8 GiB attempt loaded all two million base messages and failed around
1.3 million base tools. There is no definitive before/after OOM evidence, so
this report does not assign an exact cause. The largest completed scale was one
million messages; resource escalation stopped there. No numbers are extrapolated
to the missing full scale. The one-million fixture was rerun after strengthening
the visible boundary-session case.

The recorded run used Tinybird CLI 4.6.22, revision `5269fe22`, ClickHouse
25.8.34.2 and Docker Compose 5.6.0. The local image ID was
`sha256:99d28663eed712779fe60338d7730b9fee9bff92f84c5e44903784b61002602a`.
The pre-start check showed 20 GiB available memory and load averages
1.19 / 1.19 / 1.04. The 36 Copy jobs took 32.2 seconds in total, excluding
manifest publication and setup. Ten measured samples per path per window give
720 measured endpoint requests. All 36 comparisons completed without endpoint
errors, and the owned container and network were removed afterward.

The measured proposal does not close the full-scale or cloud validation gap.
The next retirement slices should use this endpoint classification and validate
the same semantics before deleting a published relation.
